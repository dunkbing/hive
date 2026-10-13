import {
  AGENT_COLORS,
  DEFAULT_LEASE_TTL_MS,
  findBlockingLease,
  isActive,
  mergeFile,
  type AgentInfo,
  type AgentStatus,
  type CommitInfo,
  type HiveEvent,
  type HiveEventBody,
  type Intent,
  type Lease,
  type LeaseScope,
  type RepoState,
  type RepoStats,
  type RepoStatus,
} from "@hive/core";
import { DurableObject } from "cloudflare:workers";
import {
  cloneRepo,
  defaultBranch,
  initRepo,
  listFiles,
  push,
  readText,
  writeAndCommit,
  type Remote,
  type Workdir,
} from "./git.ts";
import type { Task } from "./scenario.ts";
import { SEED_FILES } from "./seed.ts";

const MAX_ATTEMPTS = 3;
const MAX_EVENTS = 300;
const MAX_COMMITS = 50;
/** Agents that may run at once in one repo. */
export const MAX_ACTIVE_AGENTS = 8;
const IMPORT_POLL_MS = 3_000;
const IMPORT_TIMEOUT_MS = 5 * 60_000;

export type RepoSource = { type: "empty"; title: string } | { type: "demo" } | { type: "import"; url: string };

export interface InitInput {
  id: string;
  description: string;
  source: RepoSource;
}

interface Persisted {
  id: string;
  template: RepoSource["type"];
  status: RepoStatus;
  statusError: string | null;
  description: string;
  remote: string;
  branch: string;
  head: string | null;
  importStartedAt?: number;
  leasesEnabled: boolean;
  agents: Record<string, AgentInfo>;
  leases: Record<string, Lease>;
  intents: Record<string, Intent>;
  commits: CommitInfo[];
  files: string[];
  stats: RepoStats;
  events: HiveEvent[];
  seq: number;
}

export interface JoinResult {
  forkName: string;
  branch: string;
  description: string;
  main: Remote;
  fork: Remote;
}

export type LeaseResult = { ok: true; lease: Lease | null } | { ok: false; holder: Lease; holderName: string };

export interface SubmitInput {
  intentId?: string;
  summary: string;
  commit: string;
  files: { path: string; base: string | null }[];
}

export type SubmitResult =
  | { status: "merged"; intentId: string; commit: string }
  | { status: "conflict"; intentId: string; conflicts: { path: string; main: string | null }[] }
  | { status: "rejected"; intentId: string; reason: string };

const emptyStats = (): RepoStats => ({ merges: 0, collisionsAvoided: 0, autoMerged: 0, replays: 0, rejected: 0 });

const HIVE_AUTHOR = { name: "hive", email: "hive@hive.dev" };

/**
 * One coordinator per repo. It owns the lease table and the merge queue,
 * and it is the only writer to the repo's default branch in Artifacts.
 */
export class RepoCoordinator extends DurableObject<Env> {
  private s: Persisted | null = null;
  private mainWd: Workdir | null = null;
  private mainToken: { token: string; expiresAt: number } | null = null;
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Persisted>("s")) ?? null;
    });
  }

  // ---- lifecycle ---------------------------------------------------------

  async init(input: InitInput): Promise<RepoState> {
    if (this.s) return this.state();
    const { id, description, source } = input;
    this.s = {
      id,
      template: source.type,
      status: "creating",
      statusError: null,
      description,
      remote: "",
      branch: "main",
      head: null,
      leasesEnabled: true,
      agents: {},
      leases: {},
      intents: {},
      commits: [],
      files: [],
      stats: emptyStats(),
      events: [],
      seq: 0,
    };

    if (source.type === "import") {
      const imported = await this.env.ARTIFACTS.import({
        source: { url: source.url, depth: 1 },
        target: { name: id, opts: { description } },
      });
      this.s.remote = imported.remote;
      this.s.status = "importing";
      this.s.importStartedAt = Date.now();
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + IMPORT_POLL_MS);
      return this.state();
    }

    const created = await this.env.ARTIFACTS.create(id, { description, setDefaultBranch: "main" });
    const files =
      source.type === "demo" ? SEED_FILES : { "README.md": `# ${source.title}\n\n${description}\n`.trimEnd() + "\n" };
    const wd = await initRepo("main");
    const sha = await writeAndCommit(
      wd,
      files,
      source.type === "demo" ? "Seed todo-api" : "Initial commit",
      HIVE_AUTHOR,
    );
    await push(wd, { url: created.remote, token: created.token });
    this.mainWd = wd;
    this.s.remote = created.remote;
    this.s.files = Object.keys(files).sort();
    await this.ready(sha, source.type === "demo" ? "Seed todo-api" : "Initial commit");
    return this.state();
  }

  private async ready(head: string, message: string) {
    const s = this.require();
    s.status = "ready";
    s.head = head;
    s.commits = [{ sha: head, message, author: "hive", at: Date.now() }];
    await this.emit({ type: "repo.ready", head });
  }

  /** Finishes an import once Artifacts has the repo: find the real default branch, clone, index files. */
  private async finishImport() {
    const s = this.require();
    try {
      const remote = await this.mainRemote();
      s.branch = await defaultBranch(remote);
      const wd = await cloneRepo(remote, s.branch);
      this.mainWd = wd;
      s.files = await listFiles(wd);
      using repo = await this.env.ARTIFACTS.get(s.id);
      const [head] = await repo.log({ ref: s.branch, limit: 1 });
      await this.ready(head.hash, head.message.split("\n")[0]);
    } catch (err) {
      const message = errorMessage(err);
      const pending = /IN_PROGRESS|not ready|NOT_FOUND/i.test(message);
      if (pending && Date.now() - (s.importStartedAt ?? 0) < IMPORT_TIMEOUT_MS) {
        await this.ctx.storage.setAlarm(Date.now() + IMPORT_POLL_MS);
        return;
      }
      s.status = "failed";
      s.statusError = message;
      await this.emit({ type: "repo.failed", error: message });
    }
  }

  /** Re-runs the post-import step (clone, branch detection, indexing) for an import that failed. */
  async retryImport(): Promise<RepoState> {
    const s = this.require();
    if (s.status !== "failed" || s.template !== "import") throw new Error("only failed imports can be retried");
    s.status = "importing";
    s.statusError = null;
    s.importStartedAt = Date.now();
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now());
    return this.state();
  }

  async getState(): Promise<RepoState> {
    return this.state();
  }

  async setLeasesEnabled(enabled: boolean): Promise<RepoState> {
    const s = this.require();
    s.leasesEnabled = enabled;
    if (!enabled) s.leases = {};
    await this.emit({ type: "repo.settings", leasesEnabled: enabled });
    return this.state();
  }

  async setDescription(description: string): Promise<void> {
    this.require().description = description;
    await this.persist();
  }

  /** Deletes the repo, every agent fork and this object's state. */
  async destroy(): Promise<void> {
    const s = this.s;
    if (s) {
      for (const agent of Object.values(s.agents)) {
        await this.env.ARTIFACTS.delete(agent.fork).catch(() => false);
      }
      await this.env.ARTIFACTS.delete(s.id).catch(() => false);
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "repo deleted");
    this.s = null;
    this.mainWd = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Spawns one agent per task. Each agent runs in its own Durable Object. */
  async launchAgents(tasks: Task[]): Promise<RepoState> {
    const s = this.require();
    if (s.status !== "ready") throw new Error(`repo is ${s.status}`);
    const active = Object.values(s.agents).filter((a) => a.status !== "done" && a.status !== "failed").length;
    if (active + tasks.length > MAX_ACTIVE_AGENTS) {
      throw new Error(`at most ${MAX_ACTIVE_AGENTS} agents can run at once (${active} running)`);
    }
    for (const task of tasks) {
      const index = Object.keys(s.agents).length + 1;
      const agentId = `a${index}`;
      const name = `${task.name}-${index}`;
      const join = await this.join(agentId, name, task.task);
      const stub = this.env.AGENT.get(this.env.AGENT.idFromName(`${s.id}/${agentId}`));
      await stub.start({ repo: s.id, agentId, name, task: task.task, ...join });
    }
    return this.state();
  }

  activeAgents(): number {
    return Object.values(this.require().agents).filter((a) => a.status !== "done" && a.status !== "failed").length;
  }

  // ---- agents -------------------------------------------------------------

  /** Registers an agent: forks the repo into the agent's own repo and mints scoped tokens. */
  private async join(agentId: string, name: string, task: string): Promise<JoinResult> {
    const s = this.require();
    const forkName = `${s.id}--${agentId}`;
    using repo = await this.env.ARTIFACTS.get(s.id);
    const forked = await repo.fork(forkName, { description: `Hive fork for ${name}`, defaultBranchOnly: true });
    const read = await repo.createToken("read", 6 * 3600);

    const agent: AgentInfo = {
      id: agentId,
      name,
      color: AGENT_COLORS[Object.keys(s.agents).length % AGENT_COLORS.length],
      task,
      status: "idle",
      detail: "joined",
      fork: forkName,
      joinedAt: Date.now(),
    };
    s.agents[agentId] = agent;
    await this.emit({ type: "agent.joined", agent });
    return {
      forkName,
      branch: s.branch,
      description: s.description,
      main: { url: s.remote, token: read.plaintext },
      fork: { url: forked.remote, token: forked.token },
    };
  }

  async agentStatus(agentId: string, status: AgentStatus, detail: string): Promise<void> {
    const agent = this.s?.agents[agentId];
    if (!agent) return;
    agent.status = status;
    agent.detail = detail;
    await this.emit({ type: "agent.status", agentId, status, detail });
  }

  async listMainFiles(): Promise<string[]> {
    return this.require().files;
  }

  async leasesEnabled(): Promise<boolean> {
    return this.require().leasesEnabled;
  }

  // ---- leases -------------------------------------------------------------

  /** `retry` marks a repeated request from an agent waiting in line, which is not counted as a new collision. */
  async requestLease(agentId: string, scope: LeaseScope, reason: string, retry = false): Promise<LeaseResult> {
    const s = this.require();
    if (!s.leasesEnabled) return { ok: true, lease: null };
    const now = Date.now();
    const leases = Object.values(s.leases);

    const holder = findBlockingLease(leases, scope, agentId, now);
    if (holder) {
      if (!retry) {
        s.stats.collisionsAvoided++;
        await this.emit({ type: "lease.denied", agentId, scope, holder });
      }
      return { ok: false, holder, holderName: s.agents[holder.agentId]?.name ?? holder.agentId };
    }

    const existing = leases.find(
      (l) =>
        l.agentId === agentId &&
        l.path === scope.path &&
        l.startLine === scope.startLine &&
        l.endLine === scope.endLine,
    );
    const lease: Lease = existing
      ? { ...existing, reason, expiresAt: now + DEFAULT_LEASE_TTL_MS }
      : { id: crypto.randomUUID(), agentId, ...scope, reason, grantedAt: now, expiresAt: now + DEFAULT_LEASE_TTL_MS };
    s.leases[lease.id] = lease;
    await this.emit({ type: "lease.granted", lease });
    await this.scheduleAlarm();
    return { ok: true, lease };
  }

  /** Extends every lease the agent holds. Agents call this as a heartbeat. */
  async renewLeases(agentId: string): Promise<void> {
    const s = this.require();
    const expiresAt = Date.now() + DEFAULT_LEASE_TTL_MS;
    for (const lease of Object.values(s.leases)) if (lease.agentId === agentId) lease.expiresAt = expiresAt;
    await this.persist();
    await this.scheduleAlarm();
  }

  async releaseLeases(agentId: string): Promise<void> {
    const s = this.s;
    if (!s) return;
    for (const lease of Object.values(s.leases)) {
      if (lease.agentId !== agentId) continue;
      delete s.leases[lease.id];
      await this.emit({ type: "lease.released", leaseId: lease.id, agentId, path: lease.path, reason: "done" });
    }
  }

  override async alarm(): Promise<void> {
    const s = this.s;
    if (!s) return;
    if (s.status === "importing") {
      await this.finishImport();
      return;
    }
    const now = Date.now();
    for (const lease of Object.values(s.leases)) {
      if (isActive(lease, now)) continue;
      delete s.leases[lease.id];
      await this.emit({
        type: "lease.released",
        leaseId: lease.id,
        agentId: lease.agentId,
        path: lease.path,
        reason: "expired",
      });
    }
    await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    const next = Math.min(...Object.values(this.require().leases).map((l) => l.expiresAt));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next + 50);
  }

  // ---- intents & merge queue ---------------------------------------------

  /** Queues an intent and resolves once the merge queue has processed it. */
  async submitIntent(agentId: string, input: SubmitInput): Promise<SubmitResult> {
    const s = this.require();
    let intent = input.intentId ? s.intents[input.intentId] : undefined;
    if (intent) {
      intent.commit = input.commit;
      intent.files = input.files.map((f) => f.path);
      intent.attempts++;
      intent.status = "queued";
    } else {
      intent = {
        id: crypto.randomUUID().slice(0, 8),
        agentId,
        summary: input.summary,
        commit: input.commit,
        files: input.files.map((f) => f.path),
        status: "queued",
        attempts: 1,
        createdAt: Date.now(),
      };
      s.intents[intent.id] = intent;
    }
    await this.emit({ type: "intent.queued", intent: { ...intent } });

    const result = this.mergeChain.then(() => this.merge(intent, input));
    this.mergeChain = result.catch(() => undefined);
    return result;
  }

  private async merge(intent: Intent, input: SubmitInput): Promise<SubmitResult> {
    const s = this.require();
    const agent = s.agents[intent.agentId];
    intent.status = "merging";
    await this.persist();

    const wd = await this.main();
    using fork = await this.env.ARTIFACTS.get(agent.fork);

    const merged: Record<string, string> = {};
    const conflicts: { path: string; main: string | null }[] = [];
    let autoMerged = false;
    for (const { path, base } of input.files) {
      const blob = await fork.readFile({ ref: input.commit, path });
      const theirs = blob ? await blob.text() : null;
      const ours = await readText(wd, path);
      const result = mergeFile(base, ours, theirs);
      if (!result.clean) {
        conflicts.push({ path, main: ours });
        continue;
      }
      if (result.mode === "auto-merge") autoMerged = true;
      if (result.text !== ours) merged[path] = result.text;
    }

    if (conflicts.length > 0) {
      intent.conflicts = conflicts.map((c) => c.path);
      await this.emit({
        type: "intent.conflict",
        intentId: intent.id,
        agentId: intent.agentId,
        files: intent.conflicts,
      });
      if (intent.attempts >= MAX_ATTEMPTS) {
        intent.status = "rejected";
        s.stats.rejected++;
        const reason = `still conflicting after ${intent.attempts} attempts`;
        await this.emit({ type: "intent.rejected", intentId: intent.id, agentId: intent.agentId, reason });
        await this.releaseLeases(intent.agentId);
        return { status: "rejected", intentId: intent.id, reason };
      }
      intent.status = "replaying";
      s.stats.replays++;
      await this.emit({
        type: "intent.replaying",
        intentId: intent.id,
        agentId: intent.agentId,
        attempt: intent.attempts + 1,
      });
      return { status: "conflict", intentId: intent.id, conflicts };
    }

    const message = `${intent.summary}\n\nHive-Intent: ${intent.id}\nHive-Agent: ${agent.name}`;
    const sha = await this.commitToMain(merged, message, agent);
    const commit: CommitInfo = { sha, message: intent.summary, author: agent.name, at: Date.now() };

    intent.status = "merged";
    intent.mergedAs = sha;
    intent.conflicts = undefined;
    s.head = sha;
    s.commits = [commit, ...s.commits].slice(0, MAX_COMMITS);
    s.files = [...new Set([...s.files, ...Object.keys(merged)])].sort();
    s.stats.merges++;
    if (autoMerged) s.stats.autoMerged++;
    await this.emit({
      type: "intent.merged",
      intentId: intent.id,
      agentId: intent.agentId,
      commit,
      mode: autoMerged ? "auto-merge" : "direct",
    });
    await this.releaseLeases(intent.agentId);
    return { status: "merged", intentId: intent.id, commit: sha };
  }

  private async commitToMain(files: Record<string, string>, message: string, agent: AgentInfo): Promise<string> {
    const author = { name: agent.name, email: `${agent.id}@agents.hive.dev` };
    try {
      const wd = await this.main();
      const sha = await writeAndCommit(wd, files, message, author);
      await push(wd, await this.mainRemote());
      return sha;
    } catch (err) {
      // The cached clone may be stale (e.g. after an eviction); start from a fresh clone once.
      console.warn("push to main failed, recloning", err);
      this.mainWd = null;
      const wd = await this.main();
      const sha = await writeAndCommit(wd, files, message, author);
      await push(wd, await this.mainRemote());
      return sha;
    }
  }

  private async main(): Promise<Workdir> {
    this.mainWd ??= await cloneRepo(await this.mainRemote(), this.require().branch);
    return this.mainWd;
  }

  private async mainRemote(): Promise<Remote> {
    const s = this.require();
    if (!this.mainToken || this.mainToken.expiresAt - Date.now() < 10 * 60_000) {
      using repo = await this.env.ARTIFACTS.get(s.id);
      const token = await repo.createToken("write", 3600);
      this.mainToken = { token: token.plaintext, expiresAt: Date.now() + 3600_000 };
    }
    return { url: s.remote, token: this.mainToken.token };
  }

  // ---- events & websockets -----------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.s) pair[1].send(JSON.stringify({ state: this.state() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  private async emit(body: HiveEventBody) {
    const s = this.require();
    const event = { ...body, seq: ++s.seq, ts: Date.now() } as HiveEvent;
    s.events = [...s.events, event].slice(-MAX_EVENTS);
    await this.persist();
    const payload = JSON.stringify({ event, state: this.state() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // The socket is closing; the hibernation API cleans it up.
      }
    }
  }

  private async persist() {
    if (this.s) await this.ctx.storage.put("s", this.s);
  }

  private require(): Persisted {
    if (!this.s) throw new Error("repo not initialized");
    return this.s;
  }

  private state(): RepoState {
    const s = this.require();
    return {
      id: s.id,
      template: s.template,
      status: s.status,
      statusError: s.statusError,
      remote: s.remote,
      branch: s.branch,
      head: s.head,
      leasesEnabled: s.leasesEnabled,
      agents: Object.values(s.agents),
      leases: Object.values(s.leases),
      intents: Object.values(s.intents).sort((a, b) => b.createdAt - a.createdAt),
      commits: s.commits,
      stats: s.stats,
      events: s.events.slice(-150),
    };
  }
}

/** isomorphic-git reports some failures as one error wrapping several; surface the first real cause. */
function errorMessage(err: unknown): string {
  const inner = (err as { errors?: unknown[] } | null)?.errors?.[0];
  if (inner) return errorMessage(inner);
  return err instanceof Error ? err.message : String(err);
}
