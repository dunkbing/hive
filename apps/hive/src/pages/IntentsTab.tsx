import { shortSha, type CheckResult, type Intent } from "@hive/core";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, FileDiff, INTENT_LABEL, Spinner, timeAgo, useTick } from "../components.tsx";
import { useRepo } from "./RepoLayout.tsx";

type Filter = "review" | "all";

/** The review queue and the history of every intent, with approve / request changes / reject / revert. */
export function IntentsTab() {
  const { state } = useRepo();
  const pending = state.intents.filter((i) => i.status === "review");
  const [filter, setFilter] = useState<Filter>(pending.length ? "review" : "all");
  const { hash } = useLocation();
  useTick();

  // Deep links (#intentId) show everything so the target is on screen.
  useEffect(() => {
    if (hash) setFilter("all");
  }, [hash]);

  const shown = filter === "review" ? pending : state.intents;
  return (
    <div className="intents-tab">
      <div className="row intents-head">
        <div className="segmented">
          <button className={filter === "review" ? "on" : ""} onClick={() => setFilter("review")}>
            Awaiting review ({pending.length})
          </button>
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            All intents ({state.intents.length})
          </button>
        </div>
        <span className="grow" />
        <span className="muted small">
          Merge mode: <b>{state.mergeMode === "review" ? "review before merge" : "auto-merge"}</b>
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="empty-card">
          <p className="muted">
            {filter === "review"
              ? state.mergeMode === "review"
                ? "Nothing to review right now."
                : "Auto-merge is on, so intents land without review. Switch to “Review before merge” on the Agents tab or in Settings."
              : "No intents yet. Launch agents from the Agents tab."}
          </p>
        </div>
      ) : (
        shown.map((intent) => <IntentCard key={intent.id} intent={intent} highlighted={hash === `#${intent.id}`} />)
      )}
    </div>
  );
}

function IntentCard({ intent, highlighted }: { intent: Intent; highlighted: boolean }) {
  const { owner, name, state, canWrite } = useRepo();
  const agent = state.agents.find((a) => a.id === intent.agentId);
  const reviewing = intent.status === "review";
  const [showDiff, setShowDiff] = useState(reviewing || highlighted);

  return (
    <article id={intent.id} className={`intent-card panel ${highlighted ? "highlight" : ""}`}>
      <div className="intent-head">
        <span className={`pill intent-${intent.status}`}>{INTENT_LABEL[intent.status]}</span>
        <h3>{intent.summary}</h3>
      </div>
      <div className="muted small intent-meta">
        by{" "}
        {agent ? (
          <Link to={`/${owner}/${name}/agents/${agent.id}`} style={{ color: agent.color }}>
            <b>{agent.name}</b>
          </Link>
        ) : (
          intent.agentId
        )}{" "}
        · {timeAgo(intent.createdAt)} · attempt {intent.attempts} · {intent.files.length} file
        {intent.files.length === 1 ? "" : "s"}
        {intent.mergedAs && (
          <>
            {" "}
            · merged as{" "}
            <Link to={`/${owner}/${name}/commit/${intent.mergedAs}`}>
              <code>{shortSha(intent.mergedAs)}</code>
            </Link>
          </>
        )}
        {intent.revertedAs && (
          <>
            {" "}
            · reverted in{" "}
            <Link to={`/${owner}/${name}/commit/${intent.revertedAs}`}>
              <code>{shortSha(intent.revertedAs)}</code>
            </Link>
          </>
        )}
      </div>
      {agent && <p className="intent-task">Task: {agent.task}</p>}
      {intent.reviewComment && <p className="review-comment">“{intent.reviewComment}”</p>}
      {intent.conflicts?.length ? (
        <p className="muted small">
          Conflicted on{" "}
          {intent.conflicts.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </p>
      ) : null}

      {intent.check && <CheckView check={intent.check} />}

      <button className="link small" onClick={() => setShowDiff((s) => !s)}>
        {showDiff ? "Hide changes" : "Show changes"}
      </button>
      {showDiff && <IntentDiff intent={intent} />}

      {canWrite && reviewing && <ReviewActions intent={intent} />}
      {canWrite && intent.status === "merged" && <RevertAction intent={intent} />}
    </article>
  );
}

function CheckView({ check }: { check: CheckResult }) {
  const { state } = useRepo();
  const [open, setOpen] = useState(check.status === "failed");
  const label = { passed: "Checks passed", failed: "Checks failed", skipped: "Checks skipped" }[check.status];
  return (
    <div className={`check check-${check.status}`}>
      <button className="link small" onClick={() => setOpen((o) => !o)}>
        <span className={`pill check-pill-${check.status}`}>{label}</span>{" "}
        <span className="muted">
          {state.checkCommand && <code>{state.checkCommand}</code>}{" "}
          {check.durationMs > 0 && `${Math.round(check.durationMs / 1000)}s`} {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <pre className="check-log">{check.log || "(no output)"}</pre>}
    </div>
  );
}

/** The agent's change: its fork commit against the head it was built on. */
function IntentDiff({ intent }: { intent: Intent }) {
  const { owner, name } = useRepo();
  const detail = useLoad(
    () => api.commit(owner, name, intent.commit, intent.agentId),
    `intent-diff:${intent.id}:${intent.commit}`,
  );
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <Spinner />;
  return (
    <div className="intent-diff">
      {detail.data.files.map((f) => (
        <FileDiff key={f.path} change={f} defaultOpen={detail.data!.files.length <= 6} />
      ))}
    </div>
  );
}

function ReviewActions({ intent }: { intent: Intent }) {
  const { owner, name } = useRepo();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const act = async (label: string, action: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setError(null);
    try {
      const r = await action();
      const status = (r as { status?: string } | undefined)?.status;
      setResult(status === "conflict" ? "Conflicts with newer changes; the agent is replaying its intent." : done);
      setComment("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="review-actions">
      <textarea
        rows={2}
        value={comment}
        maxLength={4000}
        placeholder="Comment for the agent (required to request changes)"
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy !== null}
          onClick={() => void act("approve", () => api.approve(owner, name, intent.id), "Approved and merged.")}
        >
          {busy === "approve" ? "Merging…" : "Approve and merge"}
        </button>
        <button
          className="btn btn-sm"
          disabled={busy !== null || !comment.trim()}
          onClick={() =>
            void act(
              "changes",
              () => api.requestChanges(owner, name, intent.id, comment.trim()),
              "Sent back to the agent.",
            )
          }
        >
          Request changes
        </button>
        <button
          className="btn btn-danger btn-sm"
          disabled={busy !== null}
          onClick={() => void act("reject", () => api.reject(owner, name, intent.id, comment.trim()), "Rejected.")}
        >
          Reject
        </button>
        {result && <span className="muted small">{result}</span>}
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function RevertAction({ intent }: { intent: Intent }) {
  const { owner, name } = useRepo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.revert(owner, name, intent.id);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-actions">
      {confirming ? (
        <div className="row">
          <span className="small">Undo this intent with a new commit?</span>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void revert()}>
            {busy ? "Reverting…" : "Revert"}
          </button>
          <button className="btn btn-sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button className="btn btn-sm" onClick={() => setConfirming(true)}>
            Revert
          </button>
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </div>
  );
}
