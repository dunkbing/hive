// Shapes returned by the Hive HTTP API, shared by the Worker and the dashboard.

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface Me {
  user: User | null;
  agentsToday?: number;
  /** null when the user has no daily limit. */
  dailyAgentLimit?: number | null;
  /** Whether the user granted repository access on GitHub (for pull requests). */
  githubConnected?: boolean;
  /** Unread inbox notifications. */
  unread?: number;
}

export type NotificationKind =
  | "review_requested"
  | "check_failed"
  | "agent_done"
  | "agent_failed"
  | "goal_review"
  | "goal_done";

export interface Notification {
  id: number;
  kind: NotificationKind;
  /** owner/name of the repository it is about. */
  repo: string;
  title: string;
  body: string;
  /** In-app path, e.g. /owner/name/goals/3. */
  link: string;
  createdAt: number;
  read: boolean;
}

export type Visibility = "public" | "private";

export interface RepoRecord {
  /** Internal id; also the Artifacts repo name and the coordinator's Durable Object name. */
  id: string;
  ownerId: string;
  owner: string;
  name: string;
  description: string;
  visibility: Visibility;
  createdAt: number;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

export interface Tree {
  sha: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  email: string;
  at: number;
  parents: string[];
}

export interface FileChange {
  path: string;
  status: "added" | "deleted" | "modified";
  before: string | null;
  after: string | null;
  /** Set when the content is binary or too large to show. */
  omitted?: "binary" | "too-large";
}

export interface CommitDetail {
  commit: CommitSummary;
  files: FileChange[];
  truncated: boolean;
}

export interface TranscriptStep {
  id: number;
  /** Runs count up from 1: the first attempt, then revisions. */
  run: number;
  ts: number;
  kind: "run" | "thinking" | "text" | "tool" | "message" | "status";
  title: string;
  body: string | null;
  error: boolean;
}

export interface PlannedTask {
  /** Short kebab-case agent name. */
  name: string;
  task: string;
  /** Files the task expects to change; two tasks sharing a file will take turns on it. */
  files: string[];
}

export interface Plan {
  summary: string;
  tasks: PlannedTask[];
}

export interface PullRequestInfo {
  number: number;
  url: string;
  branch: string;
  title: string;
  /** Hive commit the pull request was built from. */
  head: string;
  createdAt: number;
}

/** For repositories imported from GitHub. */
export interface GithubLink {
  /** owner/repo */
  repo: string;
  /** The upstream commit Hive last imported or synced with. */
  base: string | null;
  pullRequests: PullRequestInfo[];
}

/** The outcome of a repository's check command run against a merged tree in a sandbox. */
export interface CheckResult {
  status: "passed" | "failed" | "skipped";
  exitCode: number;
  /** The end of the combined output. */
  log: string;
  durationMs: number;
}
