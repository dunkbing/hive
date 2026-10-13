import type { RepoRecord, User, Visibility } from "@hive/core";
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
}
