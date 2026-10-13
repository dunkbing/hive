import { shortSha, type CommitSummary } from "@hive/core";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, Spinner, parseMessage, timeAgo, useTick } from "../components.tsx";
import { useRepo } from "./RepoLayout.tsx";

const PAGE = 30;

export function CommitsTab() {
  const { owner, name, state } = useRepo();
  const [params, setParams] = useSearchParams();
  const fork = params.get("fork") ?? undefined;
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [more, setMore] = useState(false);
  useTick();

  // Reload when the default branch moves so new agent merges appear.
  useEffect(() => {
    let cancelled = false;
    api.commits(owner, name, { fork }).then(
      (list) => {
        if (cancelled) return;
        setCommits(list);
        setMore(list.length === PAGE);
      },
      (err: Error) => !cancelled && setError(err),
    );
    return () => {
      cancelled = true;
    };
  }, [owner, name, fork, state.head]);

  const loadMore = async () => {
    const next = await api.commits(owner, name, { fork, offset: commits?.length ?? 0 });
    setCommits((c) => [...(c ?? []), ...next]);
    setMore(next.length === PAGE);
  };

  const agentsByName = new Map(state.agents.map((a) => [a.name, a]));

  return (
    <div>
      <div className="code-toolbar">
        <label className="select">
          <span className="muted">History of</span>
          <select value={fork ?? ""} onChange={(e) => setParams(e.target.value ? { fork: e.target.value } : {})}>
            <option value="">{state.branch} (default)</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}'s fork
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <ErrorBox error={error} />
      ) : !commits ? (
        <Spinner />
      ) : (
        <ul className="commit-list">
          {commits.map((c) => {
            const { subject, trailers } = parseMessage(c.message);
            const agent = agentsByName.get(c.author);
            return (
              <li key={c.sha}>
                <span className="dot" style={{ background: agent?.color ?? "var(--muted)" }} />
                <div className="grow">
                  <Link
                    to={`/${owner}/${name}/commit/${c.sha}${fork ? `?fork=${fork}` : ""}`}
                    className="commit-subject"
                  >
                    {subject}
                  </Link>
                  <div className="muted small">
                    <b>{c.author}</b> committed {timeAgo(c.at)}
                    {trailers["Hive-Intent"] && (
                      <span className="pill pill-agent">intent {trailers["Hive-Intent"]}</span>
                    )}
                  </div>
                </div>
                <Link className="sha" to={`/${owner}/${name}/commit/${c.sha}${fork ? `?fork=${fork}` : ""}`}>
                  {shortSha(c.sha)}
                </Link>
                <Link
                  className="btn btn-ghost btn-sm"
                  to={`/${owner}/${name}?ref=${c.sha}${fork ? `&fork=${fork}` : ""}`}
                  title="Browse files at this commit"
                >
                  &lt;&gt;
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <button className="btn" onClick={() => void loadMore()}>
          Older commits
        </button>
      )}
    </div>
  );
}
