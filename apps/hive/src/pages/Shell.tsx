import { useEffect, useRef, useState } from "react";
import { Link, Outlet, isRouteErrorResponse, useRouteError } from "react-router";
import { Avatar, Logo } from "../components.tsx";
import { signInUrl, useSession } from "../session.tsx";

export function Shell() {
  return (
    <div className="shell">
      <Header />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function Header() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);

  return (
    <header className="header">
      <Link to="/" className="brand">
        <Logo />
        <span>hive</span>
      </Link>
      <nav className="header-nav">
        <Link to="/">Repositories</Link>
      </nav>
      <div className="header-right">
        {me?.user ? (
          <>
            <Link to="/new" className="btn btn-sm">
              + New
            </Link>
            <Link to="/inbox" className="bell" aria-label={`Inbox, ${me.unread ?? 0} unread`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
              </svg>
              {!!me.unread && <span className="count live">{me.unread}</span>}
            </Link>
            <div className="menu" ref={menu}>
              <button className="menu-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <Avatar src={me.user.avatarUrl} size={26} alt={me.user.login} />
              </button>
              {open && (
                <div className="menu-pop" role="menu">
                  <div className="menu-head">
                    Signed in as <b>{me.user.login}</b>
                  </div>
                  {me.dailyAgentLimit != null && (
                    <div className="menu-item muted">
                      {me.agentsToday ?? 0} / {me.dailyAgentLimit} agent runs today
                    </div>
                  )}
                  <Link className="menu-item" to={`/${me.user.login}`} onClick={() => setOpen(false)}>
                    Your repositories
                  </Link>
                  <button className="menu-item" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        ) : me ? (
          <a className="btn btn-sm btn-primary" href={signInUrl()}>
            Sign in with GitHub
          </a>
        ) : null}
      </div>
    </header>
  );
}

export function NotFound({
  message = "This page doesn't exist, or you don't have access to it.",
}: {
  message?: string;
}) {
  return (
    <div className="center-page">
      <h1>404</h1>
      <p className="muted">{message}</p>
      <Link className="btn" to="/">
        Go home
      </Link>
    </div>
  );
}

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  return (
    <div className="center-page">
      <h1>Something went wrong</h1>
      <p className="muted">{message}</p>
      <a className="btn" href="/">
        Go home
      </a>
    </div>
  );
}
