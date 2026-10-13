import type { Notification, NotificationKind } from "@hive/core";
import { useNavigate } from "react-router";
import { api, useLoad } from "../api.ts";
import { ErrorBox, Spinner, timeAgo } from "../components.tsx";
import { useSession } from "../session.tsx";

const KIND: Record<NotificationKind, { icon: string; label: string }> = {
  review_requested: { icon: "👀", label: "Review requested" },
  check_failed: { icon: "✗", label: "Check failed" },
  agent_done: { icon: "✓", label: "Agent finished" },
  agent_failed: { icon: "!", label: "Agent failed" },
  goal_review: { icon: "◎", label: "Goal ready for review" },
  goal_done: { icon: "★", label: "Goal done" },
};

export function InboxPage() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const inbox = useLoad(() => api.inbox(), `inbox:${me?.user?.login}:${me?.unread}`);

  if (me && !me.user) return <ErrorBox error="Sign in to see your inbox." />;
  if (inbox.error) return <ErrorBox error={inbox.error} />;
  if (!inbox.data) return <Spinner />;
  const { items, unread } = inbox.data;

  const open = async (n: Notification) => {
    if (!n.read) await api.markRead([n.id]).catch(() => undefined);
    refresh();
    void navigate(n.link);
  };

  return (
    <div className="inbox">
      <div className="row">
        <h1 className="grow">Inbox</h1>
        <button
          className="btn btn-sm"
          disabled={unread === 0}
          onClick={() => void api.markRead().then(refresh, () => undefined)}
        >
          Mark all read
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty-card">
          <p className="muted">Nothing needs you right now.</p>
        </div>
      ) : (
        <ul className="inbox-list">
          {items.map((n) => (
            <li key={n.id}>
              <button className={`inbox-item ${n.read ? "" : "unread"}`} onClick={() => void open(n)}>
                <span className="inbox-icon" title={KIND[n.kind]?.label}>
                  {KIND[n.kind]?.icon}
                </span>
                <span className="inbox-text">
                  <b>{n.title}</b>
                  <span className="muted small">
                    {KIND[n.kind]?.label} · {n.repo}
                    {n.body && ` · ${n.body}`}
                  </span>
                </span>
                <span className="muted small">{timeAgo(n.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
