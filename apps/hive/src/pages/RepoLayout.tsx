import type { HiveEvent, RepoRecord, RepoState } from "@hive/core";
import { useState } from "react";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router";
import { api, useLiveState, useLoad, type ApiError, type Connection } from "../api.ts";
import { ErrorBox, Modal, Spinner, VisibilityBadge } from "../components.tsx";
import { NotFound } from "./Shell.tsx";

export interface RepoContext {
  owner: string;
  name: string;
  repo: RepoRecord;
  setRepo: (repo: RepoRecord) => void;
  canWrite: boolean;
  state: RepoState;
  setState: (state: RepoState) => void;
  lastEvent: HiveEvent | null;
  connection: Connection;
}

export function useRepo() {
  return useOutletContext<RepoContext>();
}

export function RepoLayout() {
  const { owner = "", name = "" } = useParams();
  const payload = useLoad(() => api.repo(owner, name), `repo:${owner}/${name}`);

  if (payload.error) {
    return (payload.error as ApiError).status === 404 ? <NotFound /> : <ErrorBox error={payload.error} />;
  }
  if (!payload.data) return <Spinner />;
  return <LoadedRepo key={payload.data.repo.id} owner={owner} name={name} {...payload.data} />;
}

function LoadedRepo(props: { owner: string; name: string; repo: RepoRecord; canWrite: boolean; state: RepoState }) {
  const { owner, name, canWrite } = props;
  const [repo, setRepo] = useState(props.repo);
  const live = useLiveState(owner, name, props.state);
  const [cloneOpen, setCloneOpen] = useState(false);
  const { state } = live;
  const running = state.agents.filter((a) => a.status !== "done" && a.status !== "failed").length;

  const ctx: RepoContext = { owner, name, repo, setRepo, canWrite, ...live };

  return (
    <div className="repo">
      <div className="repo-head">
        <div className="repo-title">
          <Link to={`/${repo.owner}`} className="muted">
            {repo.owner}
          </Link>
          <span className="muted">/</span>
          <Link to={`/${repo.owner}/${repo.name}`}>
            <b>{repo.name}</b>
          </Link>
          <VisibilityBadge visibility={repo.visibility} />
        </div>
        {state.status === "ready" && (
          <button className="btn btn-sm" onClick={() => setCloneOpen(true)}>
            Clone
          </button>
        )}
      </div>
      {repo.description && <p className="repo-desc muted">{repo.description}</p>}

      <nav className="tabs">
        <NavLink end to={`/${owner}/${name}`}>
          Code
        </NavLink>
        <NavLink to={`/${owner}/${name}/commits`}>Commits</NavLink>
        <NavLink to={`/${owner}/${name}/agents`}>
          Agents
          {running > 0 && <span className="count live">{running}</span>}
          {running === 0 && state.agents.length > 0 && <span className="count">{state.agents.length}</span>}
        </NavLink>
        {canWrite && <NavLink to={`/${owner}/${name}/settings`}>Settings</NavLink>}
      </nav>

      {state.status === "ready" ? (
        <Outlet context={ctx} />
      ) : state.status === "failed" ? (
        <ErrorBox error={`This repository could not be created: ${state.statusError ?? "unknown error"}`} />
      ) : (
        <div className="center-page">
          <Spinner
            label={state.status === "importing" ? "Importing repository into Artifacts…" : "Creating repository…"}
          />
        </div>
      )}

      {cloneOpen && <CloneDialog owner={owner} name={name} onClose={() => setCloneOpen(false)} />}
    </div>
  );
}

function CloneDialog({ owner, name, onClose }: { owner: string; name: string; onClose: () => void }) {
  const clone = useLoad(() => api.clone(owner, name), `clone:${owner}/${name}`);
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Clone with git" onClose={onClose}>
      <p className="muted">
        A read-only token valid for one hour is included. The repository lives in Cloudflare Artifacts and works with
        any git client.
      </p>
      {clone.error ? (
        <ErrorBox error={clone.error} />
      ) : !clone.data ? (
        <Spinner />
      ) : (
        <>
          <pre className="code-block wrap">{clone.data.command}</pre>
          <div>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(clone.data!.command);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
