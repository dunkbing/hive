import { Hono } from "hono";
import { auth, directory, loadUser, type AppEnv } from "./auth.ts";
import { commitDetail, listTree, log } from "./browse.ts";
import type { RepoSource } from "./coordinator.ts";
import type { RepoRecord, Visibility } from "@hive/core";
import { DEMO_TASKS, type Task } from "./scenario.ts";

export { HiveAgent } from "./agent.ts";
export { RepoCoordinator } from "./coordinator.ts";
export { Directory } from "./directory.ts";

const REPO_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_NAME = /^[a-z0-9-]{1,24}$/;
const MAX_TASKS_PER_LAUNCH = 8;
const MAX_TASK_LENGTH = 4000;

type RepoEnv = AppEnv & { Variables: { repo: RepoRecord; canWrite: boolean } };

const coordinator = (env: Env, id: string) => env.REPO.get(env.REPO.idFromName(id));

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.use("*", loadUser);

// Cookies are SameSite=Lax; also refuse cross-origin writes and WebSocket upgrades outright.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const upgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
  if ((c.req.method !== "GET" || upgrade) && origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "cross-origin request refused" }, 403);
  }
  await next();
});

app.route("/auth", auth);

const api = new Hono<AppEnv>();

api.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const exempt = isAdmin(c.env, user.login);
  return c.json({
    user,
    agentsToday: await directory(c.env).agentsUsedToday(user.id),
    dailyAgentLimit: exempt ? null : Number(c.env.HIVE_DAILY_AGENT_LIMIT),
  });
});

api.get("/repos", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "sign in required" }, 401);
  return c.json(await directory(c.env).listOwnRepos(user.id));
});

api.get("/explore", async (c) => c.json(await directory(c.env).listPublicRepos(30)));

api.get("/users/:owner/repos", async (c) =>
  c.json(await directory(c.env).listRepos(c.req.param("owner"), c.get("user")?.id ?? null)),
);

api.post("/repos", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "sign in required" }, 401);
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: Visibility;
    source?: { type?: string; url?: string };
  }>();

  const name = (body.name ?? "").trim();
  if (!REPO_NAME.test(name) || name.startsWith(".")) {
    return c.json({ error: "Repository names may contain letters, numbers, '.', '-' and '_' (max 64)." }, 400);
  }
  const description = (body.description ?? "").trim().slice(0, 300);
  const visibility: Visibility = body.visibility === "public" ? "public" : "private";

  let source: RepoSource;
  if (body.source?.type === "demo") source = { type: "demo" };
  else if (body.source?.type === "import") {
    const url = parseImportUrl(body.source.url ?? "");
    if (!url) return c.json({ error: "Enter a public https git URL, e.g. https://github.com/owner/repo" }, 400);
    source = { type: "import", url };
  } else source = { type: "empty", title: name };

  const dir = directory(c.env);
  const record = await dir.createRepo({ ownerId: user.id, name, description, visibility });
  if (!record) return c.json({ error: `You already have a repository called ${name}.` }, 409);
  try {
    await coordinator(c.env, record.id).init({ id: record.id, description, source });
  } catch (err) {
    await dir.deleteRepo(record.id);
    throw err;
  }
  return c.json(record, 201);
});

// ---- repo-scoped routes -----------------------------------------------------

const repo = new Hono<RepoEnv>();

repo.use("*", async (c, next) => {
  const record = await directory(c.env).getRepo(c.req.param("owner") ?? "", c.req.param("name") ?? "");
  const user = c.get("user");
  const canWrite = !!record && !!user && record.ownerId === user.id;
  // Private repos are invisible to everyone but their owner.
  if (!record || (record.visibility === "private" && !canWrite)) return c.json({ error: "repository not found" }, 404);
  if (c.req.method !== "GET" && !canWrite) return c.json({ error: "only the owner can change this repository" }, 403);
  c.set("repo", record);
  c.set("canWrite", canWrite);
  await next();
});

repo.get("/", async (c) => {
  const record = c.get("repo");
  return c.json({ repo: record, canWrite: c.get("canWrite"), state: await coordinator(c.env, record.id).getState() });
});

repo.get("/ws", (c) => coordinator(c.env, c.get("repo").id).fetch(c.req.raw));

/** The Artifacts repo to read from: the repo itself, or one of its agents' forks with `?fork=a1`. */
function artifactName(c: { req: { query: (k: string) => string | undefined }; get: (k: "repo") => RepoRecord }) {
  const fork = c.req.query("fork");
  const id = c.get("repo").id;
  return fork && /^a\d{1,4}$/.test(fork) ? `${id}--${fork}` : id;
}

async function defaultRef(c: { env: Env; get: (k: "repo") => RepoRecord }) {
  return (await coordinator(c.env, c.get("repo").id).getState()).branch;
}

repo.get("/tree", async (c) => {
  using art = await c.env.ARTIFACTS.get(artifactName(c));
  const tree = await listTree(art, c.req.query("ref") || (await defaultRef(c)));
  return tree ? c.json(tree) : c.json({ error: "ref not found" }, 404);
});

repo.get("/blob", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  using art = await c.env.ARTIFACTS.get(artifactName(c));
  const blob = await art.readFile({ ref: c.req.query("ref") || (await defaultRef(c)), path });
  if (!blob) return c.json({ error: "file not found" }, 404);
  return new Response(blob, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
});

repo.get("/commits", async (c) => {
  const limit = Math.min(100, Number(c.req.query("limit") ?? 30) || 30);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  using art = await c.env.ARTIFACTS.get(artifactName(c));
  return c.json(await log(art, c.req.query("ref") || (await defaultRef(c)), limit, offset));
});

repo.get("/commit/:sha", async (c) => {
  const sha = c.req.param("sha");
  if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: "invalid commit" }, 400);
  using art = await c.env.ARTIFACTS.get(artifactName(c));
  const detail = await commitDetail(art, sha);
  return detail ? c.json(detail) : c.json({ error: "commit not found" }, 404);
});

/** A read-only clone command with a one-hour token, for anyone who can see the repo. */
repo.get("/clone", async (c) => {
  const record = c.get("repo");
  using art = await c.env.ARTIFACTS.get(record.id);
  const info = await art.info();
  const token = await art.createToken("read", 3600);
  return c.json({
    remote: info.remote,
    expiresAt: token.expiresAt,
    command: `git -c http.extraHeader="Authorization: Bearer ${token.plaintext}" clone ${info.remote} ${record.name}`,
  });
});

repo.post("/agents", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ demo?: boolean; tasks?: { name?: string; task?: string }[] }>();
  const tasks: Task[] = body.demo
    ? DEMO_TASKS
    : (body.tasks ?? [])
        .map((t) => ({
          name: AGENT_NAME.test(t.name ?? "") ? t.name! : "agent",
          task: (t.task ?? "").trim().slice(0, MAX_TASK_LENGTH),
        }))
        .filter((t) => t.task.length > 0);
  if (tasks.length === 0) return c.json({ error: "Describe at least one task." }, 400);
  if (tasks.length > MAX_TASKS_PER_LAUNCH)
    return c.json({ error: `At most ${MAX_TASKS_PER_LAUNCH} tasks at once.` }, 400);

  if (!isAdmin(c.env, user.login)) {
    const limit = Number(c.env.HIVE_DAILY_AGENT_LIMIT);
    const left = await directory(c.env).reserveAgents(user.id, tasks.length, limit);
    if (left < 0) return c.json({ error: `Daily limit of ${limit} agent runs reached. Try again tomorrow.` }, 429);
  }
  return c.json(await coordinator(c.env, c.get("repo").id).launchAgents(tasks));
});

repo.post("/retry", async (c) => c.json(await coordinator(c.env, c.get("repo").id).retryImport()));

repo.post("/settings", async (c) => {
  const record = c.get("repo");
  const body = await c.req.json<{ leasesEnabled?: boolean; description?: string; visibility?: Visibility }>();
  const coord = coordinator(c.env, record.id);
  if (typeof body.leasesEnabled === "boolean") await coord.setLeasesEnabled(body.leasesEnabled);
  const patch: { description?: string; visibility?: Visibility } = {};
  if (typeof body.description === "string") {
    patch.description = body.description.trim().slice(0, 300);
    await coord.setDescription(patch.description);
  }
  if (body.visibility === "public" || body.visibility === "private") patch.visibility = body.visibility;
  const updated = await directory(c.env).updateRepo(record.id, patch);
  return c.json({ repo: updated, state: await coord.getState() });
});

repo.delete("/", async (c) => {
  const record = c.get("repo");
  await coordinator(c.env, record.id).destroy();
  await directory(c.env).deleteRepo(record.id);
  return c.json({ ok: true });
});

api.route("/repos/:owner/:name", repo);
app.route("/api", api);

function isAdmin(env: Env, login: string) {
  return env.HIVE_ADMINS.split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(login.toLowerCase());
}

/** Accepts public https git URLs; `github.com/owner/repo` style input is normalised. */
function parseImportUrl(input: string): string | null {
  const raw = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export default app satisfies ExportedHandler<Env>;
