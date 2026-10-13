import type { MergeMode, Visibility } from "@hive/core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { ErrorBox } from "../components.tsx";
import { NotFound } from "./Shell.tsx";
import { useRepo } from "./RepoLayout.tsx";

export function SettingsTab() {
  const { owner, name, repo, setRepo, canWrite, state, setState } = useRepo();
  const navigate = useNavigate();
  const [description, setDescription] = useState(repo.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (!canWrite) return <NotFound />;

  const save = async (body: {
    description?: string;
    visibility?: Visibility;
    leasesEnabled?: boolean;
    mergeMode?: MergeMode;
  }) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSettings(owner, name, body);
      if (result.repo) setRepo(result.repo);
      setState(result.state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteRepo(owner, name);
      void navigate("/");
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <div className="settings">
      {error && <ErrorBox error={error} />}

      <section className="panel">
        <h2>General</h2>
        <label className="field">
          <span>Description</span>
          <div className="field-inline">
            <input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            <button
              className="btn"
              disabled={saving || description === repo.description}
              onClick={() => void save({ description })}
            >
              Save
            </button>
          </div>
          <small className="muted">Agents see the description as context about the repository.</small>
        </label>
      </section>

      <section className="panel">
        <h2>Visibility</h2>
        <p className="muted">
          This repository is <b>{repo.visibility}</b>.{" "}
          {repo.visibility === "public"
            ? "Anyone can browse, clone and watch agents work. Only you can launch agents or change settings."
            : "Only you can see it."}
        </p>
        <button
          className="btn"
          disabled={saving}
          onClick={() => void save({ visibility: repo.visibility === "public" ? "private" : "public" })}
        >
          Make {repo.visibility === "public" ? "private" : "public"}
        </button>
      </section>

      <section className="panel">
        <h2>Coordination</h2>
        <fieldset className="radio-group">
          <legend>When an agent submits an intent</legend>
          <label>
            <input
              type="radio"
              checked={state.mergeMode === "auto"}
              disabled={saving}
              onChange={() => void save({ mergeMode: "auto" })}
            />
            <b>Auto-merge</b> <span className="muted">The merge queue lands it right away. Use revert to undo.</span>
          </label>
          <label>
            <input
              type="radio"
              checked={state.mergeMode === "review"}
              disabled={saving}
              onChange={() => void save({ mergeMode: "review" })}
            />
            <b>Review before merge</b>{" "}
            <span className="muted">Intents wait on the Intents tab until you approve, request changes or reject.</span>
          </label>
        </fieldset>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.leasesEnabled}
            disabled={saving}
            onChange={(e) => void save({ leasesEnabled: e.target.checked })}
          />
          <span>
            <b>Require leases</b>
            <br />
            <span className="muted">
              Agents must lease a file before editing it. Turning this off lets agents edit freely; the merge queue then
              auto-merges or replays intents on conflict.
            </span>
          </span>
        </label>
      </section>

      <section className="panel danger">
        <h2>Delete repository</h2>
        <p className="muted">
          Deletes the repository, every agent fork and all coordination history from Cloudflare Artifacts. This cannot
          be undone.
        </p>
        <label className="field">
          <span>
            Type <b>{repo.name}</b> to confirm
          </span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button className="btn btn-danger" disabled={confirm !== repo.name || deleting} onClick={() => void remove()}>
          {deleting ? "Deleting…" : "Delete this repository"}
        </button>
      </section>
    </div>
  );
}
