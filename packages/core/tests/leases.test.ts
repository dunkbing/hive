import { describe, expect, test } from "vite-plus/test";
import { findBlockingLease, holdsLease, scopesOverlap, type Lease } from "../src/index.ts";

const lease = (over: Partial<Lease>): Lease => ({
  id: "l1",
  agentId: "a1",
  path: "src/app.ts",
  reason: "test",
  grantedAt: 0,
  expiresAt: 1_000,
  ...over,
});

describe("scopesOverlap", () => {
  test("different paths never overlap", () => {
    expect(scopesOverlap({ path: "a.ts" }, { path: "b.ts" })).toBe(false);
  });

  test("whole-file scope overlaps any range in the same file", () => {
    expect(scopesOverlap({ path: "a.ts" }, { path: "a.ts", startLine: 10, endLine: 20 })).toBe(true);
  });

  test("line ranges overlap only when they intersect", () => {
    expect(
      scopesOverlap({ path: "a.ts", startLine: 1, endLine: 10 }, { path: "a.ts", startLine: 10, endLine: 12 }),
    ).toBe(true);
    expect(
      scopesOverlap({ path: "a.ts", startLine: 1, endLine: 9 }, { path: "a.ts", startLine: 10, endLine: 12 }),
    ).toBe(false);
  });
});

describe("findBlockingLease", () => {
  test("another agent's active lease blocks", () => {
    const held = lease({});
    expect(findBlockingLease([held], { path: "src/app.ts" }, "a2", 500)).toBe(held);
  });

  test("an agent never blocks itself", () => {
    expect(findBlockingLease([lease({})], { path: "src/app.ts" }, "a1", 500)).toBeUndefined();
  });

  test("expired leases do not block", () => {
    expect(findBlockingLease([lease({})], { path: "src/app.ts" }, "a2", 1_000)).toBeUndefined();
  });
});

describe("holdsLease", () => {
  test("a whole-file lease covers any range", () => {
    expect(holdsLease([lease({})], { path: "src/app.ts", startLine: 3 }, "a1", 0)).toBe(true);
  });

  test("a range lease does not cover the whole file", () => {
    expect(holdsLease([lease({ startLine: 1, endLine: 5 })], { path: "src/app.ts" }, "a1", 0)).toBe(false);
  });
});
