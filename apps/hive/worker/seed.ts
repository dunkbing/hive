// The demo codebase every new Hive repo starts from, bundled at build time.
const raw = import.meta.glob<string>("../seed/**/*", { query: "?raw", import: "default", eager: true });

export const SEED_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([path, content]) => [path.replace(/^\.\.\/seed\//, ""), content]),
);
