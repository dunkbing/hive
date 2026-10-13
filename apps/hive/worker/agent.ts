import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentStatus } from "@hive/core";
import { DurableObject } from "cloudflare:workers";
import type { JoinResult, RepoCoordinator } from "./coordinator.ts";
import { cloneRepo, fetchFrom, push, resetTo, writeAndCommit } from "./git.ts";

const MAX_TURNS = 40;
const LEASE_WAIT_MS = 150_000;
const LEASE_POLL_MS = 3_000;
const MAX_READ_BYTES = 120_000;

export interface AgentConfig extends JoinResult {
  repo: string;
  agentId: string;
  name: string;
  task: string;
}

const TOOLS: BetaTool[] = [
  {
    name: "list_files",
    description: "List every file path in the repository's default branch.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description:
      "Read a file. Returns your pending edit if you have written the file, otherwise the latest version on the default branch.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repository-relative path, e.g. src/store.ts" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "request_lease",
    description:
      "Ask for an exclusive lease on a file before modifying it (including files you create). A granted lease returns the latest content of the file. If another agent holds the file, the lease is denied; either work on other files first or call again with wait=true to queue until it is free.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string", description: "A few words on what you will change, shown to other agents." },
        wait: { type: "boolean", description: "Block until the lease is free (up to ~2 minutes)." },
      },
      required: ["path", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Replace the full content of a file you hold a lease on. Always write the complete file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "submit",
    description:
      "Commit your written files and submit them to the merge queue with a one-sentence intent describing the change. Call once when your task is done.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence, imperative mood, e.g. 'Add pagination to GET /todos'." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

function systemPrompt(config: AgentConfig) {
  const about = config.description ? `\n\nAbout this repository: ${config.description}` : "";
  return `You are ${config.name}, one of several AI agents changing the same git repository at the same time through Hive.${about}

How Hive works:
- Start by exploring: list_files, then read the files relevant to your task.
- Before modifying or creating a file, call request_lease on it. A lease gives you exclusive edit rights and the latest content of that file. Other agents' leases block you; when that happens, do other parts of your task first, then call request_lease again with wait=true.
- Lease only files you will change, and keep the change minimal and focused on your task. Match the existing code style. Do not reformat or refactor unrelated code; other agents are changing nearby code.
- write_file replaces the whole file, so always write the complete content.
- When your change is complete, call submit with a one-sentence intent. If the merge queue reports a conflict, re-apply your intent on top of the current file versions it shows you, write the files again and submit again.
- There is no human to ask and no way to run code. Work it out from the code.`;
}

function fence(path: string, content: string | null) {
  return content === null ? `${path} does not exist yet.` : `### ${path}\n\`\`\`\n${content}\n\`\`\``;
}

/** An autonomous coding agent. Each agent lives in its own Durable Object and runs from an alarm. */
export class HiveAgent extends DurableObject<Env> {
  async start(config: AgentConfig): Promise<void> {
    await this.ctx.storage.put({ config, done: false });
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const config = await this.ctx.storage.get<AgentConfig>("config");
    if (!config || (await this.ctx.storage.get<boolean>("done"))) return;
    await this.ctx.storage.put("done", true);
    const coordinator = this.env.REPO.get(this.env.REPO.idFromName(config.repo));
    try {
      await new AgentRun(this.env, config, coordinator).run();
    } catch (err) {
      console.error(`agent ${config.agentId} failed`, err);
      await coordinator.agentStatus(config.agentId, "failed", err instanceof Error ? err.message : String(err));
      await coordinator.releaseLeases(config.agentId);
    }
  }
}

class AgentRun {
  private env: Env;
  private config: AgentConfig;
  private coordinator: DurableObjectStub<RepoCoordinator>;
  private client: Anthropic;
  /** Content of each file when the agent started working from it; the merge base. */
  private base = new Map<string, string | null>();
  private edits = new Map<string, string>();
  private held = new Set<string>();
  private intentId: string | undefined;
  private leasesEnabled = true;
  private finished: "merged" | "rejected" | null = null;

  constructor(env: Env, config: AgentConfig, coordinator: DurableObjectStub<RepoCoordinator>) {
    this.env = env;
    this.config = config;
    this.coordinator = coordinator;
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async run() {
    const { agentId } = this.config;
    this.leasesEnabled = await this.coordinator.leasesEnabled();
    const messages: BetaMessageParam[] = [{ role: "user", content: `Your task:\n${this.config.task}` }];

    for (let turn = 0; turn < MAX_TURNS && !this.finished; turn++) {
      await this.status(turn === 0 ? "planning" : this.edits.size ? "editing" : "reading", "thinking…");
      const response = await this.client.beta.messages.create({
        model: this.env.HIVE_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.env.HIVE_EFFORT as "low" | "medium" | "high" },
        system: systemPrompt(this.config),
        tools: TOOLS,
        messages,
      });
      await this.coordinator.renewLeases(agentId);

      if (response.stop_reason === "refusal") throw new Error("model refused the task");
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) {
        if (this.edits.size === 0) throw new Error("stopped without making changes");
        messages.push({
          role: "user",
          content: "You have unsubmitted changes. Call submit when your task is complete.",
        });
        continue;
      }

      const results: BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          const content = await this.execute(call.name, call.input as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: call.id, content });
        } catch (err) {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: err instanceof Error ? err.message : String(err),
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: results });
    }

    if (this.finished === "merged") await this.status("done", "merged");
    else if (this.finished === "rejected") await this.status("failed", "intent rejected");
    else throw new Error(`gave up after ${MAX_TURNS} turns`);
  }

  private async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const str = (key: string) => (typeof input[key] === "string" ? input[key] : "");
    switch (name) {
      case "list_files":
        return (await this.coordinator.listMainFiles()).join("\n");
      case "read_file":
        return this.readFile(str("path"));
      case "request_lease":
        return this.requestLease(str("path"), str("reason"), input.wait === true);
      case "write_file":
        return this.writeFile(str("path"), str("content"));
      case "submit":
        return this.submit(str("summary"));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private async readMain(path: string): Promise<string | null> {
    using repo = await this.env.ARTIFACTS.get(this.config.repo);
    const blob = await repo.readFile({ ref: this.config.branch, path });
    return blob ? blob.text() : null;
  }

  private async readFile(path: string): Promise<string> {
    await this.status(this.edits.size ? "editing" : "reading", `reading ${path}`);
    const pending = this.edits.get(path);
    if (pending !== undefined) return pending;
    const content = await this.readMain(path);
    if (!this.base.has(path)) this.base.set(path, content);
    if (content === null) throw new Error(`${path} does not exist`);
    if (content.length > MAX_READ_BYTES) {
      return `${content.slice(0, MAX_READ_BYTES)}\n\n[truncated: ${path} is ${content.length} bytes; only the first ${MAX_READ_BYTES} are shown]`;
    }
    return content;
  }

  private async requestLease(path: string, reason: string, wait: boolean): Promise<string> {
    const { agentId } = this.config;
    const deadline = Date.now() + LEASE_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      const result = await this.coordinator.requestLease(agentId, { path }, reason, attempt > 0);
      if (result.ok) break;
      const who = `${result.holderName} (${result.holder.reason})`;
      if (!wait)
        return `Lease denied: ${path} is held by ${who}. Work on other files first, or call request_lease with wait=true.`;
      if (Date.now() > deadline) return `Still waiting: ${path} is held by ${who}. Try again later.`;
      await this.status("waiting", `waiting for ${path} (held by ${result.holderName})`);
      await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }

    this.held.add(path);
    await this.status("editing", `leased ${path}`);
    if (this.edits.has(path)) return `Lease granted on ${path}.`;
    // The lease is the moment the agent's view of the file becomes authoritative.
    const content = await this.readMain(path);
    this.base.set(path, content);
    const note = this.leasesEnabled ? "Lease granted" : "Leases are disabled in this repo, go ahead";
    return `${note}. Current content:\n\n${fence(path, content)}`;
  }

  private async writeFile(path: string, content: string): Promise<string> {
    if (this.leasesEnabled && !this.held.has(path)) {
      throw new Error(`You do not hold a lease on ${path}. Call request_lease first.`);
    }
    if (!this.base.has(path)) this.base.set(path, await this.readMain(path));
    this.edits.set(path, content);
    await this.status("editing", `wrote ${path}`);
    return `Wrote ${path} (${content.split("\n").length} lines). Call submit when your whole task is done.`;
  }

  private async submit(summary: string): Promise<string> {
    if (this.edits.size === 0) throw new Error("Nothing to submit: write at least one file first.");
    const { agentId, name, main, fork } = this.config;

    await this.status("submitting", `committing to ${this.config.forkName}`);
    const wd = await cloneRepo(fork, this.config.branch);
    await resetTo(wd, await fetchFrom(wd, "upstream", main, this.config.branch));
    const commit = await writeAndCommit(wd, Object.fromEntries(this.edits), summary, {
      name,
      email: `${agentId}@agents.hive.dev`,
    });
    await push(wd, fork, { force: true });

    await this.status("queued", "in merge queue");
    const files = [...this.edits.keys()].map((path) => ({ path, base: this.base.get(path) ?? null }));
    const result = await this.coordinator.submitIntent(agentId, { intentId: this.intentId, summary, commit, files });
    this.intentId = result.intentId;

    if (result.status === "merged") {
      this.finished = "merged";
      return `Merged as ${result.commit.slice(0, 7)}.`;
    }
    if (result.status === "rejected") {
      this.finished = "rejected";
      return `Rejected: ${result.reason}.`;
    }

    await this.status("replaying", `conflict in ${result.conflicts.map((c) => c.path).join(", ")}`);
    for (const conflict of result.conflicts) this.base.set(conflict.path, conflict.main);
    return [
      "Merge conflict: other agents changed these files after you read them.",
      "Re-apply your intent on top of the current versions below (keep their changes), write each file again, then call submit again with the same summary.",
      "",
      ...result.conflicts.map((c) => fence(c.path, c.main)),
    ].join("\n");
  }

  private async status(status: AgentStatus, detail: string) {
    await this.coordinator.agentStatus(this.config.agentId, status, detail);
  }
}
