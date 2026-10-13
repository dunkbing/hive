import type { CommitDetail, CommitSummary, HiveEvent, Me, RepoRecord, RepoState, Tree, Visibility } from "@hive/core";
import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : ((await res.text()) as T);
}

const repoPath = (owner: string, name: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

function query(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type RepoSourceInput = { type: "empty" } | { type: "demo" } | { type: "import"; url: string };

export interface RepoPayload {
  repo: RepoRecord;
  canWrite: boolean;
  state: RepoState;
}

export const api = {
  me: () => call<Me>("/me"),
  logout: () => fetch("/auth/logout", { method: "POST" }),
  myRepos: () => call<RepoRecord[]>("/repos"),
  explore: () => call<RepoRecord[]>("/explore"),
  userRepos: (owner: string) => call<RepoRecord[]>(`/users/${encodeURIComponent(owner)}/repos`),
  createRepo: (body: { name: string; description: string; visibility: Visibility; source: RepoSourceInput }) =>
    call<RepoRecord>("/repos", { method: "POST", body: JSON.stringify(body) }),
  repo: (owner: string, name: string) => call<RepoPayload>(repoPath(owner, name)),
  tree: (owner: string, name: string, ref?: string, fork?: string) =>
    call<Tree>(`${repoPath(owner, name)}/tree${query({ ref, fork })}`),
  blob: (owner: string, name: string, path: string, ref?: string, fork?: string) =>
    call<string>(`${repoPath(owner, name)}/blob${query({ path, ref, fork })}`),
  commits: (owner: string, name: string, opts: { ref?: string; fork?: string; offset?: number } = {}) =>
    call<CommitSummary[]>(
      `${repoPath(owner, name)}/commits${query({
        ref: opts.ref,
        fork: opts.fork,
        offset: opts.offset ? String(opts.offset) : undefined,
      })}`,
    ),
  commit: (owner: string, name: string, sha: string, fork?: string) =>
    call<CommitDetail>(`${repoPath(owner, name)}/commit/${sha}${query({ fork })}`),
  clone: (owner: string, name: string) => call<{ command: string; remote: string }>(`${repoPath(owner, name)}/clone`),
  launchAgents: (owner: string, name: string, body: { demo: true } | { tasks: { task: string }[] }) =>
    call<RepoState>(`${repoPath(owner, name)}/agents`, { method: "POST", body: JSON.stringify(body) }),
  updateSettings: (
    owner: string,
    name: string,
    body: { leasesEnabled?: boolean; description?: string; visibility?: Visibility },
  ) =>
    call<{ repo: RepoRecord; state: RepoState }>(`${repoPath(owner, name)}/settings`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  retryImport: (owner: string, name: string) => call<RepoState>(`${repoPath(owner, name)}/retry`, { method: "POST" }),
  deleteRepo: (owner: string, name: string) => call<{ ok: true }>(repoPath(owner, name), { method: "DELETE" }),
};

/** Runs `load` whenever `key` changes and tracks loading and error state. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [result, setResult] = useState<{ key: string; data?: T; error?: Error } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setResult({ key, data }),
      (error: Error) => !cancelled && setResult({ key, error }),
    );
    return () => {
      cancelled = true;
    };
    // `key` captures everything `load` depends on.
  }, [key, version]); // oxlint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const current = result?.key === key ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: !current, reload };
}

export type Connection = "connecting" | "live" | "polling";

/**
 * Live coordination state for a repo: a snapshot on every event over a WebSocket, falling back to polling while the
 * socket is down (some proxies and conference networks block upgrades).
 */
export function useLiveState(owner: string, name: string, initial: RepoState) {
  const [state, setState] = useState<RepoState>(initial);
  const [lastEvent, setLastEvent] = useState<HiveEvent | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let live = false;
    let retry = 0;
    let lastSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (next: RepoState, event?: HiveEvent) => {
      setState(next);
      const newest = event ?? next.events.at(-1);
      if (newest && newest.seq > lastSeq) {
        lastSeq = newest.seq;
        setLastEvent(newest);
      }
    };
    const poll = () =>
      api.repo(owner, name).then(
        (p) => apply(p.state),
        () => undefined,
      );
    const poller = setInterval(() => !live && void poll(), 2_500);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/api${repoPath(owner, name)}/ws`);
      socket.onopen = () => {
        retry = 0;
        live = true;
        setConnection("live");
      };
      socket.onmessage = (msg) => {
        if (typeof msg.data !== "string" || msg.data === "pong") return;
        const data = JSON.parse(msg.data) as { state: RepoState; event?: HiveEvent };
        apply(data.state, data.event);
      };
      socket.onclose = () => {
        if (closed) return;
        live = false;
        setConnection("polling");
        timer = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** retry++));
      };
    };
    connect();
    const ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);

    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      clearInterval(poller);
      socket?.close();
    };
  }, [owner, name]);

  return { state, setState, lastEvent, connection };
}
