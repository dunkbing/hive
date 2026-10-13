import type { Notification, NotificationKind, RepoRecord, User, Visibility } from "@hive/core";
import { DurableObject } from "cloudflare:workers";

const SESSION_TTL_MS = 30 * 24 * 3600_000;

/**
 * The global index: users, sessions, repo ownership and usage limits.
 * A single instance (named "global") backed by SQLite.
 */
export class Directory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        visibility TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS repos_owner_name ON repos(owner_id, name);
      CREATE TABLE IF NOT EXISTS usage (
        user_id TEXT NOT NULL, day TEXT NOT NULL, agents INTEGER NOT NULL, PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, link TEXT NOT NULL, created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
      CREATE TABLE IF NOT EXISTS github_tokens (
        user_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, scope TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
  }

  // ---- users & sessions ---------------------------------------------------

  upsertUser(user: User): void {
    this.sql.exec(
      `INSERT INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
      user.id,
      user.login,
      user.name,
      user.avatarUrl,
      Date.now(),
    );
  }

  createSession(userId: string): { id: string; expiresAt: number } {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sql.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", id, userId, expiresAt);
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    return { id, expiresAt };
  }

  getSessionUser(sessionId: string): User | null {
    const row = this.sql
      .exec<{ id: string; login: string; name: string | null; avatar_url: string }>(
        `SELECT u.id, u.login, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`,
        sessionId,
        Date.now(),
      )
      .toArray()[0];
    return row ? { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url } : null;
  }

  deleteSession(sessionId: string): void {
    this.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
  }

  // ---- GitHub tokens (sealed with secrets.ts before they get here) ------------------

  setGithubToken(userId: string, sealed: string, scope: string): void {
    this.sql.exec(
      `INSERT INTO github_tokens (user_id, sealed, scope, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET sealed = excluded.sealed, scope = excluded.scope, updated_at = excluded.updated_at`,
      userId,
      sealed,
      scope,
      Date.now(),
    );
  }

  getGithubToken(userId: string): { sealed: string; scope: string } | null {
    return (
      this.sql
        .exec<{ sealed: string; scope: string }>("SELECT sealed, scope FROM github_tokens WHERE user_id = ?", userId)
        .toArray()[0] ?? null
    );
  }

  deleteGithubToken(userId: string): void {
    this.sql.exec("DELETE FROM github_tokens WHERE user_id = ?", userId);
  }

  // ---- repos ---------------------------------------------------------------

  /** Reserves `owner/name`. Returns null when the name is taken. */
  createRepo(input: Omit<RepoRecord, "id" | "owner" | "createdAt">): RepoRecord | null {
    const taken = this.sql
      .exec("SELECT 1 FROM repos WHERE owner_id = ? AND name = ?", input.ownerId, input.name)
      .toArray().length;
    if (taken) return null;
    const id = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.sql.exec(
      "INSERT INTO repos (id, owner_id, name, description, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      input.name,
      input.description,
      input.visibility,
      Date.now(),
    );
    return this.getRepoById(id);
  }

  deleteRepo(id: string): void {
    this.sql.exec("DELETE FROM repos WHERE id = ?", id);
  }

  updateRepo(id: string, patch: { description?: string; visibility?: Visibility }): RepoRecord | null {
    if (patch.description !== undefined)
      this.sql.exec("UPDATE repos SET description = ? WHERE id = ?", patch.description, id);
    if (patch.visibility !== undefined)
      this.sql.exec("UPDATE repos SET visibility = ? WHERE id = ?", patch.visibility, id);
    return this.getRepoById(id);
  }

  getRepo(owner: string, name: string): RepoRecord | null {
    return this.repoQuery("WHERE u.login = ? COLLATE NOCASE AND r.name = ?", owner, name)[0] ?? null;
  }

  getRepoById(id: string): RepoRecord | null {
    return this.repoQuery("WHERE r.id = ?", id)[0] ?? null;
  }

  /** Repos visible to `viewerId` under `owner` (all of them for the owner, public ones for everyone else). */
  listRepos(owner: string, viewerId: string | null): RepoRecord[] {
    return this.repoQuery(
      "WHERE u.login = ? COLLATE NOCASE AND (r.visibility = 'public' OR r.owner_id = ?) ORDER BY r.created_at DESC",
      owner,
      viewerId ?? "",
    );
  }

  listOwnRepos(userId: string): RepoRecord[] {
    return this.repoQuery("WHERE r.owner_id = ? ORDER BY r.created_at DESC", userId);
  }

  listPublicRepos(limit = 20): RepoRecord[] {
    return this.repoQuery("WHERE r.visibility = 'public' ORDER BY r.created_at DESC LIMIT ?", limit);
  }

  private repoQuery(where: string, ...params: (string | number)[]): RepoRecord[] {
    return this.sql
      .exec<{
        id: string;
        owner_id: string;
        login: string;
        name: string;
        description: string;
        visibility: Visibility;
        created_at: number;
      }>(
        `SELECT r.id, r.owner_id, u.login, r.name, r.description, r.visibility, r.created_at
         FROM repos r JOIN users u ON u.id = r.owner_id ${where}`,
        ...params,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        owner: r.login,
        name: r.name,
        description: r.description,
        visibility: r.visibility,
        createdAt: r.created_at,
      }));
  }

  // ---- usage limits ----------------------------------------------------------

  /** Reserves `count` agent runs for today. Returns how many remain, or -1 if the request exceeds the limit. */
  reserveAgents(userId: string, count: number, dailyLimit: number): number {
    const day = new Date().toISOString().slice(0, 10);
    const used =
      this.sql
        .exec<{ agents: number }>("SELECT agents FROM usage WHERE user_id = ? AND day = ?", userId, day)
        .toArray()[0]?.agents ?? 0;
    if (used + count > dailyLimit) return -1;
    this.sql.exec(
      `INSERT INTO usage (user_id, day, agents) VALUES (?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET agents = agents + excluded.agents`,
      userId,
      day,
      count,
    );
    return dailyLimit - used - count;
  }

  agentsUsedToday(userId: string): number {
    const day = new Date().toISOString().slice(0, 10);
    return (
      this.sql
        .exec<{ agents: number }>("SELECT agents FROM usage WHERE user_id = ? AND day = ?", userId, day)
        .toArray()[0]?.agents ?? 0
    );
  }

  // ---- inbox -----------------------------------------------------------------

  /** Notifies the owner of repo `repoId`. `path` is relative to the repository page, e.g. `goals/3`. */
  notifyOwner(repoId: string, kind: NotificationKind, title: string, body: string, path = ""): void {
    const repo = this.getRepoById(repoId);
    if (!repo) return;
    this.sql.exec(
      "INSERT INTO notifications (user_id, repo, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      repo.ownerId,
      `${repo.owner}/${repo.name}`,
      kind,
      title.slice(0, 200),
      body.slice(0, 500),
      `/${repo.owner}/${repo.name}${path ? `/${path}` : ""}`,
      Date.now(),
    );
    // Keep the inbox bounded.
    this.sql.exec(
      "DELETE FROM notifications WHERE user_id = ? AND id <= (SELECT MAX(id) FROM notifications WHERE user_id = ?) - 200",
      repo.ownerId,
      repo.ownerId,
    );
  }

  listNotifications(userId: string, limit = 100): Notification[] {
    return this.sql
      .exec<{
        id: number;
        kind: NotificationKind;
        repo: string;
        title: string;
        body: string;
        link: string;
        created_at: number;
        read: number;
      }>("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit)
      .toArray()
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        repo: r.repo,
        title: r.title,
        body: r.body,
        link: r.link,
        createdAt: r.created_at,
        read: r.read === 1,
      }));
  }

  unreadCount(userId: string): number {
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0", userId)
      .one().n;
  }

  /** Marks the given notifications read, or all of the user's when `ids` is omitted. */
  markRead(userId: string, ids?: number[]): void {
    if (!ids) this.sql.exec("UPDATE notifications SET read = 1 WHERE user_id = ?", userId);
    else
      for (const id of ids) this.sql.exec("UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?", userId, id);
  }
}
