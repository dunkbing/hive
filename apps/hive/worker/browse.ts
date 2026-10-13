// Read-only repository browsing straight from the Artifacts binding: refs, trees, blobs, history and diffs.

import type { CommitDetail, CommitSummary, FileChange, Tree, TreeEntry } from "@hive/core";
import { diffArrays } from "diff";

const MAX_TREE_ENTRIES = 5000;
const MAX_DIFF_FILES = 60;
const MAX_DIFF_BYTES = 256 * 1024;

const SHA = /^[0-9a-f]{40}$/;

function summarize(c: ArtifactsCommitMetadata): CommitSummary {
  return {
    sha: c.hash,
    message: c.message,
    author: c.author.name,
    email: c.author.email,
    at: c.committedAt * 1000,
    parents: c.parents,
  };
}

export async function resolveRef(repo: ArtifactsRepo, ref: string): Promise<string | null> {
  if (SHA.test(ref)) return ref;
  const [head] = await repo.log({ ref, limit: 1 });
  return head?.hash ?? null;
}

export async function log(repo: ArtifactsRepo, ref: string, limit: number, offset: number): Promise<CommitSummary[]> {
  return (await repo.log({ ref, limit, offset })).map(summarize);
}

/** Every path in the tree at `ref`, directories included. */
export async function listTree(repo: ArtifactsRepo, ref: string): Promise<Tree | null> {
  const sha = await resolveRef(repo, ref);
  const commit = sha ? await repo.readCommit(sha) : null;
  if (!sha || !commit) return null;

  const entries: TreeEntry[] = [];
  let level: { prefix: string; hash: string }[] = [{ prefix: "", hash: commit.treeHash }];
  while (level.length && entries.length < MAX_TREE_ENTRIES) {
    const trees = await Promise.all(level.map(async (t) => ({ ...t, children: (await repo.readTree(t.hash)) ?? [] })));
    level = [];
    for (const tree of trees) {
      for (const child of tree.children) {
        const path = tree.prefix + child.name;
        if (child.type === "tree") {
          entries.push({ path, type: "tree" });
          level.push({ prefix: `${path}/`, hash: child.hash });
        } else if (child.type === "blob" || child.type === "exec" || child.type === "symlink") {
          entries.push({ path, type: "blob" });
        }
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { sha, entries: entries.slice(0, MAX_TREE_ENTRIES), truncated: entries.length >= MAX_TREE_ENTRIES };
}

async function blobText(
  repo: ArtifactsRepo,
  hash: string,
): Promise<{ text: string | null; omitted?: FileChange["omitted"] }> {
  const blob = await repo.readBlob(hash);
  if (!blob) return { text: null };
  if (blob.size > MAX_DIFF_BYTES) return { text: null, omitted: "too-large" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.subarray(0, 8000).includes(0)) return { text: null, omitted: "binary" };
  return { text: new TextDecoder().decode(bytes) };
}

export interface TreeChange {
  path: string;
  /** Blob ids before and after; undefined when the file did not exist on that side. */
  before?: string;
  after?: string;
  /** Git mode on the "after" side, e.g. 100644 or 100755. */
  mode?: string;
}

/** Files that differ between two trees. Unchanged subtrees are skipped by hash, so this is cheap for small diffs. */
export async function diffTrees(
  repo: ArtifactsRepo,
  beforeTree: string | undefined,
  afterTree: string | undefined,
  limit = Infinity,
): Promise<TreeChange[]> {
  const changes: TreeChange[] = [];
  const walk = async (prefix: string, bTreeHash: string | undefined, aTreeHash: string | undefined) => {
    if (bTreeHash === aTreeHash || changes.length > limit) return;
    const [before, after] = await Promise.all([
      bTreeHash ? repo.readTree(bTreeHash) : Promise.resolve([]),
      aTreeHash ? repo.readTree(aTreeHash) : Promise.resolve([]),
    ]);
    const names = new Set([...(before ?? []), ...(after ?? [])].map((e) => e.name));
    const subtrees: Promise<void>[] = [];
    for (const name of [...names].sort()) {
      const b = before?.find((e) => e.name === name);
      const a = after?.find((e) => e.name === name);
      if (b?.hash === a?.hash && b?.mode === a?.mode) continue;
      const path = prefix + name;
      const bTree = b?.type === "tree" ? b.hash : undefined;
      const aTree = a?.type === "tree" ? a.hash : undefined;
      if (bTree || aTree) subtrees.push(walk(`${path}/`, bTree, aTree));
      const bBlob = b && b.type !== "tree" && b.type !== "gitlink" ? b.hash : undefined;
      const aBlob = a && a.type !== "tree" && a.type !== "gitlink" ? a.hash : undefined;
      if (bBlob || aBlob) changes.push({ path, before: bBlob, after: aBlob, mode: aBlob ? a!.mode : undefined });
    }
    await Promise.all(subtrees);
  };
  await walk("", beforeTree, afterTree);
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/** A commit and the files it changed relative to its first parent. */
export async function commitDetail(repo: ArtifactsRepo, sha: string): Promise<CommitDetail | null> {
  const commit = await repo.readCommit(sha);
  if (!commit) return null;
  const parent = commit.parents[0] ? await repo.readCommit(commit.parents[0]) : null;
  const changes = await diffTrees(repo, parent?.treeHash, commit.treeHash, MAX_DIFF_FILES);

  const truncated = changes.length > MAX_DIFF_FILES;
  const files = await Promise.all(
    changes.slice(0, MAX_DIFF_FILES).map(async ({ path, before, after }): Promise<FileChange> => {
      const none: Awaited<ReturnType<typeof blobText>> = { text: null };
      const [b, a] = await Promise.all([before ? blobText(repo, before) : none, after ? blobText(repo, after) : none]);
      return {
        path,
        status: !before ? "added" : !after ? "deleted" : "modified",
        before: b.text,
        after: a.text,
        omitted: b.omitted ?? a.omitted,
      };
    }),
  );
  return { commit: summarize(commit), files, truncated };
}

export interface Blame {
  commits: CommitSummary[];
  lines: number[];
  /** True when history was cut off; the oldest lines are attributed to the oldest commit read. */
  truncated: boolean;
}

/**
 * Line-by-line authorship of a file on `ref`, from its first-parent history (up to `depth` commits).
 * Walks oldest to newest and carries each line's origin through line diffs.
 */
export async function blame(repo: ArtifactsRepo, ref: string, path: string, depth = 80): Promise<Blame | null> {
  const history = await repo.log({ ref, limit: depth });
  if (!history.length) return null;
  const versions: { commit: ArtifactsCommitMetadata; text: string | null }[] = [];
  // Newest first; stop once the file did not exist.
  for (const commit of history) {
    const blob = await repo.readFile({ ref: commit.hash, path });
    const text = blob ? await blob.text() : null;
    versions.push({ commit, text });
    if (text === null) break;
  }
  if (versions[0].text === null) return null;
  const truncated = versions[versions.length - 1].text !== null && history.length === depth;

  const commits: CommitSummary[] = [];
  let lines: number[] = [];
  let previous: string[] = [];
  for (const { commit, text } of versions.reverse()) {
    if (text === null) continue;
    const current = text.split("\n");
    if (lines.length && current.join("\n") === previous.join("\n")) continue;
    commits.push(summarize(commit));
    const index = commits.length - 1;
    const next: number[] = [];
    let i = 0;
    for (const part of diffArrays(previous, current)) {
      if (part.removed) {
        i += part.count ?? part.value.length;
      } else if (part.added) {
        for (let k = 0; k < (part.count ?? part.value.length); k++) next.push(index);
      } else {
        for (let k = 0; k < (part.count ?? part.value.length); k++) next.push(lines[i++] ?? index);
      }
    }
    lines = next;
    previous = current;
  }
  return { commits, lines, truncated };
}
