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
