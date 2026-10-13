// In-memory filesystem for isomorphic-git, adapted from the Cloudflare Artifacts isomorphic-git example.

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; executable: boolean; mtimeMs: number }
  | { kind: "link"; target: string; mtimeMs: number };

const MODES = { dir: 0o040000, file: 0o100644, executable: 0o100755, link: 0o120000 };

/** A plain, writable stats object: isomorphic-git overwrites `mode` on the stats it gets back. */
function statsFor(entry: Entry) {
  const mode =
    entry.kind === "dir"
      ? MODES.dir
      : entry.kind === "link"
        ? MODES.link
        : entry.executable
          ? MODES.executable
          : MODES.file;
  const size = entry.kind === "file" ? entry.data.byteLength : entry.kind === "link" ? entry.target.length : 0;
  return {
    mode,
    size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.mtimeMs,
    uid: 0,
    gid: 0,
    ino: 0,
    dev: 0,
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "dir",
    isSymbolicLink: () => entry.kind === "link",
  };
}

function fsError(code: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export class MemoryFS {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

  promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  private normalize(input: string) {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private parent(path: string) {
    const parts = this.normalize(path).split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string) {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private requireEntry(path: string) {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }

  private requireDir(path: string) {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number) {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw fsError("ENOENT", parent);
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) {
      if (recursive) return;
      throw fsError("EEXIST", path);
    }
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: { mode?: number } | string) {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const mode = typeof options === "object" ? options.mode : undefined;
    this.entries.set(target, {
      kind: "file",
      data: bytes,
      executable: !!mode && (mode & 0o111) !== 0,
      mtimeMs: Date.now(),
    });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  async readFile(path: string, options?: string | { encoding?: string }) {
    const entry = this.requireEntry(path);
    if (entry.kind === "dir") throw fsError("EISDIR", path);
    const data = entry.kind === "file" ? entry.data : this.encoder.encode(entry.target);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(data) : data;
  }

  async readdir(path: string) {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string) {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind === "dir") throw fsError("EISDIR", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string) {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) throw fsError("ENOTEMPTY", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string) {
    return statsFor(this.requireEntry(path));
  }

  async lstat(path: string) {
    return this.stat(path);
  }

  async readlink(path: string): Promise<string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "link") throw fsError("EINVAL", path);
    return entry.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const link = this.normalize(path);
    await this.mkdir(this.parent(link), { recursive: true });
    if (this.entries.has(link)) throw fsError("EEXIST", path);
    this.entries.set(link, { kind: "link", target, mtimeMs: Date.now() });
    this.requireDir(this.parent(link)).children.add(this.basename(link));
  }
}
