import { shortSha, type TreeEntry } from "@hive/core";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, useLoad } from "../api.ts";
import { CodeView, ErrorBox, Spinner, parseMessage, timeAgo } from "../components.tsx";
import { useRepo } from "./RepoLayout.tsx";

/** File browser. `?path=` selects a file, `?ref=` a commit or branch, `?fork=a1` an agent's fork. */
export function CodeTab() {
  const { owner, name, state } = useRepo();
  const [params, setParams] = useSearchParams();
  const ref = params.get("ref") ?? undefined;
  const fork = params.get("fork") ?? undefined;
  const path = params.get("path") ?? undefined;

  // Re-read the tree whenever the default branch moves (agents merging) unless a fixed ref is pinned.
  const headKey = ref ?? state.head;
  const tree = useLoad(() => api.tree(owner, name, ref, fork), `tree:${owner}/${name}:${fork}:${headKey}`);
  const latest = useLoad(
    () => api.commits(owner, name, { ref, fork }).then((c) => c[0] ?? null),
    `latest:${owner}/${name}:${fork}:${headKey}`,
  );

  const select = (next: { path?: string; ref?: string | null; fork?: string | null }) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p);
  };

  const sourceLabel = fork ? (state.agents.find((a) => a.id === fork)?.name ?? fork) : state.branch;
  const readme = tree.data?.entries.find((e) => e.type === "blob" && /^readme(\.md|\.txt)?$/i.test(e.path));

  return (
    <div className="code-tab">
      <div className="code-toolbar">
        <label className="select">
          <span className="muted">Source</span>
          <select value={fork ?? ""} onChange={(e) => select({ fork: e.target.value || null, ref: null, path })}>
            <option value="">{state.branch} (default)</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}'s fork
              </option>
            ))}
          </select>
        </label>
        {ref && (
          <span className="pill">
            at <code>{shortSha(ref)}</code>{" "}
            <button className="link" onClick={() => select({ ref: null })}>
              ✕
            </button>
          </span>
        )}
        {latest.data && (
          <Link
            className="latest-commit"
            to={`/${owner}/${name}/commit/${latest.data.sha}${fork ? `?fork=${fork}` : ""}`}
          >
            <b>{latest.data.author}</b> <span>{parseMessage(latest.data.message).subject}</span>
            <code>{shortSha(latest.data.sha)}</code>
            <span className="muted">{timeAgo(latest.data.at)}</span>
          </Link>
        )}
      </div>

      {tree.error ? (
        <ErrorBox error={tree.error} />
      ) : !tree.data ? (
        <Spinner />
      ) : (
        <div className="code-layout">
          <FileTree entries={tree.data.entries} selected={path} onSelect={(p) => select({ path: p })} />
          <div className="code-main">
            {path ? (
              <FilePane key={`${path}:${fork}:${headKey}`} path={path} gitRef={ref} fork={fork} />
            ) : readme ? (
              <FilePane key={`${readme.path}:${fork}:${headKey}`} path={readme.path} gitRef={ref} fork={fork} />
            ) : (
              <div className="empty-card">
                <p className="muted">
                  {tree.data.entries.length} files on {sourceLabel}. Select a file to view it.
                </p>
              </div>
            )}
            {tree.data.truncated && <p className="muted small">Only the first 5000 entries are shown.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function buildTree(entries: TreeEntry[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  for (const e of entries) {
    const parentPath = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const node: Node = { name: e.path.split("/").pop()!, path: e.path, dir: e.type === "tree", children: [] };
    if (node.dir) dirs.set(e.path, node);
    (dirs.get(parentPath) ?? root).children.push(node);
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function FileTree({
  entries,
  selected,
  onSelect,
}: {
  entries: TreeEntry[];
  selected?: string;
  onSelect: (path: string) => void;
}) {
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const [open, setOpen] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    const parts = selected?.split("/") ?? [];
    for (let i = 1; i < parts.length; i++) initial.add(parts.slice(0, i).join("/"));
    return initial;
  });
  const toggle = (p: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const render = (list: Node[], depth: number) =>
    list.map((n) => (
      <li key={n.path}>
        <button
          className={`tree-item ${selected === n.path ? "selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => (n.dir ? toggle(n.path) : onSelect(n.path))}
          title={n.path}
        >
          <span className="tree-icon">{n.dir ? (open.has(n.path) ? "▾" : "▸") : "·"}</span>
          <span className={n.dir ? "tree-dir" : ""}>{n.name}</span>
        </button>
        {n.dir && open.has(n.path) && <ul>{render(n.children, depth + 1)}</ul>}
      </li>
    ));

  return (
    <nav className="file-tree" aria-label="Files">
      <ul>{render(nodes, 0)}</ul>
    </nav>
  );
}

function FilePane({ path, gitRef, fork }: { path: string; gitRef?: string; fork?: string }) {
  const { owner, name } = useRepo();
  const file = useLoad(() => api.blob(owner, name, path, gitRef, fork), `blob:${path}:${gitRef}:${fork}`);
  return (
    <div className="file-pane">
      <div className="file-pane-head">
        <span className="mono">{path}</span>
        {file.data !== null && (
          <span className="muted small">
            {file.data.split("\n").length} lines · {new Blob([file.data]).size.toLocaleString()} bytes
          </span>
        )}
      </div>
      {file.error ? (
        <ErrorBox error={file.error} />
      ) : file.data === null ? (
        <Spinner />
      ) : (
        <CodeView code={file.data} path={path} />
      )}
    </div>
  );
}
