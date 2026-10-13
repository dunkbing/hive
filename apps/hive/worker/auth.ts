import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "@hive/core";
import { decrypt, encrypt } from "./secrets.ts";

export const SESSION_COOKIE = "hive_session";
const STATE_COOKIE = "hive_oauth_state";

export type AppEnv = { Bindings: Env; Variables: { user: User | null } };

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));

/** Only same-site relative paths are allowed as post-login redirects. */
function safeNext(next: string | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function isSecure(c: Context) {
  return new URL(c.req.url).protocol === "https:";
}

async function startSession(c: Context<AppEnv>, user: User, next: string) {
  const dir = directory(c.env);
  await dir.upsertUser(user);
  const session = await dir.createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return c.redirect(next);
}

/** Loads the signed-in user (or null) for every request. */
export async function loadUser(c: Context<AppEnv>, next: () => Promise<void>) {
  const sessionId = getCookie(c, SESSION_COOKIE);
  c.set("user", sessionId ? await directory(c.env).getSessionUser(sessionId) : null);
  await next();
}

export const auth = new Hono<AppEnv>();

auth.get("/github", (c) => {
  if (!c.env.GITHUB_CLIENT_ID) return c.text("GitHub sign-in is not configured", 503);
  const state = crypto.randomUUID();
  const next = safeNext(c.req.query("next"));
  // `?scope=repo` asks for push access, used to open pull requests on GitHub.
  const scope = c.req.query("scope") === "repo" ? "read:user repo" : "read:user";
  setCookie(c, STATE_COOKIE, `${state}|${next}`, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/auth/github/callback", c.req.url).toString());
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

auth.get("/github/callback", async (c) => {
  const [expected, next] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const code = c.req.query("code");
  if (!code || !expected || c.req.query("state") !== expected)
    return c.text("Sign-in failed: bad state. Try again.", 400);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/auth/github/callback", c.req.url).toString(),
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!token.access_token) return c.text(`Sign-in failed: ${token.error_description ?? "no token"}`, 400);

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "hive",
      accept: "application/vnd.github+json",
    },
  });
  if (!userRes.ok) return c.text("Sign-in failed: could not read your GitHub profile.", 502);
  const gh = (await userRes.json()) as { id: number; login: string; name: string | null; avatar_url: string };

  const user = { id: `gh:${gh.id}`, login: gh.login, name: gh.name, avatarUrl: gh.avatar_url };
  // Keep the token only when it can do more than identify the user.
  const scopes = (token.scope ?? "").split(/[,\s]+/);
  if (scopes.includes("repo") || scopes.includes("public_repo")) {
    await directory(c.env).setGithubToken(user.id, await encrypt(c.env, token.access_token), token.scope ?? "");
  }
  return startSession(c, user, safeNext(next));
});

/** Local development only: sign in as any login without GitHub. Enabled by HIVE_DEV_LOGIN=1 in .dev.vars. */
auth.get("/dev", (c) => {
  if (c.env.HIVE_DEV_LOGIN !== "1") return c.notFound();
  const login = (c.req.query("login") ?? "dev").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 39) || "dev";
  return startSession(
    c,
    { id: `dev:${login}`, login, name: login, avatarUrl: `https://github.com/identicons/${login}.png` },
    safeNext(c.req.query("next")),
  );
});

auth.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await directory(c.env).deleteSession(sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** The user's GitHub token with repo access, if they connected one. */
export async function githubToken(env: Env, userId: string): Promise<string | null> {
  const stored = await directory(env).getGithubToken(userId);
  if (!stored) return null;
  try {
    return await decrypt(env, stored.sealed);
  } catch {
    return null;
  }
}
