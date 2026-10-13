/** A lease on a region of a file. Omitting the line range leases the whole file. */
export interface LeaseScope {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface Lease extends LeaseScope {
  id: string;
  /** The holder: an agent id, or `human:<login>` for a person. */
  agentId: string;
  /** Display name of the holder. */
  holderName: string;
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
  /** Submitted; waiting for a human to review the intent. */
  | "review"
  | "done"
  | "cancelled"
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

export type IntentStatus =
  | "queued"
  | "merging"
  | "merged"
  | "replaying"
  | "review"
  | "changes_requested"
  | "rejected"
  | "reverted";

export type MergeMode = "auto" | "review";

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
  /** Commit on main that reverted the intent. */
  revertedAs?: string;
  conflicts?: string[];
  /** The latest review comment, when changes were requested or the intent was rejected. */
  reviewComment?: string;
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
  | { type: "repo.failed"; error: string }
  | { type: "repo.settings"; leasesEnabled: boolean; mergeMode: MergeMode }
  | { type: "agent.joined"; agent: AgentInfo }
  | { type: "agent.status"; agentId: string; status: AgentStatus; detail: string }
  | { type: "lease.granted"; lease: Lease }
  | { type: "lease.denied"; agentId: string; scope: LeaseScope; holder: Lease }
  | { type: "lease.released"; leaseId: string; agentId: string; path: string; reason: "done" | "expired" }
  | { type: "intent.queued"; intent: Intent }
  | { type: "intent.merged"; intentId: string; agentId: string; commit: CommitInfo; mode: "direct" | "auto-merge" }
  | { type: "intent.conflict"; intentId: string; agentId: string; files: string[] }
  | { type: "intent.replaying"; intentId: string; agentId: string; attempt: number }
  | { type: "intent.review"; intentId: string; agentId: string }
  | { type: "intent.changes_requested"; intentId: string; agentId: string; comment: string; by: string }
  | { type: "intent.rejected"; intentId: string; agentId: string; reason: string }
  | { type: "intent.reverted"; intentId: string; agentId: string; commit: CommitInfo; by: string }
  | { type: "commit.external"; head: string };

export type HiveEvent = HiveEventBody & { seq: number; ts: number };

export type RepoStatus = "creating" | "importing" | "ready" | "failed";

/** Live coordination state of one repo, pushed to dashboards on every change. */
export interface RepoState {
  id: string;
  /** What the repo was created from. */
  template: "empty" | "demo" | "import";
  status: RepoStatus;
  statusError: string | null;
  remote: string;
  branch: string;
  head: string | null;
  leasesEnabled: boolean;
  mergeMode: MergeMode;
  agents: AgentInfo[];
  leases: Lease[];
  intents: Intent[];
  commits: CommitInfo[];
  stats: RepoStats;
  events: HiveEvent[];
}
