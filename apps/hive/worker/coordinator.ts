import {
  AGENT_COLORS,
  DEFAULT_LEASE_TTL_MS,
  findBlockingLease,
  isActive,
  mergeFile,
  type AgentInfo,
  type AgentStatus,
  type CheckResult,
  type CommitInfo,
  type FileChange,
  type Goal,
  type GoalMode,
  type GithubLink,
  type HiveEvent,
  type HiveEventBody,
  type Intent,
  type Lease,
  type LeaseScope,
  type MergeMode,
  type PullRequestInfo,
  type RepoState,
  type RepoStats,
  type RepoStatus,
  type NotificationKind,
  type TaskItem,
  type TaskStatus,
} from "@hive/core";
import { DurableObject } from "cloudflare:workers";
import {
  cloneRepo,
  defaultBranch,
  initRepo,
  listFiles,
  headOf,
  push,
  readText,
  refresh,
  resetTo,
  search,
  writeAndCommit,
  type Remote,
  type SearchMatch,
  type Workdir,
} from "./git.ts";
import type { Task } from "./scenario.ts";
import { SEED_FILES } from "./seed.ts";
import { tar, type TarEntry } from "./tar.ts";

/** Conflict replays before an intent is rejected. */
const MAX_REPLAYS = 3;
const MAX_EVENTS = 300;
const MAX_COMMITS = 50;
/** Agents that may run at once in one repo. */
export const MAX_ACTIVE_AGENTS = 8;
const IMPORT_POLL_MS = 3_000;
const IMPORT_TIMEOUT_MS = 10 * 60_000;
/** Humans edit slower than agents. */
const HUMAN_LEASE_TTL_MS = 30 * 60_000;
const CHECK_TIMEOUT_SECONDS = 600;
const MAX_CHECK_BYTES = 200 * 1024 * 1024;
const DEMO_CHECK = "npm install --no-audit --no-fund --loglevel=error && npm run check";

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
  importUrl?: string;
  importStartedAt?: number;
  /** Upstream commit last imported or synced, for imports from GitHub. */
  importBase?: string;
  pullRequests?: PullRequestInfo[];
  leasesEnabled: boolean;
  mergeMode: MergeMode;
  checkCommand?: string;
  agents: Record<string, AgentInfo>;
  leases: Record<string, Lease>;
  intents: Record<string, Intent & { replays?: number }>;
  tasks: Record<number, TaskItem>;
  goals: Record<number, Goal>;
  /** Tasks and goals share one counter. */
  nextNumber: number;
  commits: CommitInfo[];
  files: string[];
  stats: RepoStats;
  events: HiveEvent[];
  seq: number;
}

export interface JoinResult {
  forkName: string;
  branch: string;
  /** The branch the agent reads and its intents merge into: the default branch, or a goal branch. */
  target: string;
  description: string;
  main: Remote;
  fork: Remote;
}

export interface AgentContext {
  leasesEnabled: boolean;
  mergeMode: MergeMode;
  checkCommand: string;
}

export type LeaseResult = { ok: true; lease: Lease | null } | { ok: false; holder: Lease };

export interface IntentFile {
  path: string;
  /** Content the agent started from; null if the file did not exist. */
  base: string | null;
}

export interface SubmitInput {
  intentId?: string;
  summary: string;
  commit: string;
  files: IntentFile[];
}

export type Conflict = { path: string; main: string | null };

export type SubmitResult =
  | { status: "merged"; intentId: string; commit: string }
  | { status: "review"; intentId: string }
  | { status: "conflict"; intentId: string; conflicts: Conflict[] }
  | { status: "check_failed"; intentId: string; command: string; log: string }
  | { status: "rejected"; intentId: string; reason: string };

const emptyStats = (): RepoStats => ({ merges: 0, collisionsAvoided: 0, autoMerged: 0, replays: 0, rejected: 0 });

const HIVE_AUTHOR = { name: "hive", email: "hive@hive.dev" };

const FINISHED: AgentStatus[] = ["done", "failed", "cancelled", "review"];

/**
 * One coordinator per repo. It owns the lease table, the merge queue and the review queue,
 * and it is the only writer to the repo's default branch in Artifacts (besides humans with write tokens).
 */
export class RepoCoordinator extends DurableObject<Env> {
  private s: Persisted | null = null;
  /** In-memory clones by branch: the default branch, plus goal branches while their goals are active. */
  private wds = new Map<string, Workdir>();
  private mainToken: { token: string; expiresAt: number } | null = null;
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const s = (await ctx.storage.get<Persisted>("s")) ?? null;
      // State written by earlier versions lacks newer fields.
      if (s) {
        s.mergeMode ??= "auto";
        s.tasks ??= {};
        s.goals ??= {};
        s.nextNumber ??= 0;
        // Imports made before importBase existed: the import head is the oldest commit Hive recorded.
        if (s.template === "import" && s.status === "ready" && !s.importBase) s.importBase = s.commits.at(-1)?.sha;
      }
      this.s = s;
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
      mergeMode: "auto",
      checkCommand: source.type === "demo" ? DEMO_CHECK : "",
      agents: {},
      leases: {},
      intents: {},
      tasks: {},
      goals: {},
      nextNumber: 0,
      commits: [],
      files: [],
      stats: emptyStats(),
      events: [],
      seq: 0,
    };

    if (source.type === "import") {
      // Full history, so the Commits tab and blame go back to the beginning.
      const imported = await this.env.ARTIFACTS.import({
        source: { url: source.url },
        target: { name: id, opts: { description } },
      });
      this.s.remote = imported.remote;
      this.s.importUrl = source.url;
      this.s.status = "importing";
      this.s.importStartedAt = Date.now();
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + IMPORT_POLL_MS);
      return this.state();
    }

    const created = await this.env.ARTIFACTS.create(id, { description, setDefaultBranch: "main" });
    const files =
      source.type === "demo" ? SEED_FILES : { "README.md": `# ${source.title}\n\n${description}\n`.trimEnd() + "\n" };
    const message = source.type === "demo" ? "Seed todo-api" : "Initial commit";
    const wd = await initRepo("main");
    const sha = await writeAndCommit(wd, files, message, HIVE_AUTHOR);
    await push(wd, { url: created.remote, token: created.token });
    this.wds.set("main", wd);
    this.s.remote = created.remote;
    this.s.files = Object.keys(files).sort();
    await this.ready(sha, message);
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
      this.wds.set(s.branch, wd);
      s.files = await listFiles(wd);
      using repo = await this.env.ARTIFACTS.get(s.id);
      const [head] = await repo.log({ ref: s.branch, limit: 1 });
      s.importBase = head.hash;
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

  async updateSettings(patch: {
    leasesEnabled?: boolean;
    mergeMode?: MergeMode;
    checkCommand?: string;
  }): Promise<RepoState> {
    const s = this.require();
    if (patch.leasesEnabled !== undefined) {
      s.leasesEnabled = patch.leasesEnabled;
      if (!patch.leasesEnabled) s.leases = {};
    }
    if (patch.mergeMode) s.mergeMode = patch.mergeMode;
    if (patch.checkCommand !== undefined) s.checkCommand = patch.checkCommand;
    await this.emit({ type: "repo.settings", leasesEnabled: s.leasesEnabled, mergeMode: s.mergeMode });
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
        await this.agent(agent.id)
          .cancel("repo deleted")
          .catch(() => undefined);
        await this.env.ARTIFACTS.delete(agent.fork).catch(() => false);
      }
      await this.env.ARTIFACTS.delete(s.id).catch(() => false);
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "repo deleted");
    this.s = null;
    this.wds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- agents -------------------------------------------------------------

  private agent(agentId: string) {
    return this.env.AGENT.get(this.env.AGENT.idFromName(`${this.require().id}/${agentId}`));
  }

  activeAgents(): number {
    return Object.values(this.require().agents).filter((a) => !FINISHED.includes(a.status)).length;
  }

  /** Spawns one agent per task. Each agent runs in its own Durable Object. */
  async launchAgents(tasks: Task[]): Promise<RepoState> {
    const s = this.require();
    if (s.status !== "ready") throw new Error(`repo is ${s.status}`);
    const active = this.activeAgents();
    if (active + tasks.length > MAX_ACTIVE_AGENTS) {
      throw new Error(`At most ${MAX_ACTIVE_AGENTS} agents can run at once (${active} running).`);
    }
    for (const task of tasks) await this.spawn(task.name, task.task);
    return this.state();
  }

  /** Starts one agent; `taskNumber` links it to a task, whose goal decides the branch it works against. */
  private async spawn(taskName: string, text: string, taskNumber?: number): Promise<string> {
    const s = this.require();
    const index = Object.keys(s.agents).length + 1;
    const agentId = `a${index}`;
    const name = `${taskName}-${index}`;
    const task = taskNumber ? s.tasks[taskNumber] : undefined;
    if (task) {
      // Link first: the agent's first status update looks the task up by agent.
      task.agentId = agentId;
      task.assignee = `agent:${agentId}`;
    }
    const join = await this.join(agentId, name, text, task);
    await this.agent(agentId).start({ repo: s.id, agentId, name, task: text, ...join });
    if (task) await this.setTaskStatus(task, "in_progress");
    return agentId;
  }

  /** Registers an agent: forks the repo into the agent's own repo and mints scoped tokens. */
  private async join(agentId: string, name: string, task: string, item?: TaskItem): Promise<JoinResult> {
    const s = this.require();
    const forkName = `${s.id}--${agentId}`;
    using repo = await this.env.ARTIFACTS.get(s.id);
    const forked = await repo.fork(forkName, { description: `Hive fork for ${name}`, defaultBranchOnly: true });
    const read = await repo.createToken("read", 24 * 3600);

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
      target: this.targetOf(item),
      description: s.description,
      main: { url: s.remote, token: read.plaintext },
      fork: { url: forked.remote, token: forked.token },
    };
  }

  /** Fresh tokens for an agent starting another run (tokens from `join` may have expired). */
  async agentCredentials(
    agentId: string,
  ): Promise<Pick<JoinResult, "main" | "fork" | "description" | "branch" | "target">> {
    const s = this.require();
    const agent = s.agents[agentId];
    using repo = await this.env.ARTIFACTS.get(s.id);
    using fork = await this.env.ARTIFACTS.get(agent.fork);
    const [read, write, info] = await Promise.all([
      repo.createToken("read", 24 * 3600),
      fork.createToken("write", 24 * 3600),
      fork.info(),
    ]);
    return {
      branch: s.branch,
      target: this.targetOf(this.taskOfAgent(agentId)),
      description: s.description,
      main: { url: s.remote, token: read.plaintext },
      fork: { url: info.remote, token: write.plaintext },
    };
  }

  async agentContext(agentId?: string): Promise<AgentContext> {
    const s = this.require();
    // Intents on a goal branch are reviewed once, as part of the goal.
    const task = agentId ? this.taskOfAgent(agentId) : undefined;
    const mergeMode = this.goalOf(task)?.mode === "branch" ? "auto" : s.mergeMode;
    return { leasesEnabled: s.leasesEnabled, mergeMode, checkCommand: s.checkCommand ?? "" };
  }

  async agentStatus(agentId: string, status: AgentStatus, detail: string): Promise<void> {
    const agent = this.s?.agents[agentId];
    if (!agent) return;
    const before = agent.status;
    agent.status = status;
    agent.detail = detail;
    await this.emit({ type: "agent.status", agentId, status, detail });
    const task = this.taskOfAgent(agentId);
    if (status !== before) {
      if (status === "done") await this.notify("agent_done", `${agent.name} finished`, detail, `agents/${agentId}`);
      if (status === "failed") await this.notify("agent_failed", `${agent.name} failed`, detail, `agents/${agentId}`);
    }
    if (task && task.status !== "closed") {
      if (status === "done") await this.setTaskStatus(task, "done");
      else if (status === "review") await this.setTaskStatus(task, "in_review");
      else if (status === "failed" || status === "cancelled") {
        // Back on the board so it can be launched again.
        task.agentId = null;
        task.assignee = null;
        await this.setTaskStatus(task, "open");
      } else if (task.status !== "in_progress") await this.setTaskStatus(task, "in_progress");
    }
  }

  async cancelAgent(agentId: string, by: string): Promise<void> {
    if (!this.require().agents[agentId]) throw new Error("no such agent");
    await this.agent(agentId).cancel(`cancelled by ${by}`);
  }

  /** A message from a person to an agent: read on its next step, or starts a revision if it has finished. */
  async messageAgent(agentId: string, message: string, by: string): Promise<void> {
    if (!this.require().agents[agentId]) throw new Error("no such agent");
    await this.agent(agentId).message(message, by);
  }

  async getIntent(intentId: string): Promise<Intent | null> {
    return this.require().intents[intentId] ?? null;
  }

  async listMainFiles(): Promise<string[]> {
    return this.require().files;
  }

  async searchMain(pattern: string, prefix?: string): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const wd = await this.main();
    await this.syncMain(wd);
    return search(wd, regex, { prefix, limit: 200 });
  }

  // ---- leases -------------------------------------------------------------

  /** `retry` marks a repeated request from an agent waiting in line, which is not counted as a new collision. */
  async requestLease(holderId: string, scope: LeaseScope, reason: string, retry = false): Promise<LeaseResult> {
    const s = this.require();
    if (!s.leasesEnabled) return { ok: true, lease: null };
    return this.grantLease(holderId, s.agents[holderId]?.name ?? holderId, scope, reason, DEFAULT_LEASE_TTL_MS, retry);
  }

  /** People can lease files too, so agents work around what they are editing. */
  async humanLease(login: string, path: string, reason: string): Promise<LeaseResult> {
    return this.grantLease(`human:${login}`, login, { path }, reason || "editing by hand", HUMAN_LEASE_TTL_MS, false);
  }

  async humanRelease(login: string, path: string): Promise<void> {
    const s = this.require();
    for (const lease of Object.values(s.leases)) {
      if (lease.agentId !== `human:${login}` || lease.path !== path) continue;
      delete s.leases[lease.id];
      await this.emit({ type: "lease.released", leaseId: lease.id, agentId: lease.agentId, path, reason: "done" });
    }
  }

  private async grantLease(
    holderId: string,
    holderName: string,
    scope: LeaseScope,
    reason: string,
    ttl: number,
    retry: boolean,
  ): Promise<LeaseResult> {
    const s = this.require();
    const now = Date.now();
    const leases = Object.values(s.leases);
    const holder = findBlockingLease(leases, scope, holderId, now);
    if (holder) {
      if (!retry) {
        s.stats.collisionsAvoided++;
        await this.emit({ type: "lease.denied", agentId: holderId, scope, holder });
      }
      return { ok: false, holder };
    }
    const existing = leases.find(
      (l) =>
        l.agentId === holderId &&
        l.path === scope.path &&
        l.startLine === scope.startLine &&
        l.endLine === scope.endLine,
    );
    const lease: Lease = existing
      ? { ...existing, reason, expiresAt: now + ttl }
      : {
          id: crypto.randomUUID(),
          agentId: holderId,
          holderName,
          ...scope,
          reason,
          grantedAt: now,
          expiresAt: now + ttl,
        };
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

  // ---- intents: merge queue and review queue -------------------------------

  /**
   * Records an intent. In auto mode it goes through the merge queue now and this resolves with the outcome;
   * in review mode it waits for a person and this resolves right away.
   */
  async submitIntent(agentId: string, input: SubmitInput): Promise<SubmitResult> {
    const s = this.require();
    let intent = input.intentId ? s.intents[input.intentId] : undefined;
    if (intent) {
      intent.summary = input.summary;
      intent.commit = input.commit;
      intent.files = input.files.map((f) => f.path);
      intent.attempts++;
    } else {
      const task = this.taskOfAgent(agentId);
      intent = {
        id: crypto.randomUUID().slice(0, 8),
        agentId,
        summary: input.summary,
        commit: input.commit,
        files: input.files.map((f) => f.path),
        status: "queued",
        attempts: 1,
        createdAt: Date.now(),
        goalNumber: task?.goalNumber ?? undefined,
        taskNumber: task?.number,
      };
      s.intents[intent.id] = intent;
      if (task) task.intentId = intent.id;
    }
    intent.conflicts = undefined;
    await this.ctx.storage.put(`input:${intent.id}`, input.files);

    if (
      s.mergeMode === "review" &&
      this.goalOf(intent.taskNumber ? s.tasks[intent.taskNumber] : undefined)?.mode !== "branch"
    ) {
      intent.status = "review";
      await this.emit({ type: "intent.review", intentId: intent.id, agentId });
      await this.notify(
        "review_requested",
        `Review requested: ${intent.summary}`,
        `${s.agents[agentId]?.name} submitted an intent.`,
        "intents",
      );
      // Nothing lands until a person approves, so do not block other agents meanwhile.
      await this.releaseLeases(agentId);
      return { status: "review", intentId: intent.id };
    }

    intent.status = "queued";
    await this.emit({ type: "intent.queued", intent: { ...intent } });
    try {
      return await this.enqueue(intent.id);
    } catch (err) {
      intent.status = "rejected";
      intent.reviewComment = `merge failed: ${errorMessage(err)}`;
      await this.persist();
      throw err;
    }
  }

  private enqueue(intentId: string): Promise<SubmitResult> {
    const result = this.mergeChain.then(() => this.merge(intentId));
    this.mergeChain = result.catch(() => undefined);
    return result;
  }

  async approveIntent(intentId: string, by: string): Promise<SubmitResult> {
    const intent = this.requireIntent(intentId);
    if (intent.status !== "review") throw new Error(`intent is ${intent.status}, not awaiting review`);
    intent.status = "queued";
    intent.reviewComment = undefined;
    await this.emit({ type: "intent.queued", intent: { ...intent } });
    let result: SubmitResult;
    try {
      result = await this.enqueue(intentId);
    } catch (err) {
      // Leave it reviewable rather than stuck in the queue.
      intent.status = "review";
      await this.persist();
      throw err;
    }
    const agent = this.agent(intent.agentId);
    if (result.status === "merged") await this.agentStatus(intent.agentId, "done", `approved by ${by} and merged`);
    if (result.status === "rejected") await this.agentStatus(intent.agentId, "failed", result.reason);
    if (result.status === "conflict") {
      await agent.revise({ kind: "conflict", intentId, conflicts: result.conflicts });
    }
    if (result.status === "check_failed") {
      await agent.revise({ kind: "check", intentId, command: result.command, log: result.log });
    }
    return result;
  }

  async requestChanges(intentId: string, comment: string, by: string): Promise<void> {
    const intent = this.requireIntent(intentId);
    if (intent.status !== "review") throw new Error(`intent is ${intent.status}, not awaiting review`);
    intent.status = "changes_requested";
    intent.reviewComment = comment;
    await this.emit({ type: "intent.changes_requested", intentId, agentId: intent.agentId, comment, by });
    await this.agent(intent.agentId).revise({ kind: "changes", intentId, comment, by });
  }

  async rejectIntent(intentId: string, comment: string, by: string): Promise<void> {
    const s = this.require();
    const intent = this.requireIntent(intentId);
    if (intent.status !== "review") throw new Error(`intent is ${intent.status}, not awaiting review`);
    intent.status = "rejected";
    intent.reviewComment = comment || undefined;
    s.stats.rejected++;
    const reason = `rejected by ${by}${comment ? `: ${comment}` : ""}`;
    await this.emit({ type: "intent.rejected", intentId, agentId: intent.agentId, reason });
    await this.agentStatus(intent.agentId, "failed", reason);
  }

  private requireIntent(intentId: string) {
    const intent = this.require().intents[intentId];
    if (!intent) throw new Error("no such intent");
    return intent;
  }

  private async merge(intentId: string): Promise<SubmitResult> {
    const s = this.require();
    const intent = this.requireIntent(intentId);
    const agent = s.agents[intent.agentId];
    const files = (await this.ctx.storage.get<IntentFile[]>(`input:${intentId}`)) ?? [];
    intent.status = "merging";
    await this.persist();

    const branch = this.targetOf(intent.taskNumber ? s.tasks[intent.taskNumber] : undefined);
    const wd = await this.main(branch);
    await this.syncMain(wd);
    using fork = await this.env.ARTIFACTS.get(agent.fork);

    const merged: Record<string, string | null> = {};
    const conflicts: Conflict[] = [];
    let autoMerged = false;
    for (const { path, base } of files) {
      const blob = await fork.readFile({ ref: intent.commit, path });
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
      intent.replays = (intent.replays ?? 0) + 1;
      await this.emit({ type: "intent.conflict", intentId, agentId: intent.agentId, files: intent.conflicts });
      if (intent.replays > MAX_REPLAYS) {
        intent.status = "rejected";
        s.stats.rejected++;
        const reason = `still conflicting after ${MAX_REPLAYS} replays`;
        await this.emit({ type: "intent.rejected", intentId, agentId: intent.agentId, reason });
        await this.releaseLeases(intent.agentId);
        return { status: "rejected", intentId, reason };
      }
      intent.status = "replaying";
      s.stats.replays++;
      await this.emit({ type: "intent.replaying", intentId, agentId: intent.agentId, attempt: intent.attempts + 1 });
      return { status: "conflict", intentId, conflicts };
    }

    const message = `${intent.summary}\n\nHive-Intent: ${intent.id}\nHive-Agent: ${agent.name}`;
    const author = { name: agent.name, email: `${agent.id}@agents.hive.dev` };
    let sha: string;
    if (s.checkCommand) {
      // Commit locally, check the exact tree that would land, and only then push.
      const previous = await headOf(wd);
      sha = await writeAndCommit(wd, merged, message, author);
      await this.emit({ type: "intent.checking", intentId, agentId: intent.agentId });
      const check = await this.runCheck(wd, s.checkCommand);
      intent.check = check;
      await this.emit({ type: "intent.checked", intentId, agentId: intent.agentId, result: check });
      if (check.status === "failed") {
        await this.notify("check_failed", `Checks failed: ${intent.summary}`, check.log.slice(-300), "intents");
        await resetTo(wd, previous);
        intent.replays = (intent.replays ?? 0) + 1;
        if (intent.replays > MAX_REPLAYS) {
          intent.status = "rejected";
          s.stats.rejected++;
          const reason = `checks still failing after ${MAX_REPLAYS} attempts`;
          await this.emit({ type: "intent.rejected", intentId, agentId: intent.agentId, reason });
          await this.releaseLeases(intent.agentId);
          return { status: "rejected", intentId, reason };
        }
        intent.status = "replaying";
        s.stats.replays++;
        await this.emit({ type: "intent.replaying", intentId, agentId: intent.agentId, attempt: intent.attempts + 1 });
        return { status: "check_failed", intentId, command: s.checkCommand, log: check.log };
      }
      sha = await this.pushOrRedo(wd, sha, merged, message, author);
    } else {
      sha = await this.commitToMain(merged, message, author, branch);
    }
    const commit: CommitInfo = { sha, message: intent.summary, author: agent.name, at: Date.now() };

    intent.status = "merged";
    intent.mergedAs = sha;
    intent.conflicts = undefined;
    s.stats.merges++;
    if (autoMerged) s.stats.autoMerged++;
    // Goal branches have their own history; only the default branch feeds the repo's commit list.
    if (branch === s.branch) await this.recordCommit(commit);
    await this.emit({
      type: "intent.merged",
      intentId,
      agentId: intent.agentId,
      commit,
      mode: autoMerged ? "auto-merge" : "direct",
    });
    await this.releaseLeases(intent.agentId);
    return { status: "merged", intentId, commit: sha };
  }

  /** Undoes a merged intent with a new commit, 3-way merging so later changes to the same files survive. */
  async revertIntent(intentId: string, by: string): Promise<CommitInfo> {
    const run = this.mergeChain.then(() => this.revert(intentId, by));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  private async revert(intentId: string, by: string): Promise<CommitInfo> {
    const s = this.require();
    const intent = this.requireIntent(intentId);
    if (intent.status !== "merged" || !intent.mergedAs) throw new Error("only merged intents can be reverted");
    const goal = intent.goalNumber ? s.goals[intent.goalNumber] : undefined;
    if (goal?.mode === "branch") throw new Error("This intent belongs to a goal branch and cannot be reverted alone.");
    using repo = await this.env.ARTIFACTS.get(s.id);
    const landed = await repo.readCommit(intent.mergedAs);
    const parent = landed?.parents[0];
    if (!parent) throw new Error("cannot revert the first commit");

    const wd = await this.main();
    await this.syncMain(wd);
    const read = async (ref: string, path: string) => {
      const blob = await repo.readFile({ ref, path });
      return blob ? blob.text() : null;
    };
    const changes: Record<string, string | null> = {};
    const conflicts: string[] = [];
    for (const path of intent.files) {
      const after = await read(intent.mergedAs, path);
      const before = await read(parent, path);
      const result = mergeFile(after, await readText(wd, path), before);
      if (!result.clean) conflicts.push(path);
      else changes[path] = result.text;
    }
    if (conflicts.length) {
      throw new Error(`Cannot revert cleanly; later changes conflict in ${conflicts.join(", ")}.`);
    }

    const sha = await this.commitToMain(
      changes,
      `Revert "${intent.summary}"\n\nHive-Revert: ${intent.id}\nReverted-By: ${by}`,
      { name: by, email: `${by}@users.hive.dev` },
    );
    const commit: CommitInfo = { sha, message: `Revert "${intent.summary}"`, author: by, at: Date.now() };
    intent.status = "reverted";
    intent.revertedAs = sha;
    await this.recordCommit(commit);
    await this.emit({ type: "intent.reverted", intentId, agentId: intent.agentId, commit, by });
    return commit;
  }

  private async recordCommit(commit: CommitInfo) {
    const s = this.require();
    s.head = commit.sha;
    s.commits = [commit, ...s.commits].slice(0, MAX_COMMITS);
    const wd = this.wds.get(s.branch);
    s.files = wd ? await listFiles(wd) : s.files;
  }

  /** Packs the working tree and runs `command` against it in a fresh sandbox. */
  private async runCheck(wd: Workdir, command: string): Promise<CheckResult> {
    const started = Date.now();
    try {
      const entries: TarEntry[] = [];
      let bytes = 0;
      for (const path of await listFiles(wd)) {
        const full = `${wd.dir}/${path}`;
        const stat = await wd.fs.promises.lstat(full);
        if (stat.isSymbolicLink()) {
          entries.push({ path, linkTarget: await wd.fs.promises.readlink(full) });
          continue;
        }
        const data = (await wd.fs.promises.readFile(full)) as Uint8Array;
        bytes += data.length;
        if (bytes > MAX_CHECK_BYTES) {
          return { status: "skipped", exitCode: 0, log: "Repository too large to check.", durationMs: 0 };
        }
        entries.push({ path, data, executable: stat.mode === 0o100755 });
      }
      const { archive } = tar(entries);
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(crypto.randomUUID()));
      return await sandbox.check(archive, command, CHECK_TIMEOUT_SECONDS);
    } catch (err) {
      // A sandbox outage should not stop every merge; record it and let the change through.
      console.error("check could not run", err);
      return {
        status: "skipped",
        exitCode: -1,
        log: `The sandbox could not run: ${errorMessage(err)}`,
        durationMs: Date.now() - started,
      };
    }
  }

  /** Pushes a local commit; if the remote moved meanwhile, redo the change on a fresh clone. */
  private async pushOrRedo(
    wd: Workdir,
    sha: string,
    files: Record<string, string | null>,
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    try {
      await push(wd, await this.mainRemote());
      return sha;
    } catch (err) {
      console.warn("push failed, recloning", err);
      this.wds.delete(wd.branch);
      const fresh = await this.main(wd.branch);
      const redone = await writeAndCommit(fresh, files, message, author);
      await push(fresh, await this.mainRemote());
      return redone;
    }
  }

  private async commitToMain(
    files: Record<string, string | null>,
    message: string,
    author: { name: string; email: string },
    branch = this.require().branch,
  ) {
    try {
      const wd = await this.main(branch);
      const sha = await writeAndCommit(wd, files, message, author);
      await push(wd, await this.mainRemote());
      return sha;
    } catch (err) {
      // Someone pushed in between, or the cached clone is stale: start from a fresh clone once.
      console.warn("push failed, recloning", err);
      this.wds.delete(branch);
      const wd = await this.main(branch);
      const sha = await writeAndCommit(wd, files, message, author);
      await push(wd, await this.mainRemote());
      return sha;
    }
  }

  /** Picks up commits pushed by people with write tokens, so merges never build on a stale head. */
  private async syncMain(wd: Workdir) {
    const s = this.require();
    const head = await refresh(wd, await this.mainRemote());
    if (wd.branch === s.branch && head !== s.head) {
      s.head = head;
      s.files = await listFiles(wd);
      await this.emit({ type: "commit.external", head });
    }
  }

  private async main(branch = this.require().branch): Promise<Workdir> {
    let wd = this.wds.get(branch);
    if (!wd) {
      wd = await cloneRepo(await this.mainRemote(), branch);
      this.wds.set(branch, wd);
    }
    return wd;
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

  // ---- tasks and goals -----------------------------------------------------------

  private taskOfAgent(agentId: string): TaskItem | undefined {
    return Object.values(this.require().tasks).find((t) => t.agentId === agentId);
  }

  private goalOf(task?: TaskItem): Goal | undefined {
    return task?.goalNumber ? this.require().goals[task.goalNumber] : undefined;
  }

  /** The branch a task's intents merge into. */
  private targetOf(task?: TaskItem): string {
    const goal = this.goalOf(task);
    return goal?.mode === "branch" && goal.branch && goal.status !== "done" ? goal.branch : this.require().branch;
  }

  private async notify(kind: NotificationKind, title: string, body: string, path = "") {
    try {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
      await dir.notifyOwner(this.require().id, kind, title, body, path);
    } catch (err) {
      console.error("notification failed", err);
    }
  }

  private async setTaskStatus(task: TaskItem, status: TaskStatus) {
    if (task.status !== status) {
      task.status = status;
      await this.touchTask(task);
    }
    await this.updateGoal(task.goalNumber);
  }

  private async touchTask(task: TaskItem) {
    task.updatedAt = Date.now();
    await this.emit({ type: "task.updated", task: { ...task } });
  }

  private async touchGoal(goal: Goal) {
    goal.updatedAt = Date.now();
    await this.emit({ type: "goal.updated", goal: { ...goal } });
  }

  /** Moves a goal along when its tasks finish (or come back to life). */
  private async updateGoal(number: number | null) {
    const goal = number ? this.require().goals[number] : undefined;
    if (!goal || goal.status === "closed" || goal.status === "done") return;
    const tasks = Object.values(this.require().tasks).filter((t) => t.goalNumber === goal.number);
    const finished = tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "closed");
    const anyDone = tasks.some((t) => t.status === "done");
    let next: Goal["status"];
    if (!finished) next = "active";
    else if (!anyDone) next = "closed";
    else next = goal.mode === "direct" ? "done" : "review";
    if (next === goal.status) return;
    goal.status = next;
    await this.touchGoal(goal);
    if (next === "review") {
      await this.notify("goal_review", `Goal #${goal.number} is ready for review`, goal.title, `goals/${goal.number}`);
    }
    if (next === "done") {
      await this.notify("goal_done", `Goal #${goal.number} is done`, goal.title, `goals/${goal.number}`);
    }
  }

  private requireTask(number: number): TaskItem {
    const task = this.require().tasks[number];
    if (!task) throw new Error("no such task");
    return task;
  }

  private requireGoal(number: number): Goal {
    const goal = this.require().goals[number];
    if (!goal) throw new Error("no such goal");
    return goal;
  }

  private newTask(input: { title: string; body: string; labels?: string[]; goalNumber?: number | null; by: string }) {
    const s = this.require();
    const now = Date.now();
    const task: TaskItem = {
      number: ++s.nextNumber,
      title: input.title,
      body: input.body,
      labels: input.labels ?? [],
      status: "open",
      assignee: null,
      agentId: null,
      intentId: null,
      goalNumber: input.goalNumber ?? null,
      createdBy: input.by,
      createdAt: now,
      updatedAt: now,
    };
    s.tasks[task.number] = task;
    return task;
  }

  async createTask(input: { title: string; body: string; labels: string[]; goalNumber?: number; by: string }) {
    if (input.goalNumber) this.requireGoal(input.goalNumber);
    const task = this.newTask(input);
    await this.touchTask(task);
    await this.updateGoal(task.goalNumber);
    return task;
  }

  async updateTask(
    number: number,
    patch: { title?: string; body?: string; labels?: string[]; status?: "open" | "closed" },
  ): Promise<TaskItem> {
    const task = this.requireTask(number);
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.body !== undefined) task.body = patch.body;
    if (patch.labels !== undefined) task.labels = patch.labels;
    if (patch.status === "closed" && task.status !== "closed") {
      if (task.agentId) await this.cancelAgent(task.agentId, "task closed").catch(() => undefined);
      task.status = "closed";
    } else if (patch.status === "open" && task.status === "closed") task.status = "open";
    await this.touchTask(task);
    await this.updateGoal(task.goalNumber);
    return task;
  }

  async assignTask(number: number, to: "agent" | "me" | "none", by: string): Promise<TaskItem> {
    const s = this.require();
    const task = this.requireTask(number);
    if (task.status === "closed" || task.status === "done") throw new Error(`task is ${task.status}`);
    if (to === "agent") {
      if (task.agentId && !FINISHED.includes(s.agents[task.agentId]?.status))
        throw new Error("an agent is already on it");
      if (s.status !== "ready") throw new Error(`repo is ${s.status}`);
      if (this.activeAgents() >= MAX_ACTIVE_AGENTS) {
        throw new Error(`At most ${MAX_ACTIVE_AGENTS} agents can run at once.`);
      }
      await this.spawn(slug(task.title), this.taskPrompt(task), task.number);
    } else if (to === "me") {
      task.assignee = `user:${by}`;
      task.status = "in_progress";
      await this.touchTask(task);
    } else {
      if (task.agentId) await this.cancelAgent(task.agentId, `unassigned by ${by}`);
      task.assignee = null;
      task.agentId = null;
      task.status = "open";
      await this.touchTask(task);
    }
    await this.updateGoal(task.goalNumber);
    return task;
  }

  private taskPrompt(task: TaskItem): string {
    const goal = this.goalOf(task);
    const context = goal
      ? `This task is part of goal #${goal.number} "${goal.title}"${goal.summary ? `: ${goal.summary}` : ""}. Other agents work on the goal's other tasks at the same time.`
      : "";
    return [`#${task.number} ${task.title}`, task.body, context].filter(Boolean).join("\n\n");
  }

  /** Creates a goal with a task per entry; with `launch`, one agent per task right away. */
  async createGoal(input: {
    title: string;
    summary: string;
    mode: GoalMode;
    by: string;
    tasks: { name?: string; task: string; files?: string[] }[];
    launch: boolean;
  }): Promise<Goal> {
    const s = this.require();
    if (s.status !== "ready") throw new Error(`repo is ${s.status}`);
    if (input.launch && this.activeAgents() + input.tasks.length > MAX_ACTIVE_AGENTS) {
      throw new Error(`At most ${MAX_ACTIVE_AGENTS} agents can run at once (${this.activeAgents()} running).`);
    }
    const now = Date.now();
    const number = ++s.nextNumber;
    const goal: Goal = {
      number,
      title: input.title,
      summary: input.summary,
      mode: input.mode,
      branch: null,
      baseCommit: null,
      status: "active",
      createdBy: input.by,
      createdAt: now,
      updatedAt: now,
    };
    if (input.mode === "branch") {
      const wd = await this.main();
      await this.syncMain(wd);
      goal.baseCommit = await headOf(wd);
      goal.branch = `goal/${number}-${slug(input.title)}`;
      await push(wd, await this.mainRemote(), { remoteRef: goal.branch });
    }
    s.goals[number] = goal;
    await this.touchGoal(goal);
    const created = input.tasks.map((t) => {
      const body = [t.task, t.files?.length ? `Files: ${t.files.join(", ")}` : ""].filter(Boolean).join("\n\n");
      return this.newTask({ title: titleOf(t.task), body, goalNumber: number, by: input.by });
    });
    for (const task of created) await this.touchTask(task);
    if (input.launch) {
      for (const [i, task] of created.entries()) {
        await this.spawn(input.tasks[i].name || slug(task.title), this.taskPrompt(task), task.number);
      }
    }
    return goal;
  }

  async closeGoal(number: number): Promise<Goal> {
    const s = this.require();
    const goal = this.requireGoal(number);
    if (goal.status === "done") throw new Error("goal is already done");
    for (const task of Object.values(s.tasks)) {
      if (task.goalNumber !== number || task.status === "closed" || task.status === "done") continue;
      if (task.agentId) await this.cancelAgent(task.agentId, "goal closed").catch(() => undefined);
      task.status = "closed";
      await this.touchTask(task);
    }
    goal.status = "closed";
    await this.touchGoal(goal);
    return goal;
  }

  /** The goal's combined change: files touched by its landed intents, goal branch against where it started. */
  async goalDiff(number: number): Promise<{ base: string | null; head: string | null; files: FileChange[] }> {
    const s = this.require();
    const goal = this.requireGoal(number);
    if (goal.mode !== "branch" || !goal.branch || !goal.baseCommit) return { base: null, head: null, files: [] };
    const paths = new Set<string>();
    for (const i of Object.values(s.intents)) {
      if (i.goalNumber === number && i.status === "merged") i.files.forEach((f) => paths.add(f));
    }
    using repo = await this.env.ARTIFACTS.get(s.id);
    const read = async (ref: string, path: string) => {
      const blob = await repo.readFile({ ref, path });
      return blob ? blob.text() : null;
    };
    const files: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const before = await read(goal.baseCommit, path);
      const after = await read(goal.branch, path);
      if (before === after) continue;
      files.push({ path, status: before === null ? "added" : after === null ? "deleted" : "modified", before, after });
    }
    const [head] = await repo.log({ ref: goal.branch, limit: 1 });
    return { base: goal.baseCommit, head: head?.hash ?? null, files };
  }

  /** Lands a reviewed goal branch on the default branch as one commit (3-way per file, checked first). */
  async mergeGoal(
    number: number,
    by: string,
  ): Promise<
    | { status: "merged"; commit: string }
    | { status: "conflict"; files: string[] }
    | { status: "check_failed"; log: string }
  > {
    const run = this.mergeChain.then(() => this.mergeGoalNow(number, by));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  private async mergeGoalNow(number: number, by: string) {
    const s = this.require();
    const goal = this.requireGoal(number);
    if (goal.mode !== "branch" || !goal.branch || goal.status !== "review") {
      throw new Error("this goal is not waiting for review");
    }
    const main = await this.main();
    await this.syncMain(main);
    const gwd = await this.main(goal.branch);
    await this.syncMain(gwd);

    const intents = Object.values(s.intents).filter((i) => i.goalNumber === number && i.status === "merged");
    const paths = [...new Set(intents.flatMap((i) => i.files))];
    using repo = await this.env.ARTIFACTS.get(s.id);
    const merged: Record<string, string | null> = {};
    const conflicts: string[] = [];
    for (const path of paths) {
      const blob = await repo.readFile({ ref: goal.baseCommit!, path });
      const ours = await readText(main, path);
      const result = mergeFile(blob ? await blob.text() : null, ours, await readText(gwd, path));
      if (!result.clean) conflicts.push(path);
      else if (result.text !== ours) merged[path] = result.text;
    }
    if (conflicts.length) {
      goal.mergeError = `Conflicts with changes on ${s.branch} in: ${conflicts.join(", ")}`;
      await this.touchGoal(goal);
      return { status: "conflict" as const, files: conflicts };
    }

    const message = [
      `${goal.title} (goal #${goal.number})`,
      goal.summary,
      intents.map((i) => `- ${i.summary}`).join("\n"),
      `Hive-Goal: ${goal.number}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const author = { name: by, email: `${by}@users.hive.dev` };
    let sha: string;
    if (s.checkCommand) {
      const previous = await headOf(main);
      sha = await writeAndCommit(main, merged, message, author);
      const check = await this.runCheck(main, s.checkCommand);
      goal.check = check;
      if (check.status === "failed") {
        await resetTo(main, previous);
        goal.mergeError = "Checks failed on the merged result.";
        await this.touchGoal(goal);
        await this.notify("check_failed", `Checks failed: goal #${number}`, check.log.slice(-300), `goals/${number}`);
        return { status: "check_failed" as const, log: check.log };
      }
      sha = await this.pushOrRedo(main, sha, merged, message, author);
    } else {
      sha = await this.commitToMain(merged, message, author);
    }
    goal.status = "done";
    goal.mergedAs = sha;
    goal.mergeError = undefined;
    s.stats.merges++;
    await this.recordCommit({ sha, message: `${goal.title} (goal #${number})`, author: by, at: Date.now() });
    await this.touchGoal(goal);
    await this.notify("goal_done", `Goal #${number} merged`, goal.title, `goals/${number}`);
    this.wds.delete(goal.branch);
    return { status: "merged" as const, commit: sha };
  }

  // ---- GitHub round trip ------------------------------------------------------

  async githubSource(): Promise<{ url: string | null; base: string | null; head: string | null; branch: string }> {
    const s = this.require();
    return { url: s.importUrl ?? null, base: s.importBase ?? null, head: s.head, branch: s.branch };
  }

  async recordPullRequest(pr: PullRequestInfo, by: string): Promise<void> {
    const s = this.require();
    s.pullRequests = [pr, ...(s.pullRequests ?? [])].slice(0, 20);
    await this.emit({ type: "github.pr", pr, by });
  }

  /**
   * Brings upstream changes into the default branch: a 3-way merge per file between the last synced upstream
   * commit, Hive's head and the new upstream. Nothing changes when any file conflicts.
   */
  async syncUpstream(
    changes: { path: string; base: string | null; theirs: string | null }[],
    upstream: string,
    by: string,
  ): Promise<{ status: "synced"; commit: CommitInfo | null; files: number } | { status: "conflict"; files: string[] }> {
    const run = this.mergeChain.then(async () => {
      const s = this.require();
      const wd = await this.main();
      await this.syncMain(wd);
      const files: Record<string, string | null> = {};
      const conflicts: string[] = [];
      for (const change of changes) {
        const ours = await readText(wd, change.path);
        const result = mergeFile(change.base, ours, change.theirs);
        if (!result.clean) conflicts.push(change.path);
        else if (result.text !== ours) files[change.path] = result.text;
      }
      if (conflicts.length) return { status: "conflict" as const, files: conflicts };

      let commit: CommitInfo | null = null;
      if (Object.keys(files).length) {
        const repo = s.importUrl?.replace(/^https:\/\/github\.com\//, "") ?? "upstream";
        const message = `Sync from GitHub ${repo}@${upstream.slice(0, 7)}`;
        const sha = await this.commitToMain(files, `${message}\n\nHive-Upstream: ${upstream}`, {
          name: by,
          email: `${by}@users.hive.dev`,
        });
        commit = { sha, message, author: by, at: Date.now() };
        await this.recordCommit(commit);
      }
      s.importBase = upstream;
      await this.emit({ type: "github.synced", upstream, commit, by });
      return { status: "synced" as const, commit, files: Object.keys(files).length };
    });
    this.mergeChain = run.catch(() => undefined);
    return run;
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
      mergeMode: s.mergeMode,
      checkCommand: s.checkCommand ?? "",
      github: githubLink(s),
      agents: Object.values(s.agents),
      leases: Object.values(s.leases),
      intents: Object.values(s.intents)
        .map(({ replays: _replays, ...intent }) => intent)
        .sort((a, b) => b.createdAt - a.createdAt),
      tasks: Object.values(s.tasks),
      goals: Object.values(s.goals),
      commits: s.commits,
      stats: s.stats,
      events: s.events.slice(-150),
    };
  }
}

function githubLink(s: Persisted): GithubLink | null {
  const m = s.importUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, base: s.importBase ?? null, pullRequests: s.pullRequests ?? [] };
}

const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-$/, "") || "task";

/** isomorphic-git reports some failures as one error wrapping several; surface the first real cause. */
function errorMessage(err: unknown): string {
  const inner = (err as { errors?: unknown[] } | null)?.errors?.[0];
  if (inner) return errorMessage(inner);
  return err instanceof Error ? err.message : String(err);
}
