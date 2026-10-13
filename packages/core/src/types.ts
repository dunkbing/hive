/** A lease on a region of a file. Omitting the line range leases the whole file. */
export interface LeaseScope {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface Lease extends LeaseScope {
  id: string;
  agentId: string;
  reason: string;
  grantedAt: number;
  expiresAt: number;
}

export type AgentStatus =
  | "idle"
  | "planning"
  | "reading"
  | "waiting"
  | "editing"
  | "submitting"
  | "queued"
  | "replaying"
  | "done"
  | "failed";

export interface AgentInfo {
  id: string;
  name: string;
  color: string;
  task: string;
  status: AgentStatus;
  detail: string;
  fork: string;
  joinedAt: number;
}

export type IntentStatus = "queued" | "merging" | "merged" | "replaying" | "rejected";

export interface Intent {
  id: string;
  agentId: string;
  summary: string;
  /** Commit on the agent's fork that carries the change. */
  commit: string;
  /** Paths the intent touches. */
  files: string[];
  status: IntentStatus;
  attempts: number;
  createdAt: number;
  /** Commit on main the intent landed as. */
  mergedAs?: string;
  conflicts?: string[];
}

export interface RepoStats {
  merges: number;
  /** Lease requests that were denied, i.e. collisions prevented up front. */
  collisionsAvoided: number;
  /** Intents that needed a 3-way merge but merged cleanly. */
  autoMerged: number;
  replays: number;
  rejected: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  at: number;
}

export type HiveEventBody =
  | { type: "repo.ready"; head: string }
  | { type: "repo.settings"; leasesEnabled: boolean }
  | { type: "agent.joined"; agent: AgentInfo }
  | { type: "agent.status"; agentId: string; status: AgentStatus; detail: string }
  | { type: "lease.granted"; lease: Lease }
  | { type: "lease.denied"; agentId: string; scope: LeaseScope; holder: Lease }
  | { type: "lease.released"; leaseId: string; agentId: string; path: string; reason: "done" | "expired" }
  | { type: "intent.queued"; intent: Intent }
  | { type: "intent.merged"; intentId: string; agentId: string; commit: CommitInfo; mode: "direct" | "auto-merge" }
  | { type: "intent.conflict"; intentId: string; agentId: string; files: string[] }
  | { type: "intent.replaying"; intentId: string; agentId: string; attempt: number }
  | { type: "intent.rejected"; intentId: string; agentId: string; reason: string };

export type HiveEvent = HiveEventBody & { seq: number; ts: number };

export interface RepoState {
  name: string;
  remote: string;
  head: string | null;
  leasesEnabled: boolean;
  agents: AgentInfo[];
  leases: Lease[];
  intents: Intent[];
  commits: CommitInfo[];
  files: string[];
  stats: RepoStats;
  events: HiveEvent[];
}
