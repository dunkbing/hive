import { shortSha, type TreeEntry } from "@hive/core";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { api, useLoad } from "../api.ts";
import { CodeView, ErrorBox, Markdown, Spinner, parseMessage, timeAgo } from "../components.tsx";
import { useSession } from "../session.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { GoalStatusPill, Progress, goalProgress } from "./TasksTab.tsx";

/**
 * File browser. Query params: `path` selects a file, `ref` a branch, tag or commit, `fork` an agent's fork,
 * `q` runs a code search, `view` picks code/preview/blame.
 */
export function CodeTab() {
  const { owner, name, state } = useRepo();
  const [params, setParams] = useSearchParams();
  const ref = params.get("ref") ?? undefined;
  const fork = params.get("fork") ?? undefined;
  const path = params.get("path") ?? undefined;
  const q = params.get("q") ?? "";

  // Re-read the tree whenever the default branch moves (agents merging) unless a fixed ref is pinned.
  const headKey = ref ?? state.head;
  const tree = useLoad(() => api.tree(owner, name, ref, fork), `tree:${owner}/${name}:${fork}:${headKey}`);
  const latest = useLoad(
    () => api.commits(owner, name, { ref, fork }).then((c) => c[0] ?? null),
    `latest:${owner}/${name}:${fork}:${headKey}`,
  );
  const refs = useLoad(() => api.refs(owner, name), `refs:${owner}/${name}:${state.head}`);

  const select = (next: Record<string, string | null | undefined>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p);
  };

  const sourceValue = fork ? `fork:${fork}` : ref ? `ref:${ref}` : "";
  const isSha = !!ref && /^[0-9a-f]{40}$/.test(ref);
  const readme = tree.data?.entries.find((e) => e.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.path));

  return (
    <div className="code-tab">
      <div className="code-toolbar">
        <label className="select">
          <select
            value={sourceValue}
            onChange={(e) => {
              const [kind, value] = e.target.value.split(/:(.*)/);
              select({ fork: kind === "fork" ? value : null, ref: kind === "ref" ? value : null, q: null });
            }}
            aria-label="Branch, tag or fork"
          >
            <option value="">⎇ {state.branch}</option>
            {isSha && <option value={sourceValue}>@ {shortSha(ref)}</option>}
            {(refs.data?.branches ?? [])
              .filter((b) => b !== state.branch)
              .map((b) => (
                <option key={b} value={`ref:${b}`}>
                  ⎇ {b}
                </option>
              ))}
            {!!refs.data?.tags.length && (
              <optgroup label="Tags">
                {refs.data.tags.map((t) => (
                  <option key={t} value={`ref:${t}`}>
                    {t}
                  </option>
                ))}
              </optgroup>
            )}
            {state.agents.length > 0 && (
              <optgroup label="Agent forks">
                {state.agents.map((a) => (
                  <option key={a.id} value={`fork:${a.id}`}>
                    {a.name}'s fork
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <SearchBox initial={q} onSearch={(value) => select({ q: value || null, path: null })} />
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
          <FileTree entries={tree.data.entries} selected={path} onSelect={(p) => select({ path: p, q: null })} />
          <div className="code-main">
            {!path && !q && !fork && !ref && <Activity />}
            {q && !fork && !ref ? (
              <SearchResults q={q} onOpen={(p) => select({ path: p, q: null })} />
            ) : path ? (
              <FilePane key={`${path}:${fork}:${headKey}`} path={path} gitRef={ref} fork={fork} />
            ) : readme ? (
              <FilePane key={`${readme.path}:${fork}:${headKey}`} path={readme.path} gitRef={ref} fork={fork} />
            ) : (
              <div className="empty-card">
                <p className="muted">{tree.data.entries.length} entries. Select a file to view it.</p>
              </div>
            )}
            {q && (fork || ref) && <p className="muted small">Code search covers the default branch only.</p>}
            {tree.data.truncated && <p className="muted small">Only the first 5000 entries are shown.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Repo home: what is going on, shown above the README when there is anything to show. */
function Activity() {
  const { owner, name, state } = useRepo();
  const base = `/${owner}/${name}`;
  const goals = state.goals
    .filter((g) => g.status === "active" || g.status === "review")
    .slice(-3)
    .reverse();
  const tasks = state.tasks.filter((t) => t.status === "open").slice(0, 5);
  const reviews = state.intents.filter((i) => i.status === "review");
  const commits = state.commits.slice(0, 5);
  if (!goals.length && !tasks.length && !reviews.length && !commits.length) return null;
  return (
    <div className="activity">
      {goals.length > 0 && (
        <section>
          <h4>Goals</h4>
          {goals.map((g) => {
            const { done, total } = goalProgress(g.number, state.tasks);
            return (
              <div key={g.number} className="row">
                <Link className="grow" to={`${base}/goals/${g.number}`}>
                  {g.title}
                </Link>
                <GoalStatusPill goal={g} />
                <Progress done={done} total={total} />
              </div>
            );
          })}
        </section>
      )}
      {reviews.length > 0 && (
        <section>
          <h4>Reviews waiting</h4>
          <Link to={`${base}/intents`}>
            {reviews.length} intent{reviews.length === 1 ? "" : "s"} awaiting review
          </Link>
        </section>
      )}
      {tasks.length > 0 && (
        <section>
          <h4>Open tasks</h4>
          {tasks.map((t) => (
            <div key={t.number}>
              <Link to={`${base}/tasks/${t.number}`}>
                <span className="muted">#{t.number}</span> {t.title}
              </Link>
            </div>
          ))}
        </section>
      )}
      {commits.length > 0 && (
        <section>
          <h4>Latest merges</h4>
          {commits.map((c) => (
            <div key={c.sha} className="row">
              <Link className="grow ellipsis" to={`${base}/commit/${c.sha}`}>
                {parseMessage(c.message).subject}
              </Link>
              <span className="muted small">{timeAgo(c.at)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(value.trim());
  };
  return (
    <form className="search-box" onSubmit={submit} role="search">
      <input
        type="search"
        value={value}
        placeholder="Search code (regex)"
        onChange={(e) => {
          setValue(e.target.value);
          if (!e.target.value) onSearch("");
        }}
        aria-label="Search code"
      />
    </form>
  );
}

function SearchResults({ q, onOpen }: { q: string; onOpen: (path: string) => void }) {
  const { owner, name, state } = useRepo();
  const results = useLoad(() => api.search(owner, name, q), `search:${q}:${state.head}`);
  if (results.error) return <ErrorBox error={results.error} />;
  if (!results.data) return <Spinner label="Searching…" />;
  const byFile = new Map<string, { line: number; text: string }[]>();
  for (const m of results.data.matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
  return (
    <div className="search-results">
      <p className="muted small">
        {results.data.matches.length}
        {results.data.truncated ? "+" : ""} matching lines for <code>{q}</code> in {byFile.size} files
      </p>
      {[...byFile].map(([path, lines]) => (
        <div key={path} className="search-file">
          <button className="link mono" onClick={() => onOpen(path)}>
            {path}
          </button>
          <table>
            <tbody>
              {lines.map((l) => (
                <tr key={l.line}>
                  <td className="ln">{l.line}</td>
                  <td className="mono search-line">{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
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
  const [filter, setFilter] = useState("");
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

  // "Go to file": fuzzy-ish match on the path, showing a flat list.
  const matches = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return null;
    const parts = f.split(/\s+/);
    return entries
      .filter((e) => e.type === "blob" && parts.every((p) => e.path.toLowerCase().includes(p)))
      .slice(0, 200);
  }, [entries, filter]);

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
      <input
        className="tree-filter"
        type="search"
        placeholder="Go to file"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Go to file"
      />
      {matches ? (
        <ul>
          {matches.length === 0 && <li className="muted small tree-empty">No files match.</li>}
          {matches.map((e) => (
            <li key={e.path}>
              <button
                className={`tree-item ${selected === e.path ? "selected" : ""}`}
                onClick={() => onSelect(e.path)}
                title={e.path}
              >
                <span className="mono small">{e.path}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul>{render(nodes, 0)}</ul>
      )}
    </nav>
  );
}

type View = "code" | "preview" | "blame";

function FilePane({ path, gitRef, fork }: { path: string; gitRef?: string; fork?: string }) {
  const { owner, name } = useRepo();
  const markdown = /\.(md|markdown)$/i.test(path);
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View | null) ?? (markdown ? "preview" : "code");
  const file = useLoad(() => api.blob(owner, name, path, gitRef, fork), `blob:${path}:${gitRef}:${fork}`);
  const setView = (v: View) => {
    const p = new URLSearchParams(params);
    p.set("view", v);
    setParams(p, { replace: true });
  };

  return (
    <div className="file-pane">
      <div className="file-pane-head">
        <span className="mono file-pane-path">{path}</span>
        {file.data !== null && (
          <span className="muted small">
            {file.data.split("\n").length} lines · {new Blob([file.data]).size.toLocaleString()} bytes
          </span>
        )}
        <span className="grow" />
        {!fork && !gitRef && <LeaseButton path={path} />}
        <div className="segmented">
          {markdown && (
            <button className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>
              Preview
            </button>
          )}
          <button className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
            Code
          </button>
          <button className={view === "blame" ? "on" : ""} onClick={() => setView("blame")}>
            Blame
          </button>
        </div>
      </div>
      {file.error ? (
        <ErrorBox error={file.error} />
      ) : file.data === null ? (
        <Spinner />
      ) : view === "blame" ? (
        <BlameView path={path} gitRef={gitRef} fork={fork} />
      ) : view === "preview" && markdown ? (
        <Markdown source={file.data} />
      ) : (
        <CodeView code={file.data} path={path} />
      )}
    </div>
  );
}

/** Lets the owner take a file out of the agents' hands while editing it themselves. */
function LeaseButton({ path }: { path: string }) {
  const { owner, name, state, canWrite } = useRepo();
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lease = state.leases.find((l) => l.path === path);
  if (!lease && !canWrite) return null;
  const mine = lease && me?.user && lease.agentId === `human:${me.user.login}`;
  const holder = lease ? (state.agents.find((a) => a.id === lease.agentId)?.name ?? lease.holderName) : null;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (lease && !mine) {
    return (
      <span className="pill" title={lease.reason}>
        leased by {holder}
      </span>
    );
  }
  return (
    <span className="row">
      {error && <span className="small error-text">{error}</span>}
      <button
        className="btn btn-sm"
        disabled={busy || !state.leasesEnabled}
        title={
          state.leasesEnabled
            ? mine
              ? "Let agents edit this file again"
              : "Agents will not edit this file while you hold the lease (30 minutes)"
            : "Leases are off in this repository"
        }
        onClick={() => void act(() => (mine ? api.release(owner, name, path) : api.lease(owner, name, path)))}
      >
        {mine ? "Release lease" : "Lease file"}
      </button>
    </span>
  );
}

function BlameView({ path, gitRef, fork }: { path: string; gitRef?: string; fork?: string }) {
  const { owner, name, state } = useRepo();
  const blame = useLoad(() => api.blame(owner, name, path, gitRef, fork), `blame:${path}:${gitRef}:${fork}`);
  const file = useLoad(() => api.blob(owner, name, path, gitRef, fork), `blob:${path}:${gitRef}:${fork}`);
  if (blame.error) return <ErrorBox error={blame.error} />;
  if (!blame.data || file.data === null) return <Spinner label="Reading history…" />;
  const lines = file.data.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const colors = new Map(state.agents.map((a) => [a.name, a.color]));

  return (
    <div className="blame">
      {blame.data.truncated && (
        <p className="muted small blame-note">History was cut off; the oldest lines show the oldest commit read.</p>
      )}
      <table>
        <tbody>
          {lines.map((text, i) => {
            const idx = blame.data!.lines[i];
            const commit = blame.data!.commits[idx];
            const first = i === 0 || blame.data!.lines[i - 1] !== idx;
            let span = 1;
            while (first && i + span < lines.length && blame.data!.lines[i + span] === idx) span++;
            const { subject, trailers } = parseMessage(commit?.message ?? "");
            return (
              <tr key={i} className={first ? "blame-start" : ""}>
                {first && (
                  <td
                    rowSpan={span}
                    className="blame-commit"
                    style={{ borderLeftColor: colors.get(commit?.author ?? "") ?? "var(--border)" }}
                  >
                    {commit && (
                      <Link to={`/${owner}/${name}/commit/${commit.sha}${fork ? `?fork=${fork}` : ""}`} title={subject}>
                        <span className="blame-author">{commit.author}</span>{" "}
                        <span className="muted">{timeAgo(commit.at)}</span>
                        <div className="blame-subject">
                          {trailers["Hive-Intent"] && <span className="pill pill-agent">intent</span>} {subject}
                        </div>
                      </Link>
                    )}
                  </td>
                )}
                <td className="ln">{i + 1}</td>
                <td className="mono blame-text">{text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
