import { shortSha } from "@hive/core";
import { Link, useParams, useSearchParams } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, FileDiff, Spinner, parseMessage, timeAgo } from "../components.tsx";
import { useRepo } from "./RepoLayout.tsx";

export function CommitPage() {
  const { owner, name, state } = useRepo();
  const { sha = "" } = useParams();
  const [params] = useSearchParams();
  const fork = params.get("fork") ?? undefined;
  const detail = useLoad(() => api.commit(owner, name, sha, fork), `commit:${sha}:${fork}`);

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <Spinner />;
  const { commit, files, truncated } = detail.data;
  const { subject, body, trailers } = parseMessage(commit.message);
  const intent = trailers["Hive-Intent"] ? state.intents.find((i) => i.id === trailers["Hive-Intent"]) : undefined;
  const agent = intent
    ? state.agents.find((a) => a.id === intent.agentId)
    : state.agents.find((a) => a.name === commit.author);
  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;

  return (
    <div className="commit-page">
      <div className="commit-card">
        <h2>{subject}</h2>
        {body && <pre className="commit-body">{body}</pre>}
        <div className="commit-meta-row">
          <span>
            <span className="dot" style={{ background: agent?.color ?? "var(--muted)" }} /> <b>{commit.author}</b>{" "}
            committed {timeAgo(commit.at)}
          </span>
          <span className="muted">
            commit <code>{commit.sha}</code>
          </span>
          {commit.parents[0] && (
            <span className="muted">
              parent{" "}
              <Link to={`/${owner}/${name}/commit/${commit.parents[0]}${fork ? `?fork=${fork}` : ""}`}>
                <code>{shortSha(commit.parents[0])}</code>
              </Link>
            </span>
          )}
          <Link className="btn btn-sm" to={`/${owner}/${name}?ref=${commit.sha}${fork ? `&fork=${fork}` : ""}`}>
            Browse files
          </Link>
        </div>
        {(intent || agent) && (
          <div className="intent-card">
            <div>
              <span className="pill pill-agent">Hive intent</span> {intent ? <b>“{intent.summary}”</b> : null}
            </div>
            <div className="muted small">
              {agent && (
                <>
                  Written by <b style={{ color: agent.color }}>{agent.name}</b> for the task: {agent.task}
                  <br />
                </>
              )}
              {intent && (
                <>
                  Landed after {intent.attempts} attempt{intent.attempts > 1 ? "s" : ""}.{" "}
                  {agent && (
                    <Link to={`/${owner}/${name}/commits?fork=${agent.id}`}>View {agent.name}'s fork history</Link>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="muted small diff-summary">
        Showing {files.length} changed file{files.length === 1 ? "" : "s"}
        {added ? `, ${added} added` : ""}
        {deleted ? `, ${deleted} deleted` : ""}
        {truncated && " (truncated)"}
      </div>
      {files.map((f) => (
        <FileDiff key={f.path} change={f} defaultOpen={files.length <= 12} />
      ))}
    </div>
  );
}
