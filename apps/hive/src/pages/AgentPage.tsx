import { shortSha, type TranscriptStep } from "@hive/core";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, INTENT_LABEL, STATUS_LABEL, Spinner, isRunning, timeAgo, useTick } from "../components.tsx";
import { NotFound } from "./Shell.tsx";
import { useRepo } from "./RepoLayout.tsx";

const ICON: Record<TranscriptStep["kind"], string> = {
  run: "▶",
  thinking: "✦",
  text: "💬",
  tool: "⚙",
  message: "✉",
  status: "●",
};

export function AgentPage() {
  const { owner, name, state, canWrite } = useRepo();
  const { agentId = "" } = useParams();
  const agent = state.agents.find((a) => a.id === agentId);
  const intent = state.intents.find((i) => i.agentId === agentId);
  const [steps, setSteps] = useState<TranscriptStep[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(0);
  const running = agent ? isRunning(agent.status) : false;
  useTick(10_000);

  // Poll for new steps; quickly while the agent runs, slowly otherwise (a message can restart it).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await api.agent(owner, name, agentId, lastId.current);
        if (cancelled) return;
        if (res.steps.length) {
          lastId.current = res.steps[res.steps.length - 1].id;
          setSteps((s) => [...s, ...res.steps]);
        }
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      if (!cancelled) timer = setTimeout(load, running ? 2000 : 8000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [owner, name, agentId, running]);

  if (!agent) return <NotFound message="No such agent in this repository." />;

  const runs = [...new Set(steps.map((s) => s.run))];

  return (
    <div className="agent-page">
      <div className="agent-page-head panel" style={{ "--agent": agent.color } as React.CSSProperties}>
        <div className="agent-head">
          <span className="dot" style={{ background: agent.color }} />
          <h2 className="agent-title">{agent.name}</h2>
          <span className={`badge status-badge-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
          <span className="grow" />
          <Link className="btn btn-sm" to={`/${owner}/${name}?fork=${agent.id}`}>
            Browse fork
          </Link>
          {intent && (
            <Link className="btn btn-sm" to={`/${owner}/${name}/intents#${intent.id}`}>
              Intent: {INTENT_LABEL[intent.status]}
            </Link>
          )}
          {intent?.mergedAs && (
            <Link className="btn btn-sm" to={`/${owner}/${name}/commit/${intent.mergedAs}`}>
              Commit {shortSha(intent.mergedAs)}
            </Link>
          )}
        </div>
        <p className="agent-page-task">{agent.task}</p>
        <div className="muted small">
          {agent.detail} · started {timeAgo(agent.joinedAt)}
        </div>
        {canWrite && <AgentActions agentId={agent.id} running={running} />}
      </div>

      {error && <ErrorBox error={error} />}
      {!loaded ? (
        <Spinner />
      ) : steps.length === 0 ? (
        <p className="muted">No steps yet.</p>
      ) : (
        runs.map((run) => (
          <section key={run} className="run">
            <h3 className="run-title">{run === 1 ? "First run" : `Run ${run}`}</h3>
            <ol className="steps">
              {steps
                .filter((s) => s.run === run)
                .map((s) => (
                  <Step key={s.id} step={s} />
                ))}
            </ol>
          </section>
        ))
      )}
      {running && <Spinner label="Working…" />}
    </div>
  );
}

function Step({ step }: { step: TranscriptStep }) {
  const collapsible = step.kind === "tool" || step.kind === "run";
  const [open, setOpen] = useState(!collapsible || step.error);
  const hasBody = !!step.body?.trim();
  return (
    <li className={`step step-${step.kind} ${step.error ? "step-error" : ""}`}>
      <button
        className="step-head"
        onClick={() => hasBody && collapsible && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody || !collapsible}
      >
        <span className="step-icon" aria-hidden="true">
          {ICON[step.kind]}
        </span>
        <span className={step.kind === "tool" ? "mono" : ""}>{step.title}</span>
        <span className="grow" />
        <time className="muted small">{new Date(step.ts).toLocaleTimeString()}</time>
      </button>
      {hasBody && open && <pre className="step-body">{step.body}</pre>}
    </li>
  );
}

function AgentActions({ agentId, running }: { agentId: string; running: boolean }) {
  const { owner, name } = useRepo();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSent(done);
      setMessage("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-actions">
      <textarea
        value={message}
        rows={2}
        maxLength={4000}
        placeholder={
          running
            ? "Message the agent while it works, e.g. 'use the existing json() helper instead'"
            : "Ask a question or request a change; the agent starts a new run"
        }
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !message.trim()}
          onClick={() =>
            void run(
              () => api.messageAgent(owner, name, agentId, message.trim()),
              running ? "Sent. The agent reads it on its next step." : "Sent. The agent is starting a new run.",
            )
          }
        >
          Send message
        </button>
        {running && (
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => void run(() => api.cancelAgent(owner, name, agentId), "Cancelling…")}
          >
            Cancel agent
          </button>
        )}
        {sent && <span className="muted small">{sent}</span>}
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}
