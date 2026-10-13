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
}

const DIR = "/repo";

/** Git Basic auth wants only the secret part of an Artifacts token. */
function onAuth(remotes: Remote[]) {
  return (url: string) => {
    const remote = remotes.find((r) => url.startsWith(r.url.replace(/\.git$/, ""))) ?? remotes[0];
    return { username: "x", password: remote.token.split("?expires=")[0] };
  };
}

export async function initRepo(): Promise<Workdir> {
  const fs = new MemoryFS();
  await git.init({ fs, dir: DIR, defaultBranch: "main" });
  return { fs, dir: DIR };
}

export async function cloneRepo(remote: Remote, ref = "main"): Promise<Workdir> {
  const fs = new MemoryFS();
  await git.clone({ fs, http, dir: DIR, url: remote.url, ref, singleBranch: true, onAuth: onAuth([remote]) });
  return { fs, dir: DIR };
}

/** Fetches `ref` from another remote and returns the fetched commit. */
export async function fetchFrom(wd: Workdir, name: string, remote: Remote, ref = "main"): Promise<string> {
  const remotes = await git.listRemotes({ ...wd });
  if (!remotes.some((r) => r.remote === name)) await git.addRemote({ ...wd, remote: name, url: remote.url });
  const result = await git.fetch({ ...wd, http, remote: name, ref, singleBranch: true, onAuth: onAuth([remote]) });
  if (!result.fetchHead) throw new Error(`could not fetch ${ref} from ${name}`);
  return result.fetchHead;
}

/** Points the local `main` branch at `oid` and checks it out. */
export async function resetTo(wd: Workdir, oid: string): Promise<void> {
  await git.writeRef({ ...wd, ref: "refs/heads/main", value: oid, force: true });
  await git.checkout({ ...wd, ref: "main", force: true });
}

export async function writeAndCommit(
  wd: Workdir,
  files: Record<string, string>,
  message: string,
  author: Author,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await wd.fs.promises.writeFile(`${wd.dir}/${path}`, content);
    await git.add({ ...wd, filepath: path });
  }
  return git.commit({ ...wd, message, author });
}

export async function push(wd: Workdir, remote: Remote, opts: { remoteName?: string; force?: boolean } = {}) {
  const result = await git.push({
    ...wd,
    http,
    url: remote.url,
    remote: opts.remoteName,
    ref: "main",
    remoteRef: "main",
    force: opts.force,
    onAuth: onAuth([remote]),
  });
  if (!result.ok) throw new Error(`push failed: ${JSON.stringify(result.refs)}`);
}

export async function headOid(wd: Workdir): Promise<string> {
  return git.resolveRef({ ...wd, ref: "HEAD" });
}

export async function readText(wd: Workdir, path: string): Promise<string | null> {
  try {
    return (await wd.fs.promises.readFile(`${wd.dir}/${path}`, "utf8")) as string;
  } catch {
    return null;
  }
}

export async function listFiles(wd: Workdir): Promise<string[]> {
  return (await git.listFiles({ ...wd, ref: "HEAD" })).sort();
}
