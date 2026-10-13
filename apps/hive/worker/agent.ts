import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentStatus, TranscriptStep } from "@hive/core";
import { DurableObject } from "cloudflare:workers";
import type { AgentContext, Conflict, IntentFile, JoinResult, RepoCoordinator } from "./coordinator.ts";
import { cloneRepo, fetchFrom, listFiles, push, resetTo, search, writeAndCommit, type Workdir } from "./git.ts";

const MAX_TURNS = 50;
const LEASE_WAIT_MS = 150_000;
const LEASE_POLL_MS = 3_000;
const MAX_READ_CHARS = 100_000;
const MAX_STEP_BODY = 6_000;

export interface AgentConfig extends JoinResult {
  repo: string;
  agentId: string;
  name: string;
  task: string;
}

/** Why an agent runs again after its first run. */
export type Revision =
  | { kind: "conflict"; intentId: string; conflicts: Conflict[] }
  | { kind: "changes"; intentId: string; comment: string; by: string }
  | { kind: "check"; intentId: string; command: string; log: string }
  | { kind: "message"; message: string; by: string };

type RunReason = { kind: "initial" } | Revision;

interface Submission {
  intentId: string;
  summary: string;
  commit: string;
  files: IntentFile[];
}

class Cancelled extends Error {}

const TOOLS: BetaTool[] = [
  {
    name: "list_files",
    description: "List file paths on the default branch, optionally only those under a directory prefix.",
    input_schema: {
      type: "object",
      properties: { prefix: { type: "string", description: "e.g. src/routes/" } },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Search file contents with a regular expression (case-insensitive). Returns up to 100 matching lines as path:line: text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        prefix: { type: "string", description: "Only search under this directory prefix." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a file with line numbers. Returns your pending edit if you have changed the file, otherwise the latest version on the default branch. Use start_line/end_line for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "request_lease",
    description:
      "Ask for an exclusive lease on a file before changing, creating or deleting it. A granted lease returns the latest content. If someone else holds the file the lease is denied: work on other files first, or call again with wait=true to queue (up to ~2 minutes).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string", description: "A few words on what you will change, shown to others." },
        wait: { type: "boolean" },
      },
      required: ["path", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet in a file you hold a lease on. old_string must match exactly once (include surrounding lines to make it unique) unless replace_all is true. Prefer this over write_file for small changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create a file or replace its whole content. You must hold a lease on it.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file you hold a lease on.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "submit",
    description:
      "Commit your pending changes and submit them with a one-sentence intent describing the change. Call once when the task is done.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "Imperative mood, e.g. 'Add pagination to GET /todos'." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

function systemPrompt(config: AgentConfig, ctx: AgentContext) {
  const about = config.description ? `\n\nAbout this repository: ${config.description}` : "";
  const checks = ctx.checkCommand
    ? `\n- Before your change lands, the repository's checks run against the merged result in a sandbox: \`${ctx.checkCommand}\`. If they fail you get the log and must fix the problem.`
    : "";
  const review =
    ctx.mergeMode === "review"
      ? "\n- A person reviews every intent before it lands. They may request changes; you will be asked to revise."
      : "";
  return `You are ${config.name}, one of several AI agents changing the same git repository at the same time through Hive.${about}

How Hive works:
- Explore first: list_files, search, then read the files relevant to your task.
- Before changing, creating or deleting a file, call request_lease on it. A lease gives you exclusive edit rights and the latest content of that file. Leases held by other agents or people block you; when that happens, do other parts of your task first, then call request_lease again with wait=true.
- Lease only files you will change, and keep the change focused on your task. Match the existing code style. Do not reformat or refactor unrelated code; others are changing nearby code.
- Use edit_file for targeted changes and write_file for new files or rewrites.
- When your change is complete, call submit with a one-sentence intent. If the merge queue reports a conflict, re-apply your intent on top of the current file versions it shows you and submit again.${checks}${review}
- People may send you messages while you work; follow them.
- You cannot run code yourself. Work it out from the code.`;
}

function numbered(content: string, start = 1) {
  return content
    .split("\n")
    .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
    .join("\n");
}

function fence(path: string, content: string | null) {
  return content === null ? `${path} does not exist.` : `### ${path}\n\`\`\`\n${content}\n\`\`\``;
}

function clip(text: string, max = MAX_STEP_BODY) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/**
 * An autonomous coding agent. Each agent lives in its own Durable Object, runs from an alarm, keeps a transcript,
 * and can be cancelled, messaged, or asked to revise its intent.
 */
export class HiveAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private running = false;
  private cancelled: string | null = null;
  private inbox: { message: string; by: string }[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run INTEGER NOT NULL, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, error INTEGER NOT NULL DEFAULT 0
    )`);
  }

  async start(config: AgentConfig): Promise<void> {
    await this.ctx.storage.put({ config, queue: [{ kind: "initial" }] satisfies RunReason[] });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Queues another run, e.g. after a reviewer requested changes or an approved intent conflicted. */
  async revise(revision: Revision): Promise<void> {
    const queue = (await this.ctx.storage.get<RunReason[]>("queue")) ?? [];
    await this.ctx.storage.put("queue", [...queue, revision]);
    this.cancelled = null;
    if (!this.running) await this.ctx.storage.setAlarm(Date.now());
  }

  /** A person's message: delivered on the next step of a running agent, or starts a new run. */
  async message(message: string, by: string): Promise<void> {
    if (this.running) {
      this.inbox.push({ message, by });
      this.step("message", `Message from ${by}`, message);
      return;
    }
    await this.revise({ kind: "message", message, by });
  }

  async cancel(reason: string): Promise<void> {
    this.cancelled = reason;
    await this.ctx.storage.put("queue", []);
    if (!this.running) {
      const config = await this.ctx.storage.get<AgentConfig>("config");
      if (config) {
        const coordinator = this.env.REPO.get(this.env.REPO.idFromName(config.repo));
        await coordinator.releaseLeases(config.agentId);
        this.step("status", "Cancelled", reason);
      }
    }
  }

  transcript(after = 0): TranscriptStep[] {
    return this.sql
      .exec<{ id: number; run: number; ts: number; kind: string; title: string; body: string | null; error: number }>(
        "SELECT * FROM steps WHERE id > ? ORDER BY id LIMIT 500",
        after,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        run: r.run,
        ts: r.ts,
        kind: r.kind as TranscriptStep["kind"],
        title: r.title,
        body: r.body,
        error: r.error === 1,
      }));
  }

  /** Records a transcript step for the current run. */
  step(kind: TranscriptStep["kind"], title: string, body?: string | null, error = false) {
    const run = this.currentRun;
    this.sql.exec(
      "INSERT INTO steps (run, ts, kind, title, body, error) VALUES (?, ?, ?, ?, ?, ?)",
      run,
      Date.now(),
      kind,
      title.slice(0, 300),
      body ? clip(body) : null,
      error ? 1 : 0,
    );
  }

  private currentRun = 0;

  /** Throws if a person cancelled the agent; checked between steps. */
  checkCancelled() {
    if (this.cancelled) throw new Cancelled(this.cancelled);
  }

  takeInbox() {
    const messages = this.inbox;
    this.inbox = [];
    return messages;
  }

  override async alarm(): Promise<void> {
    if (this.running) return;
    const config = await this.ctx.storage.get<AgentConfig>("config");
    const queue = (await this.ctx.storage.get<RunReason[]>("queue")) ?? [];
    const reason = queue.shift();
    if (!config || !reason) return;
    await this.ctx.storage.put("queue", queue);

    this.running = true;
    this.cancelled = null;
    this.currentRun = ((await this.ctx.storage.get<number>("runs")) ?? 0) + 1;
    await this.ctx.storage.put("runs", this.currentRun);
    const coordinator = this.env.REPO.get(this.env.REPO.idFromName(config.repo));
    try {
      const submission = await this.ctx.storage.get<Submission>("submission");
      const fresh =
        this.currentRun > 1 ? { ...config, ...(await coordinator.agentCredentials(config.agentId)) } : config;
      const run = new AgentRun(this, this.env, fresh, coordinator, reason, submission ?? null);
      const outcome = await run.run();
      if (run.submission) await this.ctx.storage.put("submission", run.submission);
      await coordinator.agentStatus(config.agentId, outcome.status, outcome.detail);
      this.step("status", outcome.detail);
    } catch (err) {
      const cancelled = err instanceof Cancelled;
      const message = err instanceof Error ? err.message : String(err);
      if (!cancelled) console.error(`agent ${config.agentId} failed`, err);
      this.step("status", cancelled ? "Cancelled" : "Failed", message, !cancelled);
      await coordinator.agentStatus(config.agentId, cancelled ? "cancelled" : "failed", message);
      await coordinator.releaseLeases(config.agentId);
    } finally {
      this.running = false;
      this.inbox = [];
    }
    const rest = (await this.ctx.storage.get<RunReason[]>("queue")) ?? [];
    if (rest.length) await this.ctx.storage.setAlarm(Date.now());
  }
}

class AgentRun {
  private host: HiveAgent;
  private env: Env;
  private config: AgentConfig;
  private coordinator: DurableObjectStub<RepoCoordinator>;
  private reason: RunReason;
  private previous: Submission | null;
  private client: Anthropic;
  private ctx: AgentContext = { leasesEnabled: true, mergeMode: "auto", checkCommand: "" };
  private snapshot: Workdir | null = null;
  /** Content of each file when the agent started working from it; the merge base. */
  private base = new Map<string, string | null>();
  /** Pending changes; null deletes the file. */
  private edits = new Map<string, string | null>();
  private held = new Set<string>();
  private intentId: string | undefined;
  private outcome: { status: AgentStatus; detail: string } | null = null;
  submission: Submission | null = null;

  constructor(
    host: HiveAgent,
    env: Env,
    config: AgentConfig,
    coordinator: DurableObjectStub<RepoCoordinator>,
    reason: RunReason,
    previous: Submission | null,
  ) {
    this.host = host;
    this.env = env;
    this.config = config;
    this.coordinator = coordinator;
    this.reason = reason;
    this.previous = previous;
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async run(): Promise<{ status: AgentStatus; detail: string }> {
    const { agentId } = this.config;
    this.ctx = await this.coordinator.agentContext();
    const prompt = await this.openingPrompt();
    this.host.step("run", this.reason.kind === "initial" ? "Started" : `Revision: ${this.reason.kind}`, prompt);
    const messages: BetaMessageParam[] = [{ role: "user", content: prompt }];

    for (let turn = 0; turn < MAX_TURNS && !this.outcome; turn++) {
      this.host.checkCancelled();
      await this.status(turn === 0 ? "planning" : this.edits.size ? "editing" : "reading", "thinking…");
      // Streaming keeps long generations under the SDK's request timeout.
      const response = await this.client.beta.messages
        .stream({
          model: this.env.HIVE_MODEL,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: this.env.HIVE_EFFORT as "low" | "medium" | "high" },
          system: systemPrompt(this.config, this.ctx),
          tools: TOOLS,
          messages,
        })
        .finalMessage();
      await this.coordinator.renewLeases(agentId);
      this.host.checkCancelled();

      if (response.stop_reason === "refusal") throw new Error("The model declined this task.");
      messages.push({ role: "assistant", content: response.content });
      for (const block of response.content) {
        if (block.type === "thinking" && block.thinking.trim()) this.host.step("thinking", "Thinking", block.thinking);
        if (block.type === "text" && block.text.trim()) this.host.step("text", "Note", block.text);
      }

      const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const followUp: BetaContentBlockParam[] = [];
      if (calls.length === 0) {
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
        if (this.edits.size === 0) {
          // A message that needed no code change (a question, or "looks fine") ends here.
          if (this.reason.kind === "message") return { status: "done", detail: clip(text || "replied", 200) };
          throw new Error("Stopped without making any changes.");
        }
        followUp.push({ type: "text", text: "You have unsubmitted changes. Call submit when the task is complete." });
      }

      for (const call of calls) {
        this.host.checkCancelled();
        const input = call.input as Record<string, unknown>;
        try {
          const content = await this.execute(call.name, input);
          this.host.step("tool", describeCall(call.name, input), content);
          followUp.push({ type: "tool_result", tool_use_id: call.id, content } satisfies BetaToolResultBlockParam);
        } catch (err) {
          if (err instanceof Cancelled) throw err;
          const message = err instanceof Error ? err.message : String(err);
          this.host.step("tool", describeCall(call.name, input), message, true);
          followUp.push({ type: "tool_result", tool_use_id: call.id, content: message, is_error: true });
        }
      }
      for (const m of this.host.takeInbox()) {
        followUp.push({ type: "text", text: `Message from ${m.by} (a person on this repository): ${m.message}` });
      }
      messages.push({ role: "user", content: followUp });
    }

    if (this.outcome) return this.outcome;
    throw new Error(`Gave up after ${MAX_TURNS} turns.`);
  }

  /** The first user message: the task, plus what happened before for a revision. */
  private async openingPrompt(): Promise<string> {
    const task = `Your task:\n${this.config.task}`;
    const reason = this.reason;
    if (reason.kind === "initial") return task;

    const prev = this.previous;
    const intent = prev ? await this.coordinator.getIntent(prev.intentId) : null;
    const resumable = prev && intent && ["review", "changes_requested", "replaying"].includes(intent.status);
    if (prev && resumable) {
      // Continue the same intent from the agent's own previous version of each file.
      this.intentId = prev.intentId;
      using fork = await this.env.ARTIFACTS.get(this.config.forkName);
      for (const f of prev.files) {
        const blob = await fork.readFile({ ref: prev.commit, path: f.path });
        this.edits.set(f.path, blob ? await blob.text() : null);
        this.base.set(f.path, f.base);
      }
    }
    const pending =
      prev && resumable
        ? `Your pending edits are your previous version of: ${prev.files.map((f) => f.path).join(", ")}.`
        : "";

    if (reason.kind === "conflict") {
      for (const c of reason.conflicts) this.base.set(c.path, c.main);
      return [
        task,
        "",
        `Your intent "${prev?.summary}" was approved, but conflicts with changes that landed since you wrote it.`,
        pending,
        "Re-apply your intent on top of the current versions below (keep their changes): lease the files, edit them, and submit again with the same summary.",
        "",
        ...reason.conflicts.map((c) => fence(c.path, c.main)),
      ].join("\n");
    }
    if (reason.kind === "check") {
      return [
        task,
        "",
        `Your intent "${prev?.summary}" was approved, but the repository's checks failed on the merged result.`,
        `Command: ${reason.command}`,
        "",
        "Output (end):",
        "```",
        reason.log.slice(-6000),
        "```",
        "",
        pending,
        "Fix the problem (lease, edit, submit again with the same summary).",
      ].join("\n");
    }
    if (reason.kind === "changes") {
      return [
        task,
        "",
        `A reviewer (${reason.by}) requested changes to your intent "${prev?.summary}":`,
        reason.comment,
        "",
        pending,
        "Lease the files you need, make the requested changes, and submit again.",
      ].join("\n");
    }
    const status = intent ? `Your last intent "${prev?.summary}" is ${intent.status.replace("_", " ")}.` : "";
    return [
      task,
      "",
      status,
      `${reason.by}, a person on this repository, sent you a message:`,
      reason.message,
      "",
      pending,
      "If it asks for changes, make them (lease, edit, submit). If it only asks a question, answer briefly without tools.",
    ].join("\n");
  }

  private async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const str = (key: string) => (typeof input[key] === "string" ? input[key] : "");
    const num = (key: string) => (typeof input[key] === "number" ? input[key] : undefined);
    switch (name) {
      case "list_files":
        return this.listFiles(str("prefix"));
      case "search":
        return this.search(str("pattern"), str("prefix"));
      case "read_file":
        return this.readFile(str("path"), num("start_line"), num("end_line"));
      case "request_lease":
        return this.requestLease(str("path"), str("reason"), input.wait === true);
      case "edit_file":
        return this.editFile(str("path"), str("old_string"), str("new_string"), input.replace_all === true);
      case "write_file":
        return this.writeFile(str("path"), str("content"));
      case "delete_file":
        return this.deleteFile(str("path"));
      case "submit":
        return this.submit(str("summary"));
      default:
        throw new Error(`Unknown tool ${name}.`);
    }
  }

  /** A shallow checkout of the default branch for listing and searching. */
  private async tree(): Promise<Workdir> {
    this.snapshot ??= await cloneRepo(this.config.main, this.config.branch);
    return this.snapshot;
  }

  private async listFiles(prefix: string): Promise<string> {
    const all = await listFiles(await this.tree());
    const paths = new Set(all.filter((p) => p.startsWith(prefix)));
    for (const [path, content] of this.edits) {
      if (content === null) paths.delete(path);
      else if (path.startsWith(prefix)) paths.add(path);
    }
    const list = [...paths].sort();
    return list.length > 2000 ? `${list.slice(0, 2000).join("\n")}\n… ${list.length - 2000} more` : list.join("\n");
  }

  private async search(pattern: string, prefix: string): Promise<string> {
    await this.status(this.edits.size ? "editing" : "reading", `searching ${pattern}`);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const { matches, truncated } = await search(await this.tree(), regex, { prefix: prefix || undefined, limit: 100 });
    if (matches.length === 0) return "No matches.";
    return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") + (truncated ? "\n… more matches" : "");
  }

  private async readMain(path: string): Promise<string | null> {
    using repo = await this.env.ARTIFACTS.get(this.config.repo);
    const blob = await repo.readFile({ ref: this.config.branch, path });
    return blob ? blob.text() : null;
  }

  /** The agent's current view: its pending edit, else the latest version on the default branch. */
  private async current(path: string): Promise<string | null> {
    if (this.edits.has(path)) return this.edits.get(path)!;
    const content = await this.readMain(path);
    if (!this.base.has(path)) this.base.set(path, content);
    return content;
  }

  private async readFile(path: string, start?: number, end?: number): Promise<string> {
    await this.status(this.edits.size ? "editing" : "reading", `reading ${path}`);
    const content = await this.current(path);
    if (content === null) throw new Error(`${path} does not exist.`);
    const lines = content.split("\n");
    const from = Math.max(1, start ?? 1);
    let to = Math.min(lines.length, end ?? lines.length);
    let slice = lines.slice(from - 1, to).join("\n");
    if (slice.length > MAX_READ_CHARS) {
      slice = slice.slice(0, MAX_READ_CHARS);
      to = from + slice.split("\n").length - 1;
      return `${numbered(slice, from)}\n\n[truncated at line ${to} of ${lines.length}; read further with start_line]`;
    }
    const range = from > 1 || to < lines.length ? ` (lines ${from}-${to} of ${lines.length})` : "";
    return `${path}${range}\n${numbered(slice, from)}`;
  }

  private async requestLease(path: string, reason: string, wait: boolean): Promise<string> {
    const { agentId } = this.config;
    const deadline = Date.now() + LEASE_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      this.host.checkCancelled();
      const result = await this.coordinator.requestLease(agentId, { path }, reason, attempt > 0);
      if (result.ok) break;
      const who = `${result.holder.holderName} (${result.holder.reason})`;
      if (!wait) {
        return `Lease denied: ${path} is held by ${who}. Work on other files first, or call request_lease with wait=true.`;
      }
      if (Date.now() > deadline) return `Still waiting: ${path} is held by ${who}. Try again later.`;
      await this.status("waiting", `waiting for ${path} (held by ${result.holder.holderName})`);
      await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }

    this.held.add(path);
    await this.status("editing", `leased ${path}`);
    if (this.edits.has(path)) return `Lease granted on ${path}. Your pending edit is kept.`;
    // The lease is the moment the agent's view of the file becomes authoritative.
    const content = await this.readMain(path);
    this.base.set(path, content);
    const note = this.ctx.leasesEnabled ? "Lease granted" : "Leases are off in this repo, go ahead";
    return `${note}. Current content:\n\n${fence(path, content === null ? null : numbered(content))}`;
  }

  private requireLease(path: string) {
    if (!path) throw new Error("path is required.");
    if (this.ctx.leasesEnabled && !this.held.has(path)) {
      throw new Error(`You do not hold a lease on ${path}. Call request_lease first.`);
    }
  }

  private async setEdit(path: string, content: string | null) {
    if (!this.base.has(path)) this.base.set(path, await this.readMain(path));
    this.edits.set(path, content);
  }

  private async editFile(path: string, oldString: string, newString: string, all: boolean): Promise<string> {
    this.requireLease(path);
    const content = await this.current(path);
    if (content === null) throw new Error(`${path} does not exist. Use write_file to create it.`);
    if (!oldString) throw new Error("old_string is empty.");
    const count = content.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string was not found in ${path}. Read the file again and copy it exactly.`);
    if (count > 1 && !all) {
      throw new Error(`old_string matches ${count} places in ${path}. Add surrounding lines or set replace_all.`);
    }
    const next = all ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
    await this.setEdit(path, next);
    await this.status("editing", `edited ${path}`);
    return `Edited ${path} (${count} replacement${count > 1 ? "s" : ""}).`;
  }

  private async writeFile(path: string, content: string): Promise<string> {
    this.requireLease(path);
    await this.setEdit(path, content);
    await this.status("editing", `wrote ${path}`);
    return `Wrote ${path} (${content.split("\n").length} lines).`;
  }

  private async deleteFile(path: string): Promise<string> {
    this.requireLease(path);
    if ((await this.current(path)) === null) throw new Error(`${path} does not exist.`);
    await this.setEdit(path, null);
    await this.status("editing", `deleted ${path}`);
    return `Deleted ${path}.`;
  }

  private async submit(summary: string): Promise<string> {
    // Drop no-op edits (e.g. a file rewritten to its original content).
    for (const [path, content] of this.edits) if (this.base.get(path) === content) this.edits.delete(path);
    if (this.edits.size === 0) throw new Error("Nothing to submit: your edits do not change anything.");
    if (!summary.trim()) throw new Error("summary is required.");
    const { agentId, name, main, fork, branch } = this.config;

    await this.status("submitting", `committing to ${this.config.forkName}`);
    const wd = await cloneRepo(fork, branch);
    await resetTo(wd, await fetchFrom(wd, "upstream", main, branch));
    const commit = await writeAndCommit(wd, Object.fromEntries(this.edits), summary, {
      name,
      email: `${agentId}@agents.hive.dev`,
    });
    await push(wd, fork, { force: true });

    const files = [...this.edits.keys()].map((path) => ({ path, base: this.base.get(path) ?? null }));
    await this.status("queued", this.ctx.mergeMode === "review" ? "submitting for review" : "in merge queue");
    const result = await this.coordinator.submitIntent(agentId, { intentId: this.intentId, summary, commit, files });
    this.intentId = result.intentId;
    this.submission = { intentId: result.intentId, summary, commit, files };

    switch (result.status) {
      case "merged":
        this.outcome = { status: "done", detail: `merged as ${result.commit.slice(0, 7)}` };
        return `Merged as ${result.commit.slice(0, 7)}.`;
      case "review":
        this.outcome = { status: "review", detail: "awaiting review" };
        return "Submitted for review.";
      case "rejected":
        this.outcome = { status: "failed", detail: result.reason };
        return `Rejected: ${result.reason}.`;
      case "check_failed":
        await this.status("replaying", "checks failed");
        // The rejected tree did not land: keep building on the same base.
        return [
          `The repository's checks failed on the merged result. Command: ${result.command}`,
          "",
          "Output (end):",
          "```",
          result.log.slice(-6000),
          "```",
          "",
          "Fix the problem: your pending edits are kept. Edit the files (you still hold your leases if you renew them with request_lease), then call submit again with the same summary.",
        ].join("\n");
      case "conflict":
        await this.status("replaying", `conflict in ${result.conflicts.map((c) => c.path).join(", ")}`);
        for (const conflict of result.conflicts) this.base.set(conflict.path, conflict.main);
        return [
          "Merge conflict: others changed these files after you read them.",
          "Re-apply your intent on top of the current versions below (keep their changes), edit or write each file again, then call submit again with the same summary.",
          "",
          ...result.conflicts.map((c) => fence(c.path, c.main)),
        ].join("\n");
    }
  }

  private async status(status: AgentStatus, detail: string) {
    await this.coordinator.agentStatus(this.config.agentId, status, detail);
  }
}

function describeCall(name: string, input: Record<string, unknown>) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const n = (k: string) => (typeof input[k] === "number" ? String(input[k]) : "");
  switch (name) {
    case "list_files":
      return `list_files ${s("prefix")}`.trim();
    case "search":
      return `search /${s("pattern")}/${s("prefix") ? ` in ${s("prefix")}` : ""}`;
    case "read_file":
      return `read_file ${s("path")}${n("start_line") ? `:${n("start_line")}-${n("end_line")}` : ""}`;
    case "request_lease":
      return `request_lease ${s("path")}${input.wait ? " (wait)" : ""}`;
    case "edit_file":
      return `edit_file ${s("path")}`;
    case "write_file":
      return `write_file ${s("path")}`;
    case "delete_file":
      return `delete_file ${s("path")}`;
    case "submit":
      return `submit “${s("summary")}”`;
    default:
      return name;
  }
}
