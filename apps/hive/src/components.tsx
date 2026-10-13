import type { FileChange, Visibility } from "@hive/core";
import { structuredPatch } from "diff";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useEffect, useMemo, useState, type ReactNode } from "react";

for (const [name, lang] of Object.entries({
  bash,
  c,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  css: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "yaml",
};

function languageFor(path: string) {
  return LANG_BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""];
}

function highlight(code: string, path: string) {
  const lang = languageFor(path);
  if (!lang || code.length > 400_000) return escapeHtml(code);
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path fill="var(--honey)" d="M16 2 28 9v14l-12 7L4 23V9z" />
      <path fill="var(--bg)" d="M16 9.5 22 13v6l-6 3.5-6-3.5v-6z" />
    </svg>
  );
}

export function Avatar({ src, size = 20, alt = "" }: { src: string; size?: number; alt?: string }) {
  return <img className="avatar" src={src} width={size} height={size} alt={alt} />;
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return <span className={`pill pill-${visibility}`}>{visibility === "public" ? "Public" : "Private"}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function ErrorBox({ error }: { error: Error | string }) {
  return <div className="error-box">{typeof error === "string" ? error : error.message}</div>;
}

export function timeAgo(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(at).toLocaleDateString();
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useTick(ms = 15_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CodeView({ code, path }: { code: string; path: string }) {
  const html = useMemo(() => highlight(code, path), [code, path]);
  const lines = useMemo(() => code.split("\n").length - (code.endsWith("\n") ? 1 : 0), [code]);
  return (
    <div className="codeview">
      <pre className="gutter" aria-hidden="true">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join("\n")}
      </pre>
      <pre className="hljs code-body">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number };

function diffLines(change: FileChange): { lines: DiffLine[]; added: number; removed: number } {
  const patch = structuredPatch(change.path, change.path, change.before ?? "", change.after ?? "", "", "", {
    context: 3,
  });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    lines.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let o = hunk.oldStart;
    let n = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith("\\")) continue;
      const text = raw.slice(1);
      if (raw[0] === "+") {
        lines.push({ kind: "add", text, new: n++ });
        added++;
      } else if (raw[0] === "-") {
        lines.push({ kind: "del", text, old: o++ });
        removed++;
      } else {
        lines.push({ kind: "ctx", text, old: o++, new: n++ });
      }
    }
  }
  return { lines, added, removed };
}

export function FileDiff({ change, defaultOpen = true }: { change: FileChange; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const diff = useMemo(() => (change.omitted ? null : diffLines(change)), [change]);
  return (
    <div className="filediff">
      <button className="filediff-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className={`status status-${change.status}`}>{change.status}</span>
        <span className="mono">{change.path}</span>
        {diff && (
          <span className="diffstat">
            <span className="plus">+{diff.added}</span> <span className="minus">−{diff.removed}</span>
          </span>
        )}
      </button>
      {open &&
        (change.omitted ? (
          <div className="diff-note">
            {change.omitted === "binary" ? "Binary file not shown." : "File too large to show."}
          </div>
        ) : diff && diff.lines.length === 0 ? (
          <div className="diff-note">No textual changes.</div>
        ) : (
          <table className="diff">
            <tbody>
              {diff!.lines.map((l, i) => (
                <tr key={i} className={`dl dl-${l.kind}`}>
                  {l.kind === "hunk" ? (
                    <td colSpan={3} className="dl-hunktext">
                      {l.text}
                    </td>
                  ) : (
                    <>
                      <td className="ln">{l.old ?? ""}</td>
                      <td className="ln">{l.new ?? ""}</td>
                      <td className="dl-text">
                        <span className="dl-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                        {l.text}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

/** Splits a commit message into its subject, body, and Hive trailers. */
export function parseMessage(message: string) {
  const lines = message.split("\n");
  const trailers: Record<string, string> = {};
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^(Hive-[A-Za-z]+):\s*(.+)$/);
    if (m) trailers[m[1]] = m[2];
    else body.push(line);
  }
  return { subject: lines[0], body: body.join("\n").trim(), trailers };
}

export const STATUS_LABEL: Record<import("@hive/core").AgentStatus, string> = {
  idle: "starting",
  planning: "planning",
  reading: "reading",
  waiting: "waiting for lease",
  editing: "editing",
  submitting: "committing",
  queued: "in merge queue",
  replaying: "replaying intent",
  review: "awaiting review",
  done: "done",
  cancelled: "cancelled",
  failed: "failed",
};

export const INTENT_LABEL: Record<import("@hive/core").IntentStatus, string> = {
  queued: "queued",
  merging: "merging",
  merged: "merged",
  replaying: "replaying",
  review: "awaiting review",
  changes_requested: "changes requested",
  rejected: "rejected",
  reverted: "reverted",
};

export function isRunning(status: import("@hive/core").AgentStatus) {
  return !["done", "failed", "cancelled", "review"].includes(status);
}
