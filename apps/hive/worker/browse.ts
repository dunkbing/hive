// Read-only repository browsing straight from the Artifacts binding: refs, trees, blobs, history and diffs.

import type { CommitDetail, CommitSummary, FileChange, Tree, TreeEntry } from "@hive/core";

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

/** A commit and the files it changed relative to its first parent. Unchanged subtrees are skipped by hash. */
export async function commitDetail(repo: ArtifactsRepo, sha: string): Promise<CommitDetail | null> {
  const commit = await repo.readCommit(sha);
  if (!commit) return null;
  const parent = commit.parents[0] ? await repo.readCommit(commit.parents[0]) : null;

  const changes: { path: string; before?: string; after?: string }[] = [];
  const walk = async (prefix: string, beforeTree: string | undefined, afterTree: string | undefined) => {
    if (beforeTree === afterTree || changes.length > MAX_DIFF_FILES) return;
    const [before, after] = await Promise.all([
      beforeTree ? repo.readTree(beforeTree) : Promise.resolve([]),
      afterTree ? repo.readTree(afterTree) : Promise.resolve([]),
    ]);
    const names = new Set([...(before ?? []), ...(after ?? [])].map((e) => e.name));
    const subtrees: Promise<void>[] = [];
    for (const name of [...names].sort()) {
      const b = before?.find((e) => e.name === name);
      const a = after?.find((e) => e.name === name);
      if (b?.hash === a?.hash) continue;
      const path = prefix + name;
      const bTree = b?.type === "tree" ? b.hash : undefined;
      const aTree = a?.type === "tree" ? a.hash : undefined;
      if (bTree || aTree) subtrees.push(walk(`${path}/`, bTree, aTree));
      const bBlob = b && b.type !== "tree" ? b.hash : undefined;
      const aBlob = a && a.type !== "tree" ? a.hash : undefined;
      if (bBlob || aBlob) changes.push({ path, before: bBlob, after: aBlob });
    }
    await Promise.all(subtrees);
  };
  await walk("", parent?.treeHash, commit.treeHash);

  const truncated = changes.length > MAX_DIFF_FILES;
  const files = await Promise.all(
    changes
      .sort((x, y) => x.path.localeCompare(y.path))
      .slice(0, MAX_DIFF_FILES)
      .map(async ({ path, before, after }): Promise<FileChange> => {
        const none: Awaited<ReturnType<typeof blobText>> = { text: null };
        const [b, a] = await Promise.all([
          before ? blobText(repo, before) : none,
          after ? blobText(repo, after) : none,
        ]);
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
