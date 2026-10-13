import { merge } from "node-diff3";

export type FileMergeResult =
  | { clean: true; text: string; mode: "unchanged" | "fast-forward" | "auto-merge" }
  | { clean: false; text: string };

/**
 * Three-way merge of a single file.
 *
 * `base` is what the agent started from, `main` is what is on main now and
 * `agent` is what the agent wants. `null` means the file does not exist.
 */
export function mergeFile(base: string | null, main: string | null, agent: string | null): FileMergeResult {
  if (main === agent) return { clean: true, text: agent ?? "", mode: "unchanged" };
  if (base === main) return { clean: true, text: agent ?? "", mode: "fast-forward" };
  if (base === agent) return { clean: true, text: main ?? "", mode: "unchanged" };

  const result = merge((main ?? "").split("\n"), (base ?? "").split("\n"), (agent ?? "").split("\n"), {
    excludeFalseConflicts: true,
    label: { a: "main", b: "agent" },
  });
  const text = result.result.join("\n");
  return result.conflict ? { clean: false, text } : { clean: true, text, mode: "auto-merge" };
}
