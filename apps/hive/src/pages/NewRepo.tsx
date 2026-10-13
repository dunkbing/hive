import type { Visibility } from "@hive/core";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, type RepoSourceInput } from "../api.ts";
import { ErrorBox, Spinner } from "../components.tsx";
import { signInUrl, useSession } from "../session.tsx";

type SourceType = RepoSourceInput["type"];

const SOURCES: { type: SourceType; title: string; text: string }[] = [
  { type: "empty", title: "Empty", text: "A new repository with a README." },
  { type: "import", title: "Import", text: "Copy a public git repository, e.g. from GitHub." },
  { type: "demo", title: "Demo", text: "A small TODO API with five ready-made agent tasks that collide on purpose." },
];

export function NewRepo() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [source, setSource] = useState<SourceType>("empty");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me) return <Spinner />;
  if (!me.user) {
    location.assign(signInUrl("/new"));
    return <Spinner label="Redirecting to sign in…" />;
  }
  const login = me.user.login;

  const pickSource = (type: SourceType) => {
    setSource(type);
    if (type === "demo" && !name) {
      setName("todo-api");
      setDescription("Demo TODO API for Hive agents");
    }
  };

  const onUrl = (value: string) => {
    setUrl(value);
    const guess = value
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .pop();
    if (
      guess &&
      (!name ||
        name ===
          url
            .replace(/\.git$/, "")
            .split("/")
            .filter(Boolean)
            .pop())
    )
      setName(guess);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createRepo({
        name: name.trim(),
        description,
        visibility,
        source: source === "import" ? { type: "import", url } : { type: source },
      });
      void navigate(`/${repo.owner}/${repo.name}${source === "demo" ? "/agents" : ""}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="form-page" onSubmit={submit}>
      <h1>Create a new repository</h1>
      <p className="muted">Repositories are stored in Cloudflare Artifacts and cloneable with any git client.</p>

      <fieldset className="source-picker">
        <legend>Start from</legend>
        {SOURCES.map((s) => (
          <label key={s.type} className={`source ${source === s.type ? "selected" : ""}`}>
            <input type="radio" name="source" checked={source === s.type} onChange={() => pickSource(s.type)} />
            <b>{s.title}</b>
            <span className="muted">{s.text}</span>
          </label>
        ))}
      </fieldset>

      {source === "import" && (
        <label className="field">
          <span>Git URL</span>
          <input
            required
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            autoFocus
          />
          <small className="muted">
            Public repositories only. The latest commit of the default branch is imported.
          </small>
        </label>
      )}

      <div className="field-row">
        <label className="field owner-field">
          <span>Owner</span>
          <input value={login} disabled />
        </label>
        <span className="slash">/</span>
        <label className="field grow">
          <span>Repository name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[A-Za-z0-9._\-]{1,64}"
            title="Letters, numbers, '.', '-' and '_'"
            placeholder="my-project"
          />
        </label>
      </div>

      <label className="field">
        <span>
          Description <span className="muted">(optional, also shown to agents)</span>
        </span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>

      <fieldset className="radio-group">
        <legend>Visibility</legend>
        <label>
          <input type="radio" checked={visibility === "private"} onChange={() => setVisibility("private")} />
          <b>Private</b> <span className="muted">Only you can see this repository.</span>
        </label>
        <label>
          <input type="radio" checked={visibility === "public"} onChange={() => setVisibility("public")} />
          <b>Public</b> <span className="muted">Anyone can browse and clone it. Only you can run agents.</span>
        </label>
      </fieldset>

      {error && <ErrorBox error={error} />}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? (source === "import" ? "Starting import…" : "Creating…") : "Create repository"}
      </button>
    </form>
  );
}
