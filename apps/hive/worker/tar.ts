// A minimal ustar writer: enough to ship a working tree into a sandbox (`tar -x`).

export interface TarEntry {
  path: string;
  data?: Uint8Array;
  /** For symlinks. */
  linkTarget?: string;
  executable?: boolean;
}

const encoder = new TextEncoder();

function field(header: Uint8Array, offset: number, length: number, value: string) {
  header.set(encoder.encode(value).subarray(0, length), offset);
}

function octal(value: number, length: number) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** Splits a path into ustar's prefix (155) and name (100) fields; null if it cannot fit. */
function splitPath(path: string): [string, string] | null {
  if (encoder.encode(path).length <= 100) return ["", path];
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return [prefix, name];
  }
  return null;
}

export function tar(entries: TarEntry[]): { archive: Uint8Array; skipped: string[] } {
  const blocks: Uint8Array[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const split = splitPath(entry.path);
    if (!split || (entry.linkTarget && encoder.encode(entry.linkTarget).length > 100)) {
      skipped.push(entry.path);
      continue;
    }
    const data = entry.linkTarget ? new Uint8Array() : (entry.data ?? new Uint8Array());
    const header = new Uint8Array(512);
    field(header, 0, 100, split[1]);
    field(header, 100, 8, octal(entry.executable ? 0o755 : 0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(data.length, 12));
    field(header, 136, 12, octal(Math.floor(Date.now() / 1000), 12));
    field(header, 148, 8, "        ");
    field(header, 156, 1, entry.linkTarget ? "2" : "0");
    if (entry.linkTarget) field(header, 157, 100, entry.linkTarget);
    field(header, 257, 6, "ustar\0");
    field(header, 263, 2, "00");
    field(header, 345, 155, split[0]);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  const size = blocks.reduce((n, b) => n + b.length, 0);
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const b of blocks) {
    archive.set(b, offset);
    offset += b.length;
  }
  return { archive, skipped };
}
