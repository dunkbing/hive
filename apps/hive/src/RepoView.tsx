import { shortSha, type AgentInfo, type HiveEvent, type Intent, type Lease, type RepoState } from "@hive/core";
import { useEffect, useMemo, useState } from "react";
import { Logo } from "./App.tsx";
import { api, useRepo } from "./api.ts";

const STATUS_LABEL: Record<AgentInfo["status"], string> = {
  idle: "idle",
  planning: "planning",
  reading: "reading",
  waiting: "waiting for lease",
  editing: "editing",
  submitting: "committing",
  queued: "in merge queue",
  replaying: "replaying intent",
  done: "merged",
  failed: "failed",
};

export function RepoView({ repo, onNewRepo }: { repo: string; onNewRepo: (name: string) => void }) {
  const { state, lastEvent, connection, error } = useRepo(repo);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [clone, setClone] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <main className="home">
        <div className="home-card">
          <h1>Repo not found</h1>
          <p className="error">{error}</p>
          <a className="btn" href="/">
            Back
          </a>
        </div>
      </main>
    );
  }
  if (!state) return <main className="loading">Connecting to {repo}…</main>;

  const agents = new Map(state.agents.map((a) => [a.id, a]));
  const running = state.agents.some((a) => a.status !== "done" && a.status !== "failed");

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <Logo />
          <span>hive</span>
        </a>
        <div className="repo-id">
          <span className="repo-name">{state.name}</span>
          <span className="branch">main</span>
          <code>{shortSha(state.head)}</code>
          <span className={`conn conn-${connection}`} title={`websocket ${connection}`} />
        </div>
        <div className="actions">
          <label className={`toggle ${state.leasesEnabled ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={state.leasesEnabled}
              disabled={busy !== null}
              onChange={(e) => run("leases", () => api.setLeases(repo, e.target.checked))}
            />
            <span className="track" />
            Leases {state.leasesEnabled ? "on" : "off"}
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => run("run", () => api.runScenario(repo))}
          >
            {busy === "run" ? "Forking repos…" : running ? "Add 5 more agents" : "Run 5 agents"}
          </button>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => run("clone", async () => setClone((await api.clone(repo)).command))}
          >
            git clone
          </button>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => run("new", async () => onNewRepo((await api.createRepo()).name))}
          >
            {busy === "new" ? "Creating…" : "New repo"}
          </button>
        </div>
      </header>

      {actionError && <div className="banner error">{actionError}</div>}

      <Stats state={state} />

      <div className="grid">
        <section className="panel">
          <h2>Agents</h2>
          {state.agents.length === 0 ? (
            <p className="empty">
              No agents yet. Press "Run 5 agents" to start five coding agents on this repo at once.
            </p>
          ) : (
            <ul className="agents">
              {state.agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  intent={state.intents.find((i) => i.agentId === agent.id)}
                  leases={state.leases.filter((l) => l.agentId === agent.id)}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>
            Lease map <span className="muted">{state.leasesEnabled ? "who holds what, live" : "leases are off"}</span>
          </h2>
          <LeaseMap state={state} agents={agents} lastEvent={lastEvent} onOpen={setOpenFile} />
          <h2 className="feed-title">Activity</h2>
          <Feed events={state.events} agents={agents} />
        </section>

        <section className="panel">
          <h2>
            main <span className="muted">{state.commits.length} commits</span>
          </h2>
          <ol className="commits">
            {state.commits.map((c, i) => {
              const agent = state.agents.find((a) => a.name === c.author);
              return (
                <li key={c.sha} className={i === 0 ? "head" : ""}>
                  <span className="dot" style={{ background: agent?.color ?? "var(--muted)" }} />
                  <div>
                    <div className="commit-msg">{c.message}</div>
                    <div className="commit-meta">
                      <code>{shortSha(c.sha)}</code> {c.author} · {timeAgo(c.at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      {openFile && <FileModal repo={repo} path={openFile} head={state.head} onClose={() => setOpenFile(null)} />}
      {clone && (
        <Modal title="Clone this repo" onClose={() => setClone(null)}>
          <p className="muted">A read-only token, valid for one hour. Any git client works against Artifacts.</p>
          <pre className="code">{clone}</pre>
          <button className="btn" onClick={() => navigator.clipboard.writeText(clone)}>
            Copy
          </button>
        </Modal>
      )}
    </div>
  );
}

function Stats({ state }: { state: RepoState }) {
  const items = [
    { label: "Merged to main", value: state.stats.merges, tone: "good" },
    { label: "Collisions avoided", value: state.stats.collisionsAvoided, tone: "honey" },
    { label: "Auto-merged", value: state.stats.autoMerged, tone: "" },
    { label: "Intent replays", value: state.stats.replays, tone: "warn" },
    { label: "Rejected", value: state.stats.rejected, tone: "bad" },
    { label: "Humans resolving conflicts", value: 0, tone: "" },
  ];
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.label} className={`stat ${s.tone}`}>
          <div className="stat-value">{s.value}</div>
          <div className="stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function AgentCard({ agent, intent, leases }: { agent: AgentInfo; intent?: Intent; leases: Lease[] }) {
  return (
    <li className={`agent status-${agent.status}`} style={{ "--agent": agent.color } as React.CSSProperties}>
      <div className="agent-head">
        <span className="dot" />
        <span className="agent-name">{agent.name}</span>
        <span className="badge">{STATUS_LABEL[agent.status]}</span>
      </div>
      <div className="agent-task">{agent.task}</div>
      <div className="agent-detail">{agent.detail}</div>
      <div className="agent-foot">
        <code title="Artifacts fork">{agent.fork}</code>
        {leases.map((l) => (
          <span key={l.id} className="lease-chip">
            {l.path}
          </span>
        ))}
        {intent && intent.attempts > 1 && <span className="attempts">attempt {intent.attempts}</span>}
      </div>
    </li>
  );
}

function LeaseMap({
  state,
  agents,
  lastEvent,
  onOpen,
}: {
  state: RepoState;
  agents: Map<string, AgentInfo>;
  lastEvent: HiveEvent | null;
  onOpen: (path: string) => void;
}) {
  const [flash, setFlash] = useState<{ path: string; kind: "denied" | "merged" | "conflict"; at: number }[]>([]);

  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    const add = (paths: string[], kind: "denied" | "merged" | "conflict") =>
      setFlash((f) => [...f.filter((x) => now - x.at < 2500), ...paths.map((path) => ({ path, kind, at: now }))]);
    if (lastEvent.type === "lease.denied") add([lastEvent.scope.path], "denied");
    if (lastEvent.type === "intent.conflict") add(lastEvent.files, "conflict");
    if (lastEvent.type === "intent.merged") {
      const intent = state.intents.find((i) => i.id === lastEvent.intentId);
      if (intent) add(intent.files, "merged");
    }
    const timer = setTimeout(() => setFlash((f) => f.filter((x) => Date.now() - x.at < 2500)), 2600);
    return () => clearTimeout(timer);
    // Only react to new events.
  }, [lastEvent]);

  const waiting = useMemo(() => {
    const byPath = new Map<string, AgentInfo[]>();
    for (const agent of state.agents) {
      const path = agent.status === "waiting" ? agent.detail.match(/^waiting for (\S+)/)?.[1] : undefined;
      if (path) byPath.set(path, [...(byPath.get(path) ?? []), agent]);
    }
    return byPath;
  }, [state.agents]);

  return (
    <ul className="files">
      {state.files.map((path) => {
        const leases = state.leases.filter((l) => l.path === path);
        const flashes = flash.filter((f) => f.path === path);
        const depth = path.split("/").length - 1;
        return (
          <li
            key={path}
            className={`file ${leases.length ? "leased" : ""} ${flashes.map((f) => `flash-${f.kind}`).join(" ")}`}
            onClick={() => onOpen(path)}
          >
            <span className="file-path" style={{ paddingLeft: depth * 14 }}>
              <span className="dir">
                {path.split("/").slice(0, -1).join("/")}
                {depth ? "/" : ""}
              </span>
              {path.split("/").pop()}
            </span>
            <span className="holders">
              {leases.map((l) => {
                const agent = agents.get(l.agentId);
                return (
                  <span key={l.id} className="holder" style={{ background: agent?.color }} title={l.reason}>
                    {agent?.name ?? l.agentId}
                  </span>
                );
              })}
              {(waiting.get(path) ?? []).map((agent) => (
                <span
                  key={agent.id}
                  className="holder waiting"
                  style={{ borderColor: agent.color, color: agent.color }}
                >
                  {agent.name} waiting
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Feed({ events, agents }: { events: HiveEvent[]; agents: Map<string, AgentInfo> }) {
  const items = events
    .filter((e) => e.type !== "agent.status" && e.type !== "lease.released")
    .slice(-40)
    .reverse();
  const name = (id: string) => {
    const agent = agents.get(id);
    return <b style={{ color: agent?.color }}>{agent?.name ?? id}</b>;
  };

  const describe = (e: HiveEvent) => {
    switch (e.type) {
      case "repo.ready":
        return (
          <>
            Repo created in Artifacts and seeded at <code>{shortSha(e.head)}</code>
          </>
        );
      case "repo.settings":
        return <>Leases turned {e.leasesEnabled ? "on" : "off"}</>;
      case "agent.joined":
        return (
          <>
            {name(e.agent.id)} joined with fork <code>{e.agent.fork}</code>
          </>
        );
      case "agent.status":
      case "lease.released":
        return null;
      case "lease.granted":
        return (
          <>
            {name(e.lease.agentId)} leased <code>{e.lease.path}</code> <span className="muted">{e.lease.reason}</span>
          </>
        );
      case "lease.denied":
        return (
          <>
            {name(e.agentId)} blocked on <code>{e.scope.path}</code>, held by {name(e.holder.agentId)}
          </>
        );
      case "intent.queued":
        return (
          <>
            {name(e.intent.agentId)} submitted “{e.intent.summary}”
            {e.intent.attempts > 1 ? ` (attempt ${e.intent.attempts})` : ""}
          </>
        );
      case "intent.merged":
        return (
          <>
            {name(e.agentId)} merged <code>{shortSha(e.commit.sha)}</code>
            {e.mode === "auto-merge" ? " (3-way auto-merge)" : ""}
          </>
        );
      case "intent.conflict":
        return (
          <>
            {name(e.agentId)} conflicts on{" "}
            {e.files.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </>
        );
      case "intent.replaying":
        return (
          <>
            Replaying {name(e.agentId)}’s intent on the new main (attempt {e.attempt})
          </>
        );
      case "intent.rejected":
        return (
          <>
            {name(e.agentId)}’s intent rejected: {e.reason}
          </>
        );
    }
  };

  return (
    <ol className="feed">
      {items.map((e) => (
        <li key={e.seq} className={`ev ev-${e.type.replace(".", "-")}`}>
          <time>
            {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </time>
          <span>{describe(e)}</span>
        </li>
      ))}
    </ol>
  );
}

function FileModal({
  repo,
  path,
  head,
  onClose,
}: {
  repo: string;
  path: string;
  head: string | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    api.file(repo, path).then(setContent, (err: Error) => setContent(`// ${err.message}`));
  }, [repo, path, head]);
  return (
    <Modal title={`${path} @ main ${shortSha(head)}`} onClose={onClose}>
      <pre className="code file-code">{content ?? "Loading…"}</pre>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
