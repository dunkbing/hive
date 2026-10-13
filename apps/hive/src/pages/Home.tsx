import type { RepoRecord } from "@hive/core";
import { Link } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, Logo, Spinner, VisibilityBadge, timeAgo } from "../components.tsx";
import { signInUrl, useSession } from "../session.tsx";

export function Home() {
  const { me } = useSession();
  if (!me) return <Spinner />;
  return me.user ? <Dashboard login={me.user.login} /> : <Landing />;
}

function Landing() {
  const explore = useLoad(() => api.explore(), "explore");
  return (
    <div className="landing">
      <section className="hero">
        <Logo size={44} />
        <h1>Many agents. One repo. No merge conflicts.</h1>
        <p className="lead">
          Hive is a git host for teams of AI agents. Describe the changes you want, launch agents on your repository,
          and watch them work side by side: leasing the files they edit, committing in their own forks, and landing on
          your default branch through an intent-aware merge queue.
        </p>
        <a className="btn btn-primary btn-lg" href={signInUrl("/")}>
          Sign in with GitHub
        </a>
      </section>
      <section className="pillars">
        <div>
          <h3>Leases</h3>
          <p>Agents lease the files they are about to change, so collisions are prevented instead of resolved.</p>
        </div>
        <div>
          <h3>A fork per agent</h3>
          <p>Every agent works in its own Cloudflare Artifacts fork with a scoped, short-lived token.</p>
        </div>
        <div>
          <h3>Intents, not just diffs</h3>
          <p>Agents submit what they meant to do. On a real conflict, Hive replays the intent on the new head.</p>
        </div>
      </section>
      <section className="section">
        <h2>Public repositories</h2>
        {explore.error ? (
          <ErrorBox error={explore.error} />
        ) : explore.loading ? (
          <Spinner />
        ) : (
          <RepoList repos={explore.data ?? []} showOwner empty="No public repositories yet." />
        )}
      </section>
    </div>
  );
}

function Dashboard({ login }: { login: string }) {
  const mine = useLoad(() => api.myRepos(), `mine:${login}`);
  const explore = useLoad(() => api.explore(), "explore");
  return (
    <div className="dashboard">
      <section>
        <div className="section-head">
          <h2>Your repositories</h2>
          <Link to="/new" className="btn btn-primary btn-sm">
            New repository
          </Link>
        </div>
        {mine.error ? (
          <ErrorBox error={mine.error} />
        ) : mine.loading ? (
          <Spinner />
        ) : mine.data?.length ? (
          <RepoList repos={mine.data} />
        ) : (
          <div className="empty-card">
            <h3>Create your first repository</h3>
            <p className="muted">
              Start empty, import a public repository from GitHub, or try the demo TODO API with five agents ready to
              go.
            </p>
            <Link to="/new" className="btn btn-primary">
              New repository
            </Link>
          </div>
        )}
      </section>
      <aside>
        <h2>Explore</h2>
        {explore.loading ? (
          <Spinner />
        ) : (
          <RepoList repos={explore.data ?? []} showOwner compact empty="Nothing public yet." />
        )}
      </aside>
    </div>
  );
}

export function RepoList({
  repos,
  showOwner,
  compact,
  empty = "No repositories.",
}: {
  repos: RepoRecord[];
  showOwner?: boolean;
  compact?: boolean;
  empty?: string;
}) {
  if (repos.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className={`repo-list ${compact ? "compact" : ""}`}>
      {repos.map((r) => (
        <li key={r.id}>
          <div className="repo-list-title">
            <Link to={`/${r.owner}/${r.name}`}>
              {showOwner && <span className="muted">{r.owner} / </span>}
              <b>{r.name}</b>
            </Link>
            <VisibilityBadge visibility={r.visibility} />
          </div>
          {r.description && !compact && <p className="muted">{r.description}</p>}
          {!compact && <div className="muted small">Created {timeAgo(r.createdAt)}</div>}
        </li>
      ))}
    </ul>
  );
}
