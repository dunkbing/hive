import { shortSha } from "@hive/core";
import { useState } from "react";
import { api } from "../api.ts";
import { ErrorBox, timeAgo, useTick } from "../components.tsx";
import { useSession } from "../session.tsx";
import { NotFound } from "./Shell.tsx";
import { useRepo } from "./RepoLayout.tsx";

/** Round trip with the GitHub repository this one was imported from. */
export function GithubTab() {
  const { owner, name, state, canWrite } = useRepo();
  const { me, refresh } = useSession();
  useTick();
  const link = state.github;
  if (!link) return <NotFound message="This repository was not imported from GitHub." />;
  const connectUrl = `/auth/github?scope=repo&next=${encodeURIComponent(`/${owner}/${name}/github`)}`;
  const merged = state.intents.filter((i) => i.status === "merged");

  return (
    <div className="github-tab">
      <section className="panel">
        <h2>Source</h2>
        <p>
          Imported from{" "}
          <a href={`https://github.com/${link.repo}`} target="_blank" rel="noreferrer">
            github.com/{link.repo}
          </a>
          {link.base && (
            <>
              {" "}
              · last synced at{" "}
              <a href={`https://github.com/${link.repo}/commit/${link.base}`} target="_blank" rel="noreferrer">
                <code>{shortSha(link.base)}</code>
              </a>
            </>
          )}
        </p>
        {canWrite && <SyncButton />}
      </section>

      <section className="panel">
        <h2>Pull request</h2>
        <p className="muted">
          Proposes everything on <code>{state.branch}</code> since the last sync as one commit on a new branch, with the
          list of merged intents in the description. Review and merge it on GitHub as usual.
        </p>
        {!canWrite ? (
          <p className="muted">Only the owner can open pull requests.</p>
        ) : !me?.githubConnected ? (
          <div className="connect">
            <p>Hive needs repository access on GitHub to push a branch and open the pull request.</p>
            <a className="btn btn-primary" href={connectUrl}>
              Connect GitHub
            </a>
          </div>
        ) : (
          <PullRequestForm defaultTitle={merged.length === 1 ? merged[0].summary : ""} onAuthLost={refresh} />
        )}
        {me?.githubConnected && canWrite && (
          <p className="muted small">
            GitHub is connected.{" "}
            <button
              className="link"
              onClick={() => {
                void api.disconnectGithub().then(refresh);
              }}
            >
              Disconnect
            </button>
          </p>
        )}
      </section>

      {link.pullRequests.length > 0 && (
        <section className="panel">
          <h2>Opened from Hive</h2>
          <ul className="pr-list">
            {link.pullRequests.map((pr) => (
              <li key={pr.number}>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number} {pr.title}
                </a>
                <span className="muted small">
                  {" "}
                  · <code>{pr.branch}</code> · from <code>{shortSha(pr.head)}</code> · {timeAgo(pr.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SyncButton() {
  const { owner, name } = useRepo();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api.syncGithub(owner, name);
      if (r.status === "up-to-date") setMessage("Already up to date with GitHub.");
      else if (r.status === "conflict") {
        setError(
          `Upstream changed files that also changed in Hive: ${r.files.join(", ")}. Nothing was synced; resolve those files (or revert the Hive change) and sync again.`,
        );
      } else {
        const skipped = r.skipped?.length ? ` Binary files not synced: ${r.skipped.join(", ")}.` : "";
        setMessage(
          r.commit
            ? `Synced ${r.files} file${r.files === 1 ? "" : "s"} in ${shortSha(r.commit.sha)}.${skipped}`
            : `Synced.${skipped}`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row wrap">
      <button className="btn" disabled={busy} onClick={() => void sync()}>
        {busy ? "Syncing…" : "Sync from GitHub"}
      </button>
      <span className="muted small">Brings new upstream commits into Hive with a 3-way merge per file.</span>
      {message && <span className="small">{message}</span>}
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function PullRequestForm({ defaultTitle, onAuthLost }: { defaultTitle: string; onAuthLost: () => void }) {
  const { owner, name } = useRepo();
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ url: string; number: number } | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const pr = await api.openPullRequest(owner, name, { title, body });
      setOpened(pr);
    } catch (err) {
      setError((err as Error).message);
      if ((err as { status?: number }).status === 412) onAuthLost();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pr-form">
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          maxLength={200}
          placeholder="Defaults to a summary of the merged intents"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Description <span className="muted">(optional; the merged intents are listed automatically)</span>
        </span>
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={busy} onClick={() => void open()}>
          {busy ? "Pushing to GitHub…" : "Open pull request"}
        </button>
        {opened && (
          <a href={opened.url} target="_blank" rel="noreferrer">
            Opened #{opened.number} ↗
          </a>
        )}
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}
