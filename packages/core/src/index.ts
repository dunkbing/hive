export * from "./api.ts";
export * from "./types.ts";
export * from "./leases.ts";
export * from "./merge.ts";

export const AGENT_COLORS = ["#f5a524", "#17c964", "#006fee", "#f31260", "#7828c8", "#06b7db", "#ff4ecd", "#a3e635"];

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "-------";
}
