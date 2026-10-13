import {
  shortSha,
  type AgentInfo,
  type HiveEvent,
  type Intent,
  type Lease,
  type MergeMode,
  type Plan,
  type RepoState,
} from "@hive/core";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, INTENT_LABEL, STATUS_LABEL, isRunning, timeAgo, useTick } from "../components.tsx";
import { useSession } from "../session.tsx";
import { useRepo } from "./RepoLayout.tsx";

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
                ? "No agents yet. Describe a goal above and Hive will plan the work."
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
            Lease map <span className="muted">{state.leasesEnabled ? "files being worked on" : "leases are off"}</span>
          </h2>
          <LeaseMap />
          <h2 className="spaced">Activity</h2>
          <Feed events={state.events} agents={new Map(state.agents.map((a) => [a.id, a]))} />
        </section>
      </div>
    </div>
  );
}

type Mode = "plan" | "tasks";

function Launcher() {
  const { owner, name, state, setState } = useRepo();
  const { me, refresh } = useSession();
  const [mode, setMode] = useState<Mode>("plan");
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [tasks, setTasks] = useState<string[]>([""]);
  const [busy, setBusy] = useState<null | "plan" | "launch">(null);
  const [error, setError] = useState<string | null>(null);

  const running = state.agents.filter((a) => isRunning(a.status)).length;
  const remaining = me?.dailyAgentLimit != null ? me.dailyAgentLimit - (me.agentsToday ?? 0) : null;
  const filled = tasks.map((t) => t.trim()).filter(Boolean);

  const act = async (kind: "plan" | "launch", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const makePlan = () =>
    act("plan", async () => {
      setPlan(await api.plan(owner, name, goal));
    });

  const launch = (body: { demo: true } | { tasks: { name?: string; task: string }[] }) =>
    act("launch", async () => {
      setState(await api.launchAgents(owner, name, body));
      setPlan(null);
      setGoal("");
      setTasks([""]);
    });

  const updateSetting = (body: { leasesEnabled?: boolean; mergeMode?: MergeMode }) =>
    api.updateSettings(owner, name, body).then(
      (r) => setState(r.state),
      (err: Error) => setError(err.message),
    );

  const sharedFiles = useMemo(() => {
    const count = new Map<string, number>();
    for (const t of plan?.tasks ?? []) for (const f of t.files) count.set(f, (count.get(f) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > 1).map(([f]) => f));
  }, [plan]);

  return (
    <section className="launcher panel">
      <div className="launcher-head">
        <div className="segmented" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "plan"}
            className={mode === "plan" ? "on" : ""}
            onClick={() => setMode("plan")}
          >
            Describe a goal
          </button>
          <button
            role="tab"
            aria-selected={mode === "tasks"}
            className={mode === "tasks" ? "on" : ""}
            onClick={() => setMode("tasks")}
          >
            Write tasks
          </button>
        </div>
        <div className="row">
          <label className="toggle-select" title="What happens when an agent submits">
            <select
              value={state.mergeMode}
              onChange={(e) => void updateSetting({ mergeMode: e.target.value as MergeMode })}
            >
              <option value="auto">Auto-merge</option>
              <option value="review">Review before merge</option>
            </select>
          </label>
          <label className={`toggle ${state.leasesEnabled ? "on" : ""}`} title="Agents must lease files before editing">
            <input
              type="checkbox"
              checked={state.leasesEnabled}
              onChange={(e) => void updateSetting({ leasesEnabled: e.target.checked })}
            />
            <span className="track" />
            Leases
          </label>
        </div>
      </div>

      {state.checkCommand && (
        <p className="muted small launcher-note">
          Every merge is checked first with <code>{state.checkCommand}</code>.
        </p>
      )}
      {mode === "plan" ? (
        <>
          <textarea
            value={goal}
            rows={3}
            maxLength={4000}
            placeholder="What should change? e.g. Add user accounts: registration and login with email and password, todos belong to a user, and every /todos route requires a bearer token."
            onChange={(e) => setGoal(e.target.value)}
          />
          {!plan && (
            <div className="launcher-actions">
              {state.template === "demo" && (
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => void launch({ demo: true })}>
                  Run the 5 demo tasks
                </button>
              )}
              <span className="grow" />
              {remaining !== null && <span className="muted small">{remaining} agent runs left today</span>}
              <button
                className="btn btn-primary"
                disabled={busy !== null || !goal.trim()}
                onClick={() => void makePlan()}
              >
                {busy === "plan" ? "Exploring the code and planning…" : "Plan the work"}
              </button>
            </div>
          )}
          {plan && (
            <div className="plan">
              <p className="plan-summary">{plan.summary}</p>
              {plan.tasks.map((t, i) => (
                <div key={i} className="plan-task">
                  <div className="plan-task-head">
                    <input
                      className="mono"
                      value={t.name}
                      onChange={(e) =>
                        setPlan({
                          ...plan,
                          tasks: plan.tasks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        })
                      }
                    />
                    <span className="grow" />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((_, j) => j !== i) })}
                      aria-label="Remove task"
                    >
                      ✕
                    </button>
                  </div>
                  <textarea
                    value={t.task}
                    rows={4}
                    onChange={(e) =>
                      setPlan({
                        ...plan,
                        tasks: plan.tasks.map((x, j) => (j === i ? { ...x, task: e.target.value } : x)),
                      })
                    }
                  />
                  <div className="plan-files">
                    {t.files.map((f) => (
                      <span
                        key={f}
                        className={`file-chip ${sharedFiles.has(f) ? "shared" : ""}`}
                        title={sharedFiles.has(f) ? "Shared with another task: agents will take turns" : undefined}
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <div className="launcher-actions">
                <button className="btn btn-sm" onClick={() => setPlan(null)}>
                  Discard plan
                </button>
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => void makePlan()}>
                  {busy === "plan" ? "Re-planning…" : "Re-plan"}
                </button>
                <span className="grow" />
                <span className="muted small">{running} running</span>
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || plan.tasks.length === 0 || running + plan.tasks.length > MAX_ACTIVE}
                  onClick={() => void launch({ tasks: plan.tasks.map((t) => ({ name: t.name, task: t.task })) })}
                >
                  {busy === "launch"
                    ? "Forking…"
                    : `Launch ${plan.tasks.length} agent${plan.tasks.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {tasks.map((task, i) => (
            <div key={i} className="task-row">
              <textarea
                value={task}
                rows={2}
                maxLength={4000}
                placeholder={i === 0 ? "One agent per task, e.g. Add rate limiting to POST /login" : "Another task"}
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
            <span className="grow" />
            {remaining !== null && <span className="muted small">{remaining} agent runs left today</span>}
            <span className="muted small">{running} running</span>
            <button
              className="btn btn-primary"
              disabled={busy !== null || filled.length === 0}
              onClick={() => void launch({ tasks: filled.map((task) => ({ task })) })}
            >
              {busy === "launch" ? "Forking…" : `Launch ${filled.length || ""} agent${filled.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
      {error && <ErrorBox error={error} />}
    </section>
  );
}

function Stats({ state }: { state: RepoState }) {
  const items = [
    { label: "Merged", value: state.stats.merges, tone: "good" },
    { label: "Awaiting review", value: state.intents.filter((i) => i.status === "review").length, tone: "honey" },
    { label: "Collisions avoided", value: state.stats.collisionsAvoided, tone: "" },
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
        <Link to={`/${owner}/${name}/agents/${agent.id}`} className="agent-name">
          {agent.name}
        </Link>
        <span className="badge">{STATUS_LABEL[agent.status]}</span>
      </div>
      <div className="agent-task">{agent.task}</div>
      <div className="agent-detail">{agent.detail}</div>
      <div className="agent-foot">
        <Link to={`/${owner}/${name}/agents/${agent.id}`} className="fork-link">
          transcript
        </Link>
        <Link to={`/${owner}/${name}?fork=${agent.id}`} className="fork-link" title="Browse this agent's fork">
          fork
        </Link>
        {intent && (
          <Link to={`/${owner}/${name}/intents#${intent.id}`} className="fork-link">
            intent: {INTENT_LABEL[intent.status]}
          </Link>
        )}
        {intent?.mergedAs && (
          <Link to={`/${owner}/${name}/commit/${intent.mergedAs}`} className="fork-link">
            {shortSha(intent.mergedAs)}
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

export function LeaseMap() {
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
                  <span
                    key={l.id}
                    className={`holder ${agent ? "" : "human"}`}
                    style={{ background: agent?.color }}
                    title={l.reason}
                  >
                    {agent?.name ?? l.holderName}
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
  const who = (id: string, fallback?: string) => {
    const agent = agents.get(id);
    return <b style={{ color: agent?.color }}>{agent?.name ?? fallback ?? id.replace(/^human:/, "")}</b>;
  };
  const commitLink = (sha: string) => (
    <Link to={`/${owner}/${name}/commit/${sha}`}>
      <code>{shortSha(sha)}</code>
    </Link>
  );

  const describe = (e: HiveEvent) => {
    switch (e.type) {
      case "repo.ready":
        return <>Repository ready at {commitLink(e.head)}</>;
      case "repo.failed":
        return <>Repository failed: {e.error}</>;
      case "repo.settings":
        return (
          <>
            Settings: leases {e.leasesEnabled ? "on" : "off"},{" "}
            {e.mergeMode === "review" ? "review before merge" : "auto-merge"}
          </>
        );
      case "agent.joined":
        return <>{who(e.agent.id)} started with its own fork</>;
      case "agent.status":
      case "lease.released":
        return null;
      case "lease.granted":
        return (
          <>
            {who(e.lease.agentId, e.lease.holderName)} leased <code>{e.lease.path}</code>{" "}
            <span className="muted">{e.lease.reason}</span>
          </>
        );
      case "lease.denied":
        return (
          <>
            {who(e.agentId)} blocked on <code>{e.scope.path}</code>, held by{" "}
            {who(e.holder.agentId, e.holder.holderName)}
          </>
        );
      case "intent.queued":
        return (
          <>
            {who(e.intent.agentId)} submitted “{e.intent.summary}”
            {e.intent.attempts > 1 ? ` (attempt ${e.intent.attempts})` : ""}
          </>
        );
      case "intent.review":
        return (
          <>
            {who(e.agentId)}’s intent is <Link to={`/${owner}/${name}/intents#${e.intentId}`}>awaiting review</Link>
          </>
        );
      case "intent.changes_requested":
        return (
          <>
            <b>{e.by}</b> requested changes from {who(e.agentId)}: <span className="muted">{e.comment}</span>
          </>
        );
      case "intent.merged":
        return (
          <>
            {who(e.agentId)} merged {commitLink(e.commit.sha)}
            {e.mode === "auto-merge" ? " (3-way auto-merge)" : ""}
          </>
        );
      case "intent.reverted":
        return (
          <>
            <b>{e.by}</b> reverted {who(e.agentId)}’s intent in {commitLink(e.commit.sha)}
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
      case "intent.checking":
        return <>Checking {who(e.agentId)}’s change in a sandbox</>;
      case "intent.checked":
        return (
          <>
            Checks {e.result.status} for {who(e.agentId)}
            {e.result.durationMs > 0 && <span className="muted"> ({Math.round(e.result.durationMs / 1000)}s)</span>}
          </>
        );
      case "github.synced":
        return (
          <>
            <b>{e.by}</b> synced from GitHub{e.commit ? <> in {commitLink(e.commit.sha)}</> : " (no changes)"}
          </>
        );
      case "github.pr":
        return (
          <>
            <b>{e.by}</b> opened{" "}
            <a href={e.pr.url} target="_blank" rel="noreferrer">
              pull request #{e.pr.number}
            </a>
          </>
        );
      case "commit.external":
        return <>New commit pushed outside Hive: {commitLink(e.head)}</>;
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
