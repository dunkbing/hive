import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Plan } from "@hive/core";
import type { RepoCoordinator } from "./coordinator.ts";

const MAX_TURNS = 16;
const MAX_READ_CHARS = 60_000;

const TOOLS: BetaTool[] = [
  {
    name: "list_files",
    description: "List file paths on the default branch, optionally under a directory prefix.",
    input_schema: { type: "object", properties: { prefix: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "search",
    description: "Search file contents with a case-insensitive regular expression.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a file on the default branch.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_plan",
    description: "Submit the plan. Call exactly once, when you understand the codebase well enough.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One or two sentences on the approach." },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short kebab-case agent name, e.g. 'session-store'." },
              task: {
                type: "string",
                description: "Self-contained instructions for one agent: what to change, where, and what done means.",
              },
              files: {
                type: "array",
                items: { type: "string" },
                description: "Files this task will change or create.",
              },
            },
            required: ["name", "task", "files"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "tasks"],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You plan work for a team of AI coding agents that will change one git repository at the same time.

Given a goal, explore the repository (list_files, search, read_file), then call propose_plan with 1 to 8 tasks.

Good plans:
- Split the goal into tasks that can run in parallel, one agent each. Prefer tasks that touch different files; when two tasks must touch the same file, say so in both, since agents take turns on a file.
- Make every task self-contained: an agent sees only its own task text plus the code. Name the files, functions and conventions it should follow, and what "done" means.
- Keep the number of tasks proportional to the goal. A small goal is one task.
- Do not plan tests that need running code; agents cannot run code.`;

/** Turns a goal into parallel agent tasks by exploring the repo with read-only tools. */
export async function planGoal(
  env: Env,
  coordinator: DurableObjectStub<RepoCoordinator>,
  repo: { id: string; branch: string; description: string },
  goal: string,
): Promise<Plan> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const about = repo.description ? `Repository description: ${repo.description}\n\n` : "";
  const messages: BetaMessageParam[] = [{ role: "user", content: `${about}Goal:\n${goal}` }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages
      .stream({
        model: env.HIVE_MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      })
      .finalMessage();
    if (response.stop_reason === "refusal") throw new Error("The model declined to plan this goal.");
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    const plan = calls.find((c) => c.name === "propose_plan");
    if (plan) return normalize(plan.input as Plan);
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Call propose_plan with your plan." });
      continue;
    }

    const results: BetaContentBlockParam[] = [];
    for (const call of calls) {
      const input = call.input as Record<string, string | undefined>;
      let content: string;
      let isError = false;
      try {
        content = await runTool(env, coordinator, repo, call.name, input);
      } catch (err) {
        content = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("The planner did not produce a plan. Try a more specific goal.");
}

async function runTool(
  env: Env,
  coordinator: DurableObjectStub<RepoCoordinator>,
  repo: { id: string; branch: string },
  name: string,
  input: Record<string, string | undefined>,
): Promise<string> {
  switch (name) {
    case "list_files": {
      const files = (await coordinator.listMainFiles()).filter((p) => p.startsWith(input.prefix ?? ""));
      return files.length > 1500
        ? `${files.slice(0, 1500).join("\n")}\n… ${files.length - 1500} more`
        : files.join("\n");
    }
    case "search": {
      const { matches, truncated } = await coordinator.searchMain(input.pattern ?? "");
      if (!matches.length) return "No matches.";
      return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") + (truncated ? "\n… more" : "");
    }
    case "read_file": {
      using art = await env.ARTIFACTS.get(repo.id);
      const blob = await art.readFile({ ref: repo.branch, path: input.path ?? "" });
      if (!blob) throw new Error(`${input.path} does not exist.`);
      const text = await blob.text();
      return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[truncated]` : text;
    }
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}

function normalize(plan: Plan): Plan {
  const used = new Set<string>();
  const tasks = plan.tasks.slice(0, 8).map((t, i) => {
    let name =
      t.name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || `task-${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 21)}-${i + 1}`;
    used.add(name);
    return { name, task: t.task.trim(), files: t.files.slice(0, 30) };
  });
  return { summary: plan.summary, tasks };
}
