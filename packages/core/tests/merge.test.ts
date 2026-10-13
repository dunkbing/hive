import { describe, expect, test } from "vite-plus/test";
import { mergeFile } from "../src/index.ts";

const base = ["export function a() {}", "", "export function b() {}", "", "export function c() {}", ""].join("\n");

describe("mergeFile", () => {
  test("main unchanged since base takes the agent's version", () => {
    const agent = base.replace("a() {}", "a() { return 1; }");
    expect(mergeFile(base, base, agent)).toEqual({ clean: true, text: agent, mode: "fast-forward" });
  });

  test("non-overlapping edits merge cleanly", () => {
    const main = base.replace("a() {}", "a() { return 1; }");
    const agent = base.replace("c() {}", "c() { return 3; }");
    const result = mergeFile(base, main, agent);
    expect(result.clean).toBe(true);
    expect(result.text).toContain("a() { return 1; }");
    expect(result.text).toContain("c() { return 3; }");
  });

  test("overlapping edits conflict", () => {
    const main = base.replace("b() {}", "b() { return 'main'; }");
    const agent = base.replace("b() {}", "b() { return 'agent'; }");
    const result = mergeFile(base, main, agent);
    expect(result.clean).toBe(false);
    expect(result.text).toContain("<<<<<<<");
  });

  test("new file created by the agent", () => {
    expect(mergeFile(null, null, "hello\n")).toEqual({ clean: true, text: "hello\n", mode: "fast-forward" });
  });
});
