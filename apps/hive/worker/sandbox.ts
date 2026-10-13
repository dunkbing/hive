import type { CheckResult } from "@hive/core";
import { DurableObject } from "cloudflare:workers";

const IMAGE = "cloudflare/debian-trixie";
const MAX_LOG = 12_000;

/**
 * A throwaway Linux sandbox that runs a repository's checks against a working tree. One instance per check
 * (named randomly), destroyed afterwards. The tree arrives as a tar archive over stdin; no credentials go in.
 */
export class HiveSandbox extends DurableObject<Env> {
  async check(archive: Uint8Array, command: string, timeoutSeconds: number): Promise<CheckResult> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured.");
    const started = Date.now();
    const decoder = new TextDecoder();

    if (!container.running) {
      // Packages and toolchains are downloaded by the check command itself.
      container.start({
        image: IMAGE,
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
        instance: "standard-1",
      });
    }
    try {
      const unpack = await container.exec(["sh", "-c", "mkdir -p /workspace && tar -x -C /workspace"], {
        stdin: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(archive);
            controller.close();
          },
        }),
        stderr: "combined",
      });
      const unpacked = await unpack.output();
      if (unpacked.exitCode !== 0) {
        return result(
          false,
          unpacked.exitCode,
          `Could not unpack the tree:\n${decoder.decode(unpacked.stdout)}`,
          started,
        );
      }

      // `timeout` stops the command and everything it started; exit code 124 means it ran out of time.
      const run = await container.exec(["timeout", "--kill-after=5", String(timeoutSeconds), "bash", "-lc", command], {
        cwd: "/workspace",
        stderr: "combined",
        env: { CI: "1" },
      });
      const output = await run.output();
      let log = decoder.decode(output.stdout);
      if (output.exitCode === 124) log += `\n[stopped after ${timeoutSeconds}s]`;
      return result(output.exitCode === 0, output.exitCode, log, started);
    } finally {
      if (container.running) await container.destroy();
    }
  }
}

function result(passed: boolean, exitCode: number, log: string, started: number): CheckResult {
  const tail = log.length > MAX_LOG ? `…\n${log.slice(-MAX_LOG)}` : log;
  return { status: passed ? "passed" : "failed", exitCode, log: tail, durationMs: Date.now() - started };
}
