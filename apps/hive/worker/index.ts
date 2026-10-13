import { Hono } from "hono";
import { auth, directory, githubToken, loadUser, type AppEnv } from "./auth.ts";
import { blame, commitDetail, listTree, log } from "./browse.ts";
import { listRefs } from "./git.ts";
import { GithubError, openPullRequest, parseGithubUrl, upstreamChanges } from "./github.ts";
import { planGoal } from "./planner.ts";
import type { RepoSource } from "./coordinator.ts";
import type { MergeMode, RepoRecord, User, Visibility } from "@hive/core";
import { DEMO_TASKS, type Task } from "./scenario.ts";

export { HiveAgent } from "./agent.ts";
export { RepoCoordinator } from "./coordinator.ts";
export { Directory } from "./directory.ts";
export { HiveSandbox } from "./sandbox.ts";

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
  const github = await directory(c.env).getGithubToken(user.id);
  return c.json({
    user,
    agentsToday: await directory(c.env).agentsUsedToday(user.id),
    dailyAgentLimit: exempt ? null : Number(c.env.HIVE_DAILY_AGENT_LIMIT),
    githubConnected: !!github,
  });
});

/** Forgets the stored GitHub token (sign-in keeps working). */
api.delete("/me/github", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "sign in required" }, 401);
  await directory(c.env).deleteGithubToken(user.id);
  return c.json({ ok: true });
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

/**
 * A clone command with a one-hour token: read-only for anyone who can see the repo, read-write (`?write=1`) for
 * the owner. Pushes are picked up by the coordinator before its next merge.
 */
repo.get("/clone", async (c) => {
  const record = c.get("repo");
  const write = c.req.query("write") === "1";
  if (write && !c.get("canWrite")) return c.json({ error: "only the owner can get a write token" }, 403);
  using art = await c.env.ARTIFACTS.get(record.id);
  const info = await art.info();
  const token = await art.createToken(write ? "write" : "read", 3600);
  return c.json({
    remote: info.remote,
    write,
    expiresAt: token.expiresAt,
    command: `git -c http.extraHeader="Authorization: Bearer ${token.plaintext}" clone ${info.remote} ${record.name}`,
    token: token.plaintext,
  });
});

repo.get("/refs", async (c) => {
  using art = await c.env.ARTIFACTS.get(c.get("repo").id);
  const [info, token] = await Promise.all([art.info(), art.createToken("read", 300)]);
  return c.json(await listRefs({ url: info.remote, token: token.plaintext }));
});

repo.get("/blame", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  using art = await c.env.ARTIFACTS.get(artifactName(c));
  const result = await blame(art, c.req.query("ref") || (await defaultRef(c)), path);
  return result ? c.json(result) : c.json({ error: "file not found" }, 404);
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

  const limited = await reserveRuns(c.env, user, tasks.length);
  if (limited) return c.json({ error: limited }, 429);
  return c.json(await coordinator(c.env, c.get("repo").id).launchAgents(tasks));
});

/** Turns a goal into parallel tasks for review before launching. */
repo.post("/plan", async (c) => {
  const user = c.get("user")!;
  const { goal } = await c.req.json<{ goal?: string }>();
  const text = (goal ?? "").trim().slice(0, MAX_TASK_LENGTH);
  if (!text) return c.json({ error: "Describe what you want to build or change." }, 400);
  const limited = await reserveRuns(c.env, user, 1);
  if (limited) return c.json({ error: limited }, 429);
  const record = c.get("repo");
  const coord = coordinator(c.env, record.id);
  const state = await coord.getState();
  return c.json(
    await planGoal(c.env, coord, { id: record.id, branch: state.branch, description: record.description }, text),
  );
});

/** An agent's transcript, newest steps after `after`. */
repo.get("/agents/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const state = await coordinator(c.env, c.get("repo").id).getState();
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(`${c.get("repo").id}/${agentId}`));
  const steps = await stub.transcript(Number(c.req.query("after") ?? 0) || 0);
  return c.json({ agent, steps });
});

repo.post("/agents/:agentId/cancel", async (c) => {
  await coordinator(c.env, c.get("repo").id).cancelAgent(c.req.param("agentId"), c.get("user")!.login);
  return c.json({ ok: true });
});

repo.post("/agents/:agentId/message", async (c) => {
  const user = c.get("user")!;
  const { message } = await c.req.json<{ message?: string }>();
  const text = (message ?? "").trim().slice(0, MAX_TASK_LENGTH);
  if (!text) return c.json({ error: "Write a message." }, 400);
  // A message to a finished agent starts a new run, which costs like one.
  const limited = await reserveRuns(c.env, user, 1);
  if (limited) return c.json({ error: limited }, 429);
  await coordinator(c.env, c.get("repo").id).messageAgent(c.req.param("agentId"), text, user.login);
  return c.json({ ok: true });
});

// ---- review queue -------------------------------------------------------------

repo.post("/intents/:intentId/approve", async (c) =>
  c.json(await coordinator(c.env, c.get("repo").id).approveIntent(c.req.param("intentId"), c.get("user")!.login)),
);

repo.post("/intents/:intentId/changes", async (c) => {
  const user = c.get("user")!;
  const { comment } = await c.req.json<{ comment?: string }>();
  const text = (comment ?? "").trim().slice(0, MAX_TASK_LENGTH);
  if (!text) return c.json({ error: "Describe the changes you want." }, 400);
  const limited = await reserveRuns(c.env, user, 1);
  if (limited) return c.json({ error: limited }, 429);
  await coordinator(c.env, c.get("repo").id).requestChanges(c.req.param("intentId"), text, user.login);
  return c.json({ ok: true });
});

repo.post("/intents/:intentId/reject", async (c) => {
  const { comment } = await c.req.json<{ comment?: string }>().catch(() => ({ comment: "" }));
  await coordinator(c.env, c.get("repo").id).rejectIntent(
    c.req.param("intentId"),
    (comment ?? "").trim().slice(0, MAX_TASK_LENGTH),
    c.get("user")!.login,
  );
  return c.json({ ok: true });
});

repo.post("/intents/:intentId/revert", async (c) =>
  c.json(await coordinator(c.env, c.get("repo").id).revertIntent(c.req.param("intentId"), c.get("user")!.login)),
);

// ---- GitHub round trip ------------------------------------------------------------

repo.post("/github/pr", async (c) => {
  const user = c.get("user")!;
  const record = c.get("repo");
  const coord = coordinator(c.env, record.id);
  const source = await coord.githubSource();
  const github = parseGithubUrl(source.url ?? undefined);
  if (!github || !source.base || !source.head)
    return c.json({ error: "This repository was not imported from GitHub." }, 400);
  const token = await githubToken(c.env, user.id);
  if (!token)
    return c.json({ error: "Connect GitHub with repository access first.", code: "github_not_connected" }, 412);

  const state = await coord.getState();
  const body = await c.req
    .json<{ title?: string; body?: string }>()
    .catch(() => ({}) as { title?: string; body?: string });
  const landed = state.intents.filter((i) => i.status === "merged");
  const origin = new URL(c.req.url).origin;
  const lines = landed.map((i) => {
    const agent = state.agents.find((a) => a.id === i.agentId);
    return `- ${i.summary} (${agent?.name ?? i.agentId}, [${i.mergedAs?.slice(0, 7)}](${origin}/${record.owner}/${record.name}/commit/${i.mergedAs}))`;
  });
  const title =
    (body.title ?? "").trim() ||
    (landed.length === 1 ? landed[0].summary : `Changes from Hive (${landed.length} intents)`);
  const description = [
    (body.body ?? "").trim(),
    lines.length ? `### Intents merged in Hive\n\n${lines.join("\n")}` : "",
    `Opened from [Hive](${origin}/${record.owner}/${record.name}), where AI agents worked on this concurrently.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    using art = await c.env.ARTIFACTS.get(record.id);
    const pr = await openPullRequest({
      token,
      github,
      art,
      base: source.base,
      head: source.head,
      branch: `hive/${record.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${Date.now().toString(36)}`,
      title: title.slice(0, 200),
      body: description,
    });
    await coord.recordPullRequest(pr, user.login);
    return c.json(pr);
  } catch (err) {
    if (err instanceof GithubError && err.status === 401) {
      return c.json({ error: "Your GitHub token expired. Connect GitHub again.", code: "github_not_connected" }, 412);
    }
    return c.json({ error: (err as Error).message }, err instanceof GithubError ? 502 : 400);
  }
});

repo.post("/github/sync", async (c) => {
  const user = c.get("user")!;
  const coord = coordinator(c.env, c.get("repo").id);
  const source = await coord.githubSource();
  const github = parseGithubUrl(source.url ?? undefined);
  if (!github || !source.base) return c.json({ error: "This repository was not imported from GitHub." }, 400);
  try {
    const token = await githubToken(c.env, user.id);
    const upstream = await upstreamChanges(token, github, source.base).catch((err: unknown) => {
      if (!token && err instanceof GithubError && err.status === 403) {
        throw new GithubError(
          403,
          "GitHub's anonymous rate limit was reached. Connect GitHub to sync with your own quota.",
        );
      }
      throw err;
    });
    if (upstream.head === source.base) return c.json({ status: "up-to-date" });
    const result = await coord.syncUpstream(upstream.changes, upstream.head, user.login);
    return c.json({ ...result, upstream: upstream.head, skipped: upstream.skipped });
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof GithubError ? 502 : 400);
  }
});

// ---- people as participants -------------------------------------------------------

/** Lease a file by hand so agents work around it. */
repo.post("/leases", async (c) => {
  const { path, reason } = await c.req.json<{ path?: string; reason?: string }>();
  if (!path) return c.json({ error: "path is required" }, 400);
  const result = await coordinator(c.env, c.get("repo").id).humanLease(c.get("user")!.login, path, reason ?? "");
  return result.ok ? c.json(result) : c.json({ error: `${path} is leased by ${result.holder.holderName}` }, 409);
});

repo.delete("/leases", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  await coordinator(c.env, c.get("repo").id).humanRelease(c.get("user")!.login, path);
  return c.json({ ok: true });
});

/** Content search on the default branch. */
repo.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ matches: [], truncated: false });
  return c.json(await coordinator(c.env, c.get("repo").id).searchMain(q.slice(0, 200), c.req.query("prefix")));
});

repo.post("/retry", async (c) => c.json(await coordinator(c.env, c.get("repo").id).retryImport()));

repo.post("/settings", async (c) => {
  const record = c.get("repo");
  const body = await c.req.json<{
    leasesEnabled?: boolean;
    mergeMode?: MergeMode;
    checkCommand?: string;
    description?: string;
    visibility?: Visibility;
  }>();
  const coord = coordinator(c.env, record.id);
  await coord.updateSettings({
    leasesEnabled: typeof body.leasesEnabled === "boolean" ? body.leasesEnabled : undefined,
    mergeMode: body.mergeMode === "auto" || body.mergeMode === "review" ? body.mergeMode : undefined,
    checkCommand: typeof body.checkCommand === "string" ? body.checkCommand.trim().slice(0, 500) : undefined,
  });
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

/** Reserves agent runs against the user's daily allowance; returns an error message when over it. */
async function reserveRuns(env: Env, user: User, count: number): Promise<string | null> {
  if (isAdmin(env, user.login)) return null;
  const limit = Number(env.HIVE_DAILY_AGENT_LIMIT);
  const left = await directory(env).reserveAgents(user.id, count, limit);
  return left < 0 ? `Daily limit of ${limit} agent runs reached. Try again tomorrow.` : null;
}

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
