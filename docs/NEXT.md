# Hive: what to build next

A plan for the next working sessions. Read this, `README.md` and `docs/DESIGN.md` first.

## Where Hive is today

Working and deployed at https://hive.dangbinh4869.workers.dev:

- GitHub sign-in, private/public repos (empty, demo template, or imported from a public git URL with full history)
- Code browser (tree, search, Markdown, blame), commits and diffs, read/read-write clone tokens
- Planner (goal → parallel tasks), agents with transcripts, messages and cancel
- Leases, merge queue with 3-way merge and intent replay, optional review before merge, revert
- Optional check command run in a sandbox before merge (needs Containers on the account, see "Open items")
- GitHub round trip for imported repos: open a PR, sync upstream

## Why it still feels empty

1. **Nothing persists between bursts of agent work.** There is no backlog, no issues, no "what is this repo working
   towards". You type a goal, agents run for two minutes, and then the repo is quiet again. GitHub feels alive because
   issues, PRs and discussions accumulate; Hive has no equivalent object for planned or ongoing work.
2. **A goal is not a first-class thing.** The planner's tasks become independent agents whose intents land one by one
   on the default branch. There is no place to see "this goal: 4 tasks, 3 merged, 1 waiting for review", nor a way to
   review or ship a goal as a unit.
3. **Agents cannot run anything while they work.** Checks run only after submit. Agents write code blind, so quality
   on real repos is limited and the transcript shows no testing.
4. **It is single-player.** Only the owner can do anything. No collaborators, no inline comments, no notifications,
   so there is no reason to come back or to invite anyone.
5. **First run is a blank page.** A new user sees an empty dashboard and an empty Explore list. There is no example of
   what a finished multi-agent run looks like.
6. **It does not fit into existing workflows.** Only public repos can be imported, sync is manual, and outside tools
   (Claude Code, Cursor, CI) cannot talk to Hive.

## Plan

Each phase is shippable on its own. Do them in order unless there is a reason not to.

### Phase 1: Work that lives in the repo (biggest impact)

- **Tasks (issues for agents and people).** A Tasks tab: create tasks with a title and body, labels, status (open, in
  progress, in review, done, closed). Assign a task to an agent (launches it with the task as context) or to yourself.
  Intents link to their task; merging the last intent of a task moves it to done. Store in the coordinator's DO
  storage (or a SQLite table in the coordinator) with events like everything else.
- **Goals as workstreams.** A goal from the planner becomes a Goal object that owns its tasks. It gets a page with
  progress, its agents, intents, checks and the combined diff. Option per goal: land each intent as it merges (today's
  behaviour), or land on a goal branch (`goal/<slug>`) and merge the whole goal to the default branch after one
  review. That is Hive's version of a pull request.
- **Inbox.** Per-user notifications: review requested, check failed, agent failed or finished, goal done, someone
  commented. A bell in the header and an Inbox page. Store per user in the Directory DO.
- **Repo home page.** The Code tab of a repo with activity should show recent goals and tasks, open reviews and the
  latest merges next to the README, so a repo looks alive at a glance.

Done when: you can write five tasks, launch two as agents, see them on a board, review a goal as a unit, and get
notified when anything needs you.

### Phase 2: Agents that can test their work

- **Workspace sandbox per agent run.** Give each agent run a container (the `HiveSandbox` class already exists) with
  the repo checked out, plus a `run` tool (command with timeout, output tail) so agents can install, build and test
  while they work. Sync the agent's pending edits into the sandbox before each `run`.
- **Repo instructions.** Read `AGENTS.md` / `CLAUDE.md` / `.hive/instructions.md` from the repo into the system prompt;
  a Settings field for extra instructions.
- **Agent settings per repo.** Model and effort, maximum turns, whether agents may run commands.
- **Cost and usage.** Record input/output tokens per run (from `response.usage`) and show cost per agent, goal and
  repo. Daily budgets in dollars instead of run counts.

Done when: on the demo repo an agent writes a change, runs `npm run check` itself, fixes a type error it caused, and
the transcript shows it.

### Phase 3: Multiplayer

- **Collaborators and roles** (read, write, admin) on a repo; invite by GitHub login. Write role can launch agents,
  review and push. Organizations can come later.
- **Inline review comments** on diff lines in the Intents tab and on commits. A comment on an intent under review is
  sent to the agent as a change request with the file and line.
- **Activity across repos** on the dashboard (your repos and repos you collaborate on).

### Phase 4: First-run experience

- **Onboarding.** After first sign-in: a short guided flow (create the demo repo, run a goal, approve a review).
- **Showcase repos.** A few public repos, owned by a `hive` account, with finished goals, transcripts and reviews to
  browse from the landing page and Explore.
- **Replay.** Play back a finished run (lease map, activity and merges) on a timeline, for demos and for
  understanding what happened while you were away.
- Better empty states everywhere, a light theme, and mobile layout checks.

### Phase 5: Fit into real workflows

- **GitHub repo picker** with private repos (the `repo` scope is already requested for PRs): import any repo you can
  read, and sync automatically on push via a GitHub webhook (or a scheduled sync).
- **Personal access tokens and a public API** so outside agents and CI can create tasks, take leases, submit intents
  and read state.
- **Agent Client Protocol endpoint** so ACP agents (Claude Code, Zed, Gemini CLI) can join a repo as Hive agents with
  their own fork, using the same lease and intent protocol. Hive's owner also maintains `acp-cpp`.

### Phase 6: Hardening

- Large repos: stop keeping full in-memory clones in the coordinator (use the sandbox or ArtifactFS for working copies,
  and the binding for reads).
- Agent durability: resume a run after a Durable Object eviction (persist the message history per turn).
- A queue instead of the hard limit of 8 concurrent agents per repo.
- Integration tests for the Worker (Vitest with the Workers pool) covering auth, permissions, merge queue, review and
  revert.

## Open items from the last session

- **Containers permission.** The deploy uploads the Worker but cannot create the container application: the
  Cloudflare API token needs **Containers: Edit** (and the account needs Workers Paid). Until then, checks are recorded
  as skipped in production. After fixing, redeploy and run a real check on a demo repo.
- **Opening a GitHub PR** has only been tested against a mocked GitHub API. Test on a scratch repository.

## Working notes for the session

- Toolchain is Vite+: `vp install`, `vp check --fix`, `vp run -r test`, `vp run dev`, `vp run deploy` (from
  `apps/hive`). Add dependencies with `vp add` / `vp add -D`; do not edit dependency lists in `package.json` by hand.
- Secrets live in `apps/hive/.dev.vars` locally (see `.dev.vars.example`) and as Worker secrets in production
  (`ANTHROPIC_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). The shell provides `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `HIVE_ANTHROPIC_API_KEY`.
- Local sign-in without GitHub: `HIVE_DEV_LOGIN=1` in `.dev.vars`, then open `/auth/dev?login=<name>`.
- In the cloud sandbox, run Wrangler with `NODE_USE_ENV_PROXY=1` (e.g. `NODE_USE_ENV_PROXY=1 npx wrangler deploy`).
  Do not use `pkill -f` with a pattern that also matches your own command line.
- After changing `wrangler.jsonc`, run `npx wrangler types` in `apps/hive`.
- Durable Objects update eventually after a deploy; a request can briefly reach an object still on the old code.
- Test agent features against the demo template: it is small, typed, and its tasks collide on purpose.
