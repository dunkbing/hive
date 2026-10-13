import { shortSha } from "@hive/core";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, FileDiff, INTENT_LABEL, STATUS_LABEL, Spinner, timeAgo } from "../components.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { GoalStatusPill, Progress, TaskStatusPill, goalProgress, useAction } from "./TasksTab.tsx";

const modeLabel = (mode: string) => (mode === "branch" ? "goal branch" : "direct");

export function GoalsTab() {
  const { owner, name, state } = useRepo();
  if (state.goals.length === 0) {
    return (
      <div className="empty-card">
        <p className="muted">No goals yet. Describe a goal on the Agents tab and Hive will plan it.</p>
      </div>
    );
  }
  return (
    <ul className="goal-list">
      {[...state.goals].reverse().map((g) => {
        const { done, total } = goalProgress(g.number, state.tasks);
        return (
          <li key={g.number} className="panel">
            <div className="row">
              <Link className="grow" to={`/${owner}/${name}/goals/${g.number}`}>
                <b>
                  <span className="muted">#{g.number}</span> {g.title}
                </b>
              </Link>
              <span className="pill">{modeLabel(g.mode)}</span>
              <GoalStatusPill goal={g} />
            </div>
            <div className="row">
              <Progress done={done} total={total} />
              <span className="muted small">{timeAgo(g.updatedAt)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function GoalPage() {
  const { owner, name, state, canWrite } = useRepo();
  const { number = "" } = useParams();
  const goal = state.goals.find((g) => g.number === Number(number));
  const { busy, error, run } = useAction();
  const [merge, setMerge] = useState<{ status: string; files?: string[]; log?: string } | null>(null);
  const base = `/${owner}/${name}`;
  const isBranch = goal?.mode === "branch";
  const diff = useLoad(
    () => (isBranch ? api.goalDiff(owner, name, Number(number)) : Promise.resolve(null)),
    `goal-diff:${owner}/${name}:${number}:${isBranch}:${state.head}:${state.intents.length}`,
  );

  if (!goal) return <ErrorBox error={`Goal #${number} not found.`} />;
  const tasks = state.tasks.filter((t) => t.goalNumber === goal.number);
  const intents = state.intents.filter((i) => i.goalNumber === goal.number);
  const { done, total } = goalProgress(goal.number, state.tasks);
  const open = goal.status === "active" || goal.status === "review";

  return (
    <div className="goal-page">
      <Link to={`${base}/goals`} className="muted small">
        ← All goals
      </Link>
      <div className="panel">
        <div className="row">
          <h2 className="grow">
            <span className="muted">#{goal.number}</span> {goal.title}
          </h2>
          <GoalStatusPill goal={goal} />
        </div>
        {goal.summary && <p>{goal.summary}</p>}
        <div className="row wrap muted small">
          <span>
            {isBranch ? (
              <>
                Reviewed as one unit on <code>{goal.branch}</code>
              </>
            ) : (
              "Each intent lands as it merges"
            )}
          </span>
          <span>· by {goal.createdBy}</span>
          <span>· {timeAgo(goal.createdAt)}</span>
          {goal.mergedAs && (
            <Link to={`${base}/commit/${goal.mergedAs}`}>
              merged as <code>{shortSha(goal.mergedAs)}</code>
            </Link>
          )}
        </div>
        <Progress done={done} total={total} />
        {canWrite && isBranch && goal.status === "review" && (
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void run("merge", async () => setMerge(await api.mergeGoal(owner, name, goal.number)))}
            >
              {busy === "merge" ? "Merging…" : `Merge goal into ${state.branch}`}
            </button>
          </div>
        )}
        {canWrite && open && (
          <div className="row">
            <button
              className="btn btn-danger btn-sm"
              disabled={busy !== null}
              onClick={() => void run("close", () => api.closeGoal(owner, name, goal.number))}
            >
              Close goal
            </button>
          </div>
        )}
        {merge?.status === "conflict" && (
          <ErrorBox error={`Merge conflict in ${merge.files?.join(", ") || "some files"}. The goal was not merged.`} />
        )}
        {merge?.status === "check_failed" && (
          <>
            <ErrorBox error="Checks failed on the merged result. The goal was not merged." />
            <pre className="check-log">{merge.log || "(no output)"}</pre>
          </>
        )}
        {goal.mergeError && merge?.status !== "conflict" && merge?.status !== "check_failed" && (
          <ErrorBox error={`Last merge attempt: ${goal.mergeError}`} />
        )}
        {error && <ErrorBox error={error} />}
      </div>

      <section className="panel">
        <h2>Tasks</h2>
        {tasks.length === 0 ? (
          <p className="muted">No tasks.</p>
        ) : (
          <ul className="goal-tasks">
            {tasks.map((t) => {
              const agent = t.agentId ? state.agents.find((a) => a.id === t.agentId) : undefined;
              return (
                <li key={t.number} className="row">
                  <Link className="grow" to={`${base}/tasks/${t.number}`}>
                    <span className="muted">#{t.number}</span> {t.title}
                  </Link>
                  {agent && (
                    <Link to={`${base}/agents/${agent.id}`} style={{ color: agent.color }} className="small">
                      {agent.name} · {STATUS_LABEL[agent.status]}
                    </Link>
                  )}
                  <TaskStatusPill status={t.status} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Intents</h2>
        {intents.length === 0 ? (
          <p className="muted">No intents submitted yet.</p>
        ) : (
          <ul className="goal-tasks">
            {intents.map((i) => (
              <li key={i.id} className="row">
                <Link className="grow" to={`${base}/intents#${i.id}`}>
                  {i.summary}
                </Link>
                {i.check && <span className={`pill check-pill-${i.check.status}`}>checks {i.check.status}</span>}
                <span className={`pill intent-${i.status}`}>{INTENT_LABEL[i.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{isBranch ? "Combined changes" : "Merged commits"}</h2>
        {isBranch ? (
          diff.error ? (
            <ErrorBox error={diff.error} />
          ) : !diff.data ? (
            <Spinner />
          ) : diff.data.files.length === 0 ? (
            <p className="muted">No changes on the goal branch yet.</p>
          ) : (
            diff.data.files.map((f) => <FileDiff key={f.path} change={f} defaultOpen={diff.data!.files.length <= 8} />)
          )
        ) : intents.some((i) => i.mergedAs) ? (
          <ul className="goal-tasks">
            {intents
              .filter((i) => i.mergedAs)
              .map((i) => (
                <li key={i.id} className="row">
                  <Link to={`${base}/commit/${i.mergedAs}`}>
                    <code>{shortSha(i.mergedAs!)}</code>
                  </Link>
                  <span>{i.summary}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="muted">Nothing merged yet.</p>
        )}
      </section>
    </div>
  );
}
