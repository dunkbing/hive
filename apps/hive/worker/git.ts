import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";

export interface Remote {
  url: string;
  /** Full Artifacts token string, `art_v1_<secret>?expires=<unix>`. */
  token: string;
}

export interface Author {
  name: string;
  email: string;
}

export interface Workdir {
  fs: MemoryFS;
  dir: string;
  branch: string;
}

const DIR = "/repo";

/** Git Basic auth wants only the secret part of an Artifacts token. */
function onAuth(remote: Remote) {
  return () => ({ username: "x", password: remote.token.split("?expires=")[0] });
}

export async function initRepo(branch: string): Promise<Workdir> {
  const fs = new MemoryFS();
  await git.init({ fs, dir: DIR, defaultBranch: branch });
  return { fs, dir: DIR, branch };
}

/** Shallow clone of a single branch; history is not needed to commit on top of it. */
export async function cloneRepo(remote: Remote, branch: string): Promise<Workdir> {
  const fs = new MemoryFS();
  await git.clone({
    fs,
    http,
    dir: DIR,
    url: remote.url,
    ref: branch,
    singleBranch: true,
    depth: 1,
    onAuth: onAuth(remote),
  });
  return { fs, dir: DIR, branch };
}

/** Fetches `ref` from another remote and returns the fetched commit. */
export async function fetchFrom(wd: Workdir, name: string, remote: Remote, ref: string): Promise<string> {
  const remotes = await git.listRemotes({ fs: wd.fs, dir: wd.dir });
  if (!remotes.some((r) => r.remote === name))
    await git.addRemote({ fs: wd.fs, dir: wd.dir, remote: name, url: remote.url });
  const result = await git.fetch({
    fs: wd.fs,
    dir: wd.dir,
    http,
    remote: name,
    ref,
    singleBranch: true,
    depth: 1,
    onAuth: onAuth(remote),
  });
  if (!result.fetchHead) throw new Error(`could not fetch ${ref} from ${name}`);
  return result.fetchHead;
}

/** Points the local branch at `oid` and checks it out. */
export async function resetTo(wd: Workdir, oid: string): Promise<void> {
  await git.writeRef({ fs: wd.fs, dir: wd.dir, ref: `refs/heads/${wd.branch}`, value: oid, force: true });
  await git.checkout({ fs: wd.fs, dir: wd.dir, ref: wd.branch, force: true });
}

/** Writes `files` (null deletes a file) and commits them. */
export async function writeAndCommit(
  wd: Workdir,
  files: Record<string, string | null>,
  message: string,
  author: Author,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await wd.fs.promises.unlink(`${wd.dir}/${path}`).catch(() => undefined);
      await git.remove({ fs: wd.fs, dir: wd.dir, filepath: path });
    } else {
      await wd.fs.promises.writeFile(`${wd.dir}/${path}`, content);
      await git.add({ fs: wd.fs, dir: wd.dir, filepath: path });
    }
  }
  return git.commit({ fs: wd.fs, dir: wd.dir, message, author });
}

/** Moves the working copy to the remote's latest commit if someone else pushed. Returns the head. */
export async function refresh(wd: Workdir, remote: Remote): Promise<string> {
  // Working copies created with initRepo have no remote yet.
  const remotes = await git.listRemotes({ fs: wd.fs, dir: wd.dir });
  if (!remotes.some((r) => r.remote === "origin")) {
    await git.addRemote({ fs: wd.fs, dir: wd.dir, remote: "origin", url: remote.url });
  }
  const result = await git.fetch({
    fs: wd.fs,
    dir: wd.dir,
    http,
    remote: "origin",
    ref: wd.branch,
    singleBranch: true,
    depth: 1,
    onAuth: onAuth(remote),
  });
  const head = await git.resolveRef({ fs: wd.fs, dir: wd.dir, ref: "HEAD" });
  if (result.fetchHead && result.fetchHead !== head) {
    await resetTo(wd, result.fetchHead);
    return result.fetchHead;
  }
  return head;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Regex search over the working tree (text files only). */
export async function search(wd: Workdir, pattern: RegExp, opts: { prefix?: string; limit?: number } = {}) {
  const limit = opts.limit ?? 100;
  const matches: SearchMatch[] = [];
  for (const path of await listFiles(wd)) {
    if (opts.prefix && !path.startsWith(opts.prefix)) continue;
    const text = await readText(wd, path);
    if (text === null || text.length > 1_000_000 || text.includes("\u0000")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        matches.push({ path, line: i + 1, text: lines[i].slice(0, 300) });
        if (matches.length >= limit) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

export async function push(wd: Workdir, remote: Remote, opts: { force?: boolean } = {}) {
  const result = await git.push({
    fs: wd.fs,
    dir: wd.dir,
    http,
    url: remote.url,
    ref: wd.branch,
    remoteRef: wd.branch,
    force: opts.force,
    onAuth: onAuth(remote),
  });
  if (!result.ok) throw new Error(`push failed: ${JSON.stringify(result.refs)}`);
}

export async function readText(wd: Workdir, path: string): Promise<string | null> {
  try {
    return (await wd.fs.promises.readFile(`${wd.dir}/${path}`, "utf8")) as string;
  } catch {
    return null;
  }
}

export async function listFiles(wd: Workdir): Promise<string[]> {
  return (await git.listFiles({ fs: wd.fs, dir: wd.dir, ref: "HEAD" })).sort();
}

/** The branch the remote's HEAD points at. Import metadata can disagree with the imported refs, so ask git. */
export async function defaultBranch(remote: Remote): Promise<string> {
  const refs = await git.listServerRefs({
    http,
    url: remote.url,
    symrefs: true,
    prefix: "HEAD",
    onAuth: onAuth(remote),
  });
  const target = refs.find((r) => r.ref === "HEAD")?.target;
  return target?.replace(/^refs\/heads\//, "") ?? "main";
}

/** Branches and tags on a remote. */
export async function listRefs(remote: Remote): Promise<{ branches: string[]; tags: string[] }> {
  const refs = await git.listServerRefs({ http, url: remote.url, prefix: "refs/", onAuth: onAuth(remote) });
  const names = (prefix: string) =>
    refs
      .filter((r) => r.ref.startsWith(prefix) && !r.ref.endsWith("^{}"))
      .map((r) => r.ref.slice(prefix.length))
      .sort();
  return { branches: names("refs/heads/"), tags: names("refs/tags/") };
}
