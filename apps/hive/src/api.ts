import type { HiveEvent, RepoState } from "@hive/core";
import { useEffect, useState } from "react";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : ((await res.text()) as T);
}

export const api = {
  createRepo: (name?: string) => call<RepoState>("/repos", { method: "POST", body: JSON.stringify({ name }) }),
  state: (repo: string) => call<RepoState>(`/repos/${repo}/state`),
  runScenario: (repo: string, count?: number) =>
    call<RepoState>(`/repos/${repo}/scenario`, { method: "POST", body: JSON.stringify({ count }) }),
  setLeases: (repo: string, leasesEnabled: boolean) =>
    call<RepoState>(`/repos/${repo}/settings`, { method: "POST", body: JSON.stringify({ leasesEnabled }) }),
  file: (repo: string, path: string) => call<string>(`/repos/${repo}/file?path=${encodeURIComponent(path)}`),
  clone: (repo: string) => call<{ command: string }>(`/repos/${repo}/clone`),
};

export type Connection = "connecting" | "live" | "offline";

/** Live repo state: an initial fetch, then a full snapshot on every event over a WebSocket. */
export function useRepo(repo: string) {
  const [state, setState] = useState<RepoState | null>(null);
  const [lastEvent, setLastEvent] = useState<HiveEvent | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    api.state(repo).then(setState, (err: Error) => setError(err.message));

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/api/repos/${repo}/ws`);
      socket.onopen = () => {
        retry = 0;
        setConnection("live");
      };
      socket.onmessage = (msg) => {
        if (typeof msg.data !== "string" || msg.data === "pong") return;
        const data = JSON.parse(msg.data) as { state: RepoState; event?: HiveEvent };
        setState(data.state);
        if (data.event) setLastEvent(data.event);
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection("offline");
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    const ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);

    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      socket?.close();
    };
  }, [repo]);

  return { state, lastEvent, connection, error };
}
