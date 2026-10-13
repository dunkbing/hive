import type { Goal, TaskItem, TaskStatus } from "@hive/core";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, INTENT_LABEL, STATUS_LABEL, timeAgo } from "../components.tsx";
import { useSession } from "../session.tsx";
import { useRepo } from "./RepoLayout.tsx";

export const TASK_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  closed: "Closed",
};
const COLUMNS: TaskStatus[] = ["open", "in_progress", "in_review", "done"];
const splitLabels = (s: string) => [
  ...new Set(
    s
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];

/** Runs an async action with busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useSession();
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
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
  return { busy, error, run };
}

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  return <span className={`pill task-${status}`}>{TASK_LABEL[status]}</span>;
}

export function GoalStatusPill({ goal }: { goal: Goal }) {
  const label = { active: "Active", review: "Ready for review", done: "Done", closed: "Closed" }[goal.status];
  return <span className={`pill goal-${goal.status}`}>{label}</span>;
}

export function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="progress" title={`${done} of ${total} tasks done`}>
      <span className="progress-bar">
        <span style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
      </span>
      <span className="muted small">
        {done}/{total}
      </span>
    </span>
  );
}

export function goalProgress(goalNumber: number, tasks: TaskItem[]) {
  const mine = tasks.filter((t) => t.goalNumber === goalNumber);
  return { done: mine.filter((t) => t.status === "done").length, total: mine.length };
}

function useAssignee(task: TaskItem) {
  const { state } = useRepo();
  const agent = task.agentId ? state.agents.find((a) => a.id === task.agentId) : undefined;
  return {
    agent,
    label: agent?.name ?? (task.assignee?.startsWith("user:") ? task.assignee.slice(5) : null),
  };
}

export function TasksTab() {
  const { state, canWrite } = useRepo();
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const closed = state.tasks.filter((t) => t.status === "closed");
  return (
    <div className="tasks-tab">
      <div className="row tasks-head">
        <span className="muted small">{state.tasks.length} tasks</span>
        <span className="grow" />
        {closed.length > 0 && (
          <label className="muted small">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
            ({closed.length})
          </label>
        )}
        {canWrite && (
          <button className="btn btn-primary btn-sm" onClick={() => setCreating((c) => !c)}>
            New task
          </button>
        )}
      </div>
      {creating && <NewTask onDone={() => setCreating(false)} />}
      <div className="board">
        {[...COLUMNS, ...(showClosed ? (["closed"] as const) : [])].map((status) => {
          const items = state.tasks.filter((t) => t.status === status).sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <section key={status} className="board-col">
              <h3>
                {TASK_LABEL[status]} <span className="count">{items.length}</span>
              </h3>
              {items.map((t) => (
                <TaskCard key={t.number} task={t} />
              ))}
              {items.length === 0 && <p className="muted small">Nothing here.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function NewTask({ onDone }: { onDone: () => void }) {
  const { owner, name } = useRepo();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run("create", async () => {
      await api.createTask(owner, name, { title: title.trim(), body, labels: splitLabels(labels) });
      onDone();
    });
  };
  return (
    <form className="panel task-form" onSubmit={submit}>
      <input value={title} maxLength={200} placeholder="Title" autoFocus onChange={(e) => setTitle(e.target.value)} />
      <textarea
        value={body}
        rows={4}
        placeholder="Describe the task (Markdown)"
        onChange={(e) => setBody(e.target.value)}
      />
      <input value={labels} placeholder="Labels, comma separated" onChange={(e) => setLabels(e.target.value)} />
      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={busy !== null || !title.trim()}>
          {busy ? "Creating…" : "Create task"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <ErrorBox error={error} />}
    </form>
  );
}

function TaskCard({ task }: { task: TaskItem }) {
  const { owner, name } = useRepo();
  const { agent, label } = useAssignee(task);
  return (
    <Link to={`/${owner}/${name}/tasks/${task.number}`} className="task-card">
      <div className="task-card-title">
        <span className="muted">#{task.number}</span> {task.title}
      </div>
      <div className="task-card-foot">
        {task.labels.map((l) => (
          <span key={l} className="file-chip">
            {l}
          </span>
        ))}
        {task.goalNumber != null && <span className="pill">goal #{task.goalNumber}</span>}
        <span className="grow" />
        {label && (
          <span className="small" style={{ color: agent?.color }}>
            {label}
          </span>
        )}
      </div>
    </Link>
  );
}

export function TaskPage() {
  const { owner, name, state, canWrite, setState } = useRepo();
  const { number = "" } = useParams();
  const task = state.tasks.find((t) => t.number === Number(number));
  const { agent, label } = useAssignee(task ?? ({ agentId: null, assignee: null } as TaskItem));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", labels: "" });
  const { busy, error, run } = useAction();
  const base = `/${owner}/${name}`;

  if (!task) return <ErrorBox error={`Task #${number} not found.`} />;
  const n = task.number;
  const intent = task.intentId ? state.intents.find((i) => i.id === task.intentId) : undefined;
  const merge = (t: TaskItem) => setState({ ...state, tasks: state.tasks.map((x) => (x.number === t.number ? t : x)) });
  const act = (l: string, call: () => Promise<TaskItem>) => run(l, async () => merge(await call()));
  const closed = task.status === "closed";

  return (
    <div className="task-page">
      <Link to={`${base}/tasks`} className="muted small">
        ← All tasks
      </Link>
      {editing ? (
        <form
          className="panel task-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act("save", async () => {
              const t = await api.updateTask(owner, name, n, {
                title: draft.title.trim(),
                body: draft.body,
                labels: splitLabels(draft.labels),
              });
              setEditing(false);
              return t;
            });
          }}
        >
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea value={draft.body} rows={8} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <input
            value={draft.labels}
            placeholder="Labels, comma separated"
            onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
          />
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={busy !== null || !draft.title.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="panel">
          <div className="row">
            <h2 className="grow">
              <span className="muted">#{n}</span> {task.title}
            </h2>
            <TaskStatusPill status={task.status} />
          </div>
          <div className="muted small task-meta">
            opened by {task.createdBy} {timeAgo(task.createdAt)}
            {label && (
              <>
                {" · assigned to "}
                <b style={{ color: agent?.color }}>{label}</b>
              </>
            )}
            {task.goalNumber != null && (
              <>
                {" · "}
                <Link to={`${base}/goals/${task.goalNumber}`}>goal #{task.goalNumber}</Link>
              </>
            )}
          </div>
          {task.labels.length > 0 && (
            <div className="task-card-foot">
              {task.labels.map((l) => (
                <span key={l} className="file-chip">
                  {l}
                </span>
              ))}
            </div>
          )}
          <pre className="commit-body">{task.body || "No description."}</pre>
          <div className="row wrap">
            {agent && (
              <Link className="btn btn-sm" to={`${base}/agents/${agent.id}`}>
                Transcript ({STATUS_LABEL[agent.status]})
              </Link>
            )}
            {(intent || task.intentId) && (
              <Link className="btn btn-sm" to={`${base}/intents#${task.intentId}`}>
                Intent{intent ? `: ${INTENT_LABEL[intent.status]}` : ""}
              </Link>
            )}
          </div>
        </div>
      )}
      {canWrite && !editing && (
        <div className="row wrap">
          {!closed && task.status !== "done" && (
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy !== null || task.status === "in_progress"}
                onClick={() => void act("agent", () => api.assignTask(owner, name, n, "agent"))}
              >
                {busy === "agent" ? "Launching…" : "Launch agent"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void act("me", () => api.assignTask(owner, name, n, "me"))}
              >
                Take it
              </button>
              {task.assignee && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void act("none", () => api.assignTask(owner, name, n, "none"))}
                >
                  Unassign
                </button>
              )}
            </>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              setDraft({ title: task.title, body: task.body, labels: task.labels.join(", ") });
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            className={`btn btn-sm ${closed ? "" : "btn-danger"}`}
            disabled={busy !== null}
            onClick={() =>
              void act("status", () => api.updateTask(owner, name, n, { status: closed ? "open" : "closed" }))
            }
          >
            {closed ? "Reopen" : "Close"}
          </button>
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </div>
  );
}
