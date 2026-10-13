import { merge } from "node-diff3";

/** `text: null` means the file should not exist. */
export type FileMergeResult =
  | { clean: true; text: string | null; mode: "unchanged" | "fast-forward" | "auto-merge" }
  | { clean: false; text: string };

/**
 * Three-way merge of a single file.
 *
 * `base` is what the agent started from, `main` is what is on the default branch now and `agent` is what the agent
 * wants. `null` means the file does not exist (not yet created, or deleted).
 */
export function mergeFile(base: string | null, main: string | null, agent: string | null): FileMergeResult {
  if (main === agent) return { clean: true, text: agent, mode: "unchanged" };
  if (base === main) return { clean: true, text: agent, mode: "fast-forward" };
  if (base === agent) return { clean: true, text: main, mode: "unchanged" };
  // One side deleted the file while the other changed it: there is no line-level answer.
  if (main === null || agent === null) {
    return { clean: false, text: main ?? agent ?? "" };
  }

  const result = merge(main.split("\n"), (base ?? "").split("\n"), agent.split("\n"), {
    excludeFalseConflicts: true,
    label: { a: "main", b: "agent" },
  });
  const text = result.result.join("\n");
  return result.conflict ? { clean: false, text } : { clean: true, text, mode: "auto-merge" };
}
