import { Hono } from "hono";
import { DEMO_TASKS, type Task } from "./scenario.ts";

export { HiveAgent } from "./agent.ts";
export { RepoCoordinator } from "./coordinator.ts";

const REPO_NAME = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const app = new Hono<{ Bindings: Env }>().basePath("/api");

const repo = (env: Env, name: string) => env.REPO.get(env.REPO.idFromName(name));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.use("/repos/:name/*", async (c, next) => {
  if (!REPO_NAME.test(c.req.param("name"))) return c.json({ error: "invalid repo name" }, 400);
  await next();
});

/** Creates a repo seeded with the demo codebase. */
app.post("/repos", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const name = body.name ?? `demo-${crypto.randomUUID().slice(0, 6)}`;
  if (!REPO_NAME.test(name)) return c.json({ error: "invalid repo name" }, 400);
  return c.json(await repo(c.env, name).init(name));
});

app.get("/repos/:name/state", async (c) => c.json(await repo(c.env, c.req.param("name")).getState()));

app.get("/repos/:name/ws", (c) => repo(c.env, c.req.param("name")).fetch(c.req.raw));

app.post("/repos/:name/settings", async (c) => {
  const { leasesEnabled } = await c.req.json<{ leasesEnabled: boolean }>();
  return c.json(await repo(c.env, c.req.param("name")).setLeasesEnabled(Boolean(leasesEnabled)));
});

/** Spawns the demo agents, or the tasks given in the body. */
app.post("/repos/:name/scenario", async (c) => {
  const body = await c.req
    .json<{ tasks?: Task[]; count?: number }>()
    .catch(() => ({}) as { tasks?: Task[]; count?: number });
  const tasks = body.tasks ?? DEMO_TASKS.slice(0, body.count ?? DEMO_TASKS.length);
  return c.json(await repo(c.env, c.req.param("name")).runScenario(tasks));
});

app.get("/repos/:name/file", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  const content = await repo(c.env, c.req.param("name")).readMainFile(path);
  return content === null ? c.json({ error: "not found" }, 404) : c.text(content);
});

/** A read-only `git clone` command with a one-hour token. */
app.get("/repos/:name/clone", async (c) => c.json({ command: await repo(c.env, c.req.param("name")).cloneCommand() }));

export default app satisfies ExportedHandler<Env>;
