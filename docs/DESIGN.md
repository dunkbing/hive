# Hive design

## Problem

GitHub's model (one branch per change, a pull request, a reviewer, a human resolving the occasional conflict) assumes
changes take hours and conflicts are rare. Put ten agents on one repo and branches go stale in seconds, conflicts pile
up, and nobody is around to resolve them.

Hive is built around three primitives designed for agents: **leases**, **a fork per agent** and **intents**.

## Primitives

### Leases

A lease gives an agent exclusive edit rights on a file (or a line range) for a short TTL (120s, renewed on every agent
turn). Leases are granted by a single coordinator, so there is no race between two agents taking the same file.

- Overlap rules live in [`packages/core/src/leases.ts`](../packages/core/src/leases.ts): same path, and either side is
  a whole-file lease or the line ranges intersect. An agent never blocks itself.
- A denied request returns the holder and its reason. The agent can do other work first, or wait in line (it polls,
  and repeated polls are not counted as new collisions).
- Expired leases are swept by a Durable Object alarm. A crashed or stuck agent never blocks anyone for long. A waiting
  agent does not renew its own leases, so two agents waiting on each other break the deadlock on expiry.
- **A granted lease returns the latest content of the file on `main`.** That content becomes the agent's merge base
  for the file. This is what makes leased edits conflict-free: nobody else could change the file between the grant
  and the merge.

### A fork per agent

When an agent joins, the coordinator forks `main` into `<repo>--<agentId>` using the Artifacts binding and gives the
agent a write token for its fork and a read token for `main`. Agents can never push to `main`. Their work is durable
and inspectable in their fork. On `submit` the agent clones its fork, fetches `main`, resets onto it, writes its
files, commits and force-pushes, so the fork commit is always "latest main + my change".

### Intents

An intent is a one-sentence statement of what the agent meant to do, plus the commit on its fork, plus for each file
the base content the agent started from. The coordinator's merge queue processes intents strictly in order:

1. Read the agent's version of each file from its fork commit (`repo.readFile({ ref: commit, path })`).
2. 3-way merge each file ([`packages/core/src/merge.ts`](../packages/core/src/merge.ts)) using base, current `main`
   and the agent's version:
   - `main` unchanged since base → take the agent's version (fast-forward)
   - both changed, non-overlapping → diff3 auto-merge
   - overlapping → conflict
3. No conflicts → commit to `main` as the agent (`Hive-Intent:` / `Hive-Agent:` trailers), push, release the agent's
   leases, broadcast.
4. Conflicts → **replay**: return the current `main` content of the conflicting files to the agent, which redoes its
   intent on top of them and resubmits. After 3 attempts the intent is rejected.

## Architecture

| Component         | Runs on                       | Responsibility                                             |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| API Worker        | Workers + Hono                | Routes, static dashboard (Workers Static Assets)           |
| `RepoCoordinator` | Durable Object, one per repo  | Repo lifecycle, forks, tokens, leases, merge queue, events |
| `HiveAgent`       | Durable Object, one per agent | Claude tool-use loop, run from an alarm                    |
| Git storage       | Cloudflare Artifacts          | `main` repo + one fork per agent                           |
| Git client        | `isomorphic-git` in Workers   | Seeding, agent commits, coordinator merges                 |
| Dashboard         | React, served by the Worker   | Live view over a hibernatable WebSocket                    |

The coordinator is the single writer to `main`. It keeps an in-memory clone and re-clones once if a push fails (for
example after the object was evicted). Its state (agents, leases, intents, commits, stats, the last 300 events) is
persisted to Durable Object storage after every change and broadcast to every connected dashboard as a full
snapshot, which keeps the client trivial.

### Agent loop

Agents use Claude with five tools: `list_files`, `read_file`, `request_lease`, `write_file`, `submit`. With leases on,
`write_file` refuses files the agent does not hold. The model is configurable (`HIVE_MODEL`, default
`claude-opus-5-5` at `low` effort) and requests use the server-side refusal fallback.

## Demo scenario

Five tasks against a small TODO API, chosen to collide: validation and pagination both live in the `GET`/`POST`
handlers of `src/routes/todos.ts`, the `priority` field touches the model, store and routes, and the bulk delete
touches the store and routes. Only the logger task is independent.

Toggling leases off shows why they matter: the same tasks produce auto-merges and real conflicts, which Hive resolves
by replaying intents.

## Next

- **Tests before merge:** run the repo's checks in a Sandbox container against the merged tree and replay the intent
  with the failure log on red.
- **Line-range and symbol leases from agents:** the lease logic supports ranges; agents currently lease whole files.
- **External agents:** expose join, lease and intent over HTTP / the Agent Client Protocol so any agent (Claude Code,
  Zed, Gemini CLI) can join a repo with its own fork and token.
- **Tournament mode:** N agents on one task in N forks, with the best result merged.
