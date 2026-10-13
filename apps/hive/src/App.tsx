import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { RepoView } from "./RepoView.tsx";

function currentRepo() {
  return location.pathname.match(/^\/r\/([a-z0-9-]+)/)?.[1] ?? null;
}

export default function App() {
  const [repo, setRepo] = useState(currentRepo);

  useEffect(() => {
    const onPop = () => setRepo(currentRepo());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const open = (name: string) => {
    history.pushState(null, "", `/r/${name}`);
    setRepo(name);
  };

  return repo ? <RepoView key={repo} repo={repo} onNewRepo={open} /> : <Home onOpen={open} />;
}

function Home({ onOpen }: { onOpen: (name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onOpen((await api.createRepo()).name);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <div className="home-card">
        <div className="brand brand-lg">
          <Logo size={40} />
          <span>hive</span>
        </div>
        <h1>Many agents. One repo. No merge conflicts.</h1>
        <p>
          Branches and pull requests were built for humans who work for days. Agents work in seconds, side by side. Hive
          replaces them with three primitives:
        </p>
        <ul className="pillars">
          <li>
            <b>Leases</b> Agents lease the files they are about to change, so collisions are prevented instead of
            resolved.
          </li>
          <li>
            <b>Forks</b> Every agent works in its own Cloudflare Artifacts fork with a scoped, short-lived token.
          </li>
          <li>
            <b>Intents</b> Agents submit what they meant to do, not only a diff. On conflict, Hive replays the intent on
            the new main.
          </li>
        </ul>
        <button className="btn btn-primary btn-lg" onClick={create} disabled={busy}>
          {busy ? "Creating repo in Artifacts…" : "Create a demo repo"}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path fill="var(--honey)" d="M16 2 28 9v14l-12 7L4 23V9z" />
      <path fill="var(--bg)" d="M16 9.5 22 13v6l-6 3.5-6-3.5v-6z" />
    </svg>
  );
}
