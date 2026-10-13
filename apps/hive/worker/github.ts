import type { PullRequestInfo } from "@hive/core";

// Round-tripping with GitHub for repositories imported from it: open a pull request with what agents merged in
// Hive, and sync upstream changes back in. Uses the REST API (git data endpoints), so no git objects are pushed.

const API = "https://api.github.com";
const MAX_FILES = 500;

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** `https://github.com/owner/repo(.git)` → owner/repo; anything else is not a GitHub repo. */
export function parseGithubUrl(url: string | undefined): GithubRepo | null {
  const m = url?.match(/^https:\/\/github\.com\/([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export class GithubError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function gh<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", headers.get("accept") ?? "application/vnd.github+json");
  headers.set("user-agent", "hive");
  headers.set("x-github-api-version", "2022-11-28");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubError(res.status, `GitHub ${res.status}: ${body.message ?? res.statusText}`);
  }
  return (headers.get("accept") === "application/vnd.github.raw" ? res.text() : res.json()) as Promise<T>;
}

interface Entry {
  hash: string;
  mode: string;
}

/** Every blob under a tree in Artifacts, keyed by path. */
async function artifactsFiles(art: ArtifactsRepo, treeHash: string): Promise<Map<string, Entry>> {
  const files = new Map<string, Entry>();
  let level = [{ prefix: "", hash: treeHash }];
  while (level.length) {
    const trees = await Promise.all(level.map(async (t) => ({ ...t, children: (await art.readTree(t.hash)) ?? [] })));
    level = [];
    for (const t of trees) {
      for (const child of t.children) {
        const path = t.prefix + child.name;
        if (child.type === "tree") level.push({ prefix: `${path}/`, hash: child.hash });
        else if (child.type !== "gitlink") files.set(path, { hash: child.hash, mode: child.mode });
      }
    }
    if (files.size > 50_000) throw new Error("Repository is too large to compare.");
  }
  return files;
}

/** Every blob in a GitHub commit's tree, keyed by path. */
async function githubFiles(token: string | null, r: GithubRepo, commitSha: string) {
  const commit = await gh<{ tree: { sha: string } }>(token, `/repos/${r.owner}/${r.repo}/git/commits/${commitSha}`);
  const tree = await gh<{ truncated: boolean; tree: { path: string; type: string; sha: string; mode: string }[] }>(
    token,
    `/repos/${r.owner}/${r.repo}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (tree.truncated) throw new Error("The GitHub repository is too large to compare.");
  const files = new Map<string, Entry>();
  for (const e of tree.tree) if (e.type === "blob") files.set(e.path, { hash: e.sha, mode: e.mode });
  return { treeSha: commit.tree.sha, files };
}

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Opens a pull request on GitHub with the difference between Hive's head and `base` (the last upstream commit
 * Hive has synced with). GitHub merges it against the current upstream like any other pull request.
 */
export async function openPullRequest(opts: {
  token: string;
  github: GithubRepo;
  art: ArtifactsRepo;
  base: string;
  head: string;
  branch: string;
  title: string;
  body: string;
}): Promise<PullRequestInfo> {
  const { token, github: r, art } = opts;
  const meta = await gh<{ default_branch: string; permissions?: { push?: boolean } }>(
    token,
    `/repos/${r.owner}/${r.repo}`,
  );
  if (!meta.permissions?.push) {
    throw new GithubError(403, `Your GitHub account cannot push to ${r.owner}/${r.repo}.`);
  }

  const headCommit = await art.readCommit(opts.head);
  if (!headCommit) throw new Error("Hive head commit not found.");
  const [ours, theirs] = await Promise.all([
    artifactsFiles(art, headCommit.treeHash),
    githubFiles(token, r, opts.base).catch((err: unknown) => {
      if (err instanceof GithubError && err.status === 404) {
        throw new Error(`Commit ${opts.base.slice(0, 7)} is not on GitHub anymore; sync first.`);
      }
      throw err;
    }),
  ]);

  const changed = [...ours].filter(([path, e]) => {
    const t = theirs.files.get(path);
    return !t || t.hash !== e.hash || t.mode !== e.mode;
  });
  const deleted = [...theirs.files.keys()].filter((path) => !ours.has(path));
  if (changed.length + deleted.length === 0) throw new Error("Nothing to propose: Hive matches GitHub.");
  if (changed.length + deleted.length > MAX_FILES) throw new Error(`Too many changed files (>${MAX_FILES}).`);

  const entries = await pool(changed, 6, async ([path, e]) => {
    // Only the mode changed: GitHub already has this exact blob.
    if (theirs.files.get(path)?.hash === e.hash) return { path, mode: e.mode, type: "blob", sha: e.hash };
    const blob = await art.readBlob(e.hash);
    if (!blob) throw new Error(`Missing blob for ${path}.`);
    const created = await gh<{ sha: string }>(token, `/repos/${r.owner}/${r.repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: toBase64(new Uint8Array(await blob.arrayBuffer())), encoding: "base64" }),
    });
    return { path, mode: e.mode, type: "blob", sha: created.sha };
  });
  for (const path of deleted) entries.push({ path, mode: "100644", type: "blob", sha: null as unknown as string });

  const tree = await gh<{ sha: string }>(token, `/repos/${r.owner}/${r.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: theirs.treeSha, tree: entries }),
  });
  const commit = await gh<{ sha: string }>(token, `/repos/${r.owner}/${r.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `${opts.title}\n\n${opts.body}`, tree: tree.sha, parents: [opts.base] }),
  });
  await gh(token, `/repos/${r.owner}/${r.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: commit.sha }),
  });
  const pr = await gh<{ number: number; html_url: string }>(token, `/repos/${r.owner}/${r.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: opts.title, head: opts.branch, base: meta.default_branch, body: opts.body }),
  });
  return {
    number: pr.number,
    url: pr.html_url,
    branch: opts.branch,
    title: opts.title,
    head: opts.head,
    createdAt: Date.now(),
  };
}

export interface UpstreamChange {
  path: string;
  /** Content at the last synced commit; null when the file did not exist. */
  base: string | null;
  /** New content upstream; null when the file was removed or renamed away. */
  theirs: string | null;
}

/** Files that changed on GitHub's default branch since `base`. */
export async function upstreamChanges(
  token: string | null,
  r: GithubRepo,
  base: string,
): Promise<{ head: string; changes: UpstreamChange[]; skipped: string[] }> {
  const meta = await gh<{ default_branch: string }>(token, `/repos/${r.owner}/${r.repo}`);
  const head = (await gh<{ sha: string }>(token, `/repos/${r.owner}/${r.repo}/commits/${meta.default_branch}`)).sha;
  if (head === base) return { head, changes: [], skipped: [] };

  const compare = await gh<{ files?: { filename: string; status: string; previous_filename?: string }[] }>(
    token,
    `/repos/${r.owner}/${r.repo}/compare/${base}...${head}`,
  );
  const files = compare.files ?? [];
  if (files.length >= 300) throw new Error("Too many upstream changes to sync at once (300+ files).");

  /** Raw file content at a commit; null if the file does not exist there. */
  const read = async (path: string, ref: string) => {
    try {
      return await gh<string>(
        token,
        `/repos/${r.owner}/${r.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
        { headers: { accept: "application/vnd.github.raw" } },
      );
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return null;
      throw err;
    }
  };

  const changes: UpstreamChange[] = [];
  const skipped: string[] = [];
  await pool(files, 4, async (f) => {
    if (f.previous_filename) {
      changes.push({ path: f.previous_filename, base: await read(f.previous_filename, base), theirs: null });
    }
    const [before, after] = await Promise.all([
      read(f.filename, base),
      f.status === "removed" ? Promise.resolve(null) : read(f.filename, head),
    ]);
    if (before?.includes("\u0000") || after?.includes("\u0000")) skipped.push(f.filename);
    else changes.push({ path: f.filename, base: before, theirs: after });
  });
  return { head, changes, skipped };
}
