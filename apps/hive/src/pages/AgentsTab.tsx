import { shortSha, type AgentInfo, type HiveEvent, type Intent, type Lease, type RepoState } from "@hive/core";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, timeAgo, useTick } from "../components.tsx";
import { useSession } from "../session.tsx";
import { useRepo } from "./RepoLayout.tsx";

const STATUS_LABEL: Record<AgentInfo["status"], string> = {
  idle: "starting",
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

const MAX_ACTIVE = 8;

export function AgentsTab() {
  const { state, canWrite } = useRepo();
  useTick(5_000);
  return (
    <div className="agents-tab">
      {canWrite && <Launcher />}
      <Stats state={state} />
      <div className="agents-grid">
        <section className="panel">
          <h2>Agents</h2>
          {state.agents.length === 0 ? (
            <p className="muted">
              {canWrite
                ? "No agents yet. Describe a task above to launch one."
                : "No agents have worked on this repository yet."}
            </p>
          ) : (
            <ul className="agents">
              {[...state.agents].reverse().map((agent) => (
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
            Lease map{" "}
            <span className="muted">{state.leasesEnabled ? "files agents are working on" : "leases are off"}</span>
          </h2>
          <LeaseMap />
          <h2 className="spaced">Activity</h2>
          <Feed events={state.events} agents={new Map(state.agents.map((a) => [a.id, a]))} />
        </section>
      </div>
    </div>
  );
}

function Launcher() {
  const { owner, name, state, setState } = useRepo();
  const { me, refresh } = useSession();
  const [tasks, setTasks] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = state.agents.filter((a) => a.status !== "done" && a.status !== "failed").length;
  const filled = tasks.map((t) => t.trim()).filter(Boolean);
  const remaining = me?.dailyAgentLimit != null ? me.dailyAgentLimit - (me.agentsToday ?? 0) : null;

  const launch = async (body: { demo: true } | { tasks: { task: string }[] }) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.launchAgents(owner, name, body));
      setTasks([""]);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleLeases = async (enabled: boolean) => {
    try {
      setState((await api.updateSettings(owner, name, { leasesEnabled: enabled })).state);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="launcher panel">
      <div className="launcher-head">
        <h2>Launch agents</h2>
        <label
          className={`toggle ${state.leasesEnabled ? "on" : ""}`}
          title="Agents must lease files before editing them"
        >
          <input type="checkbox" checked={state.leasesEnabled} onChange={(e) => void toggleLeases(e.target.checked)} />
          <span className="track" />
          Leases {state.leasesEnabled ? "on" : "off"}
        </label>
      </div>
      <p className="muted small">
        One agent per task. Agents work concurrently on <code>{state.branch}</code>; each gets its own fork and lands
        through the merge queue.
      </p>
      {tasks.map((task, i) => (
        <div key={i} className="task-row">
          <textarea
            value={task}
            rows={2}
            maxLength={4000}
            placeholder={
              i === 0 ? "e.g. Add input validation to the signup form and return clear error messages" : "Another task"
            }
            onChange={(e) => setTasks((t) => t.map((x, j) => (j === i ? e.target.value : x)))}
          />
          {tasks.length > 1 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setTasks((t) => t.filter((_, j) => j !== i))}
              aria-label="Remove task"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="launcher-actions">
        <button
          className="btn btn-sm"
          disabled={tasks.length >= MAX_ACTIVE}
          onClick={() => setTasks((t) => [...t, ""])}
        >
          + Add task
        </button>
        {state.template === "demo" && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void launch({ demo: true })}>
            Run the 5 demo tasks
          </button>
        )}
        <span className="grow" />
        {remaining !== null && <span className="muted small">{remaining} agent runs left today</span>}
        <span className="muted small">{running} running</span>
        <button
          className="btn btn-primary"
          disabled={busy || filled.length === 0}
          onClick={() => void launch({ tasks: filled.map((task) => ({ task })) })}
        >
          {busy ? "Forking…" : `Launch ${filled.length || ""} agent${filled.length === 1 ? "" : "s"}`}
        </button>
      </div>
      {error && <ErrorBox error={error} />}
    </section>
  );
}

function Stats({ state }: { state: RepoState }) {
  const items = [
    { label: "Merged", value: state.stats.merges, tone: "good" },
    { label: "Collisions avoided", value: state.stats.collisionsAvoided, tone: "honey" },
    { label: "Auto-merged", value: state.stats.autoMerged, tone: "" },
    { label: "Intent replays", value: state.stats.replays, tone: "warn" },
    { label: "Rejected", value: state.stats.rejected, tone: "bad" },
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
  const { owner, name } = useRepo();
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
        <Link to={`/${owner}/${name}?fork=${agent.id}`} className="fork-link" title="Browse this agent's fork">
          fork
        </Link>
        {intent?.mergedAs && (
          <Link to={`/${owner}/${name}/commit/${intent.mergedAs}`} className="fork-link">
            commit {shortSha(intent.mergedAs)}
          </Link>
        )}
        {leases.map((l) => (
          <span key={l.id} className="lease-chip">
            {l.path}
          </span>
        ))}
        {intent && intent.attempts > 1 && <span className="attempts">attempt {intent.attempts}</span>}
        <span className="muted small">{timeAgo(agent.joinedAt)}</span>
      </div>
    </li>
  );
}

function LeaseMap() {
  const { owner, name, state, lastEvent } = useRepo();
  const [flash, setFlash] = useState<{ path: string; kind: "denied" | "merged" | "conflict"; at: number }[]>([]);
  const agents = useMemo(() => new Map(state.agents.map((a) => [a.id, a])), [state.agents]);

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
  }, [lastEvent]); // oxlint-disable-line react-hooks/exhaustive-deps

  // The files in play: leased, waited on, or touched by recent intents.
  const { files, waiting } = useMemo(() => {
    const waiting = new Map<string, AgentInfo[]>();
    for (const agent of state.agents) {
      const path = agent.status === "waiting" ? agent.detail.match(/^waiting for (\S+)/)?.[1] : undefined;
      if (path) waiting.set(path, [...(waiting.get(path) ?? []), agent]);
    }
    const set = new Set<string>([...state.leases.map((l) => l.path), ...waiting.keys()]);
    for (const intent of state.intents.slice(0, 20)) intent.files.forEach((f) => set.add(f));
    return { files: [...set].sort(), waiting };
  }, [state]);

  if (files.length === 0) return <p className="muted">Files appear here as agents lease, wait for and change them.</p>;

  return (
    <ul className="files">
      {files.map((path) => {
        const leases = state.leases.filter((l) => l.path === path);
        const flashes = flash.filter((f) => f.path === path);
        return (
          <li
            key={path}
            className={`file ${leases.length ? "leased" : ""} ${flashes.map((f) => `flash-${f.kind}`).join(" ")}`}
          >
            <Link to={`/${owner}/${name}?path=${encodeURIComponent(path)}`} className="file-path mono">
              {path}
            </Link>
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
  const { owner, name } = useRepo();
  const items = events
    .filter((e) => e.type !== "agent.status" && e.type !== "lease.released")
    .slice(-60)
    .reverse();
  const who = (id: string) => {
    const agent = agents.get(id);
    return <b style={{ color: agent?.color }}>{agent?.name ?? id}</b>;
  };

  const describe = (e: HiveEvent) => {
    switch (e.type) {
      case "repo.ready":
        return (
          <>
            Repository ready at <code>{shortSha(e.head)}</code>
          </>
        );
      case "repo.failed":
        return <>Repository failed: {e.error}</>;
      case "repo.settings":
        return <>Leases turned {e.leasesEnabled ? "on" : "off"}</>;
      case "agent.joined":
        return <>{who(e.agent.id)} started with its own fork</>;
      case "agent.status":
      case "lease.released":
        return null;
      case "lease.granted":
        return (
          <>
            {who(e.lease.agentId)} leased <code>{e.lease.path}</code> <span className="muted">{e.lease.reason}</span>
          </>
        );
      case "lease.denied":
        return (
          <>
            {who(e.agentId)} blocked on <code>{e.scope.path}</code>, held by {who(e.holder.agentId)}
          </>
        );
      case "intent.queued":
        return (
          <>
            {who(e.intent.agentId)} submitted “{e.intent.summary}”
            {e.intent.attempts > 1 ? ` (attempt ${e.intent.attempts})` : ""}
          </>
        );
      case "intent.merged":
        return (
          <>
            {who(e.agentId)} merged{" "}
            <Link to={`/${owner}/${name}/commit/${e.commit.sha}`}>
              <code>{shortSha(e.commit.sha)}</code>
            </Link>
            {e.mode === "auto-merge" ? " (3-way auto-merge)" : ""}
          </>
        );
      case "intent.conflict":
        return (
          <>
            {who(e.agentId)} conflicts on{" "}
            {e.files.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </>
        );
      case "intent.replaying":
        return (
          <>
            Replaying {who(e.agentId)}’s intent on the new head (attempt {e.attempt})
          </>
        );
      case "intent.rejected":
        return (
          <>
            {who(e.agentId)}’s intent rejected: {e.reason}
          </>
        );
    }
  };

  if (items.length === 0) return <p className="muted">Nothing yet.</p>;
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
