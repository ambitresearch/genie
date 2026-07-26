/**
 * Unit tests for the retry-tolerant temp removal that fixes genie#259.
 *
 * The end-to-end symptom (an ENOTEMPTY thrown out of the cline smoke test's
 * teardown) is by nature intermittent, so asserting on it directly would just
 * move the flake into the test suite. These tests instead pin the two
 * properties that make the flake impossible, both of which ARE deterministic:
 *
 *   1. Removal is attempted with retries enabled — the thing `fs.rm`'s defaults
 *      do not do (`maxRetries` defaults to 0, and `force` only covers ENOENT).
 *   2. Removal can never throw, no matter what the filesystem says.
 *
 * Property 2 is exercised against a REAL concurrent writer — a detached child
 * process re-creating files inside the tree as fast as it can — which is the
 * actual shape of the production race (Cline's hub daemon writing into
 * `<base>/.cline/data`). That test fails against a bare
 * `rm(dir, { recursive: true, force: true })`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir, TEMP_DIR_RM_OPTIONS } from "./temp-dir.js";

/**
 * A child that re-creates files under `<dir>/.cline/data` in a tight loop —
 * the same directory shape, and the same "writes faster than a walk" pressure,
 * that Cline's hub daemon applies to the smoke test's temp root.
 */
const WRITER_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.argv[1], ".cline", "data");
for (let i = 0; ; i++) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cron.db-wal." + (i % 64)), "x");
  } catch {
    // The remover may delete the tree mid-write; just keep re-creating it.
  }
}
`;

const writers: ChildProcess[] = [];

/**
 * Poll for `predicate` up to `timeoutMs`. Generous by default: these tests are
 * expected to run on loaded CI runners (and were developed against a machine at
 * load average 85), where spawning a process or removing a small tree can take
 * seconds. A tight bound here would just trade one flake for another.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Spawn the hammering writer and wait until it has actually created files. */
async function startWriter(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", WRITER_SCRIPT, dir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writers.push(child);
  const target = join(dir, ".cline", "data");
  if (!(await waitFor(() => exists(target)))) {
    throw new Error("writer child never created its directory");
  }
  return child;
}

/** Stop a writer and wait for the OS to reap it. */
async function stopWriter(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitFor(() => Promise.resolve(!isAlive(pid)));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(writers.splice(0).map(stopWriter));
});

describe("removeTempDir (genie#259)", () => {
  it("removes a populated tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genie-temp-dir-test-"));
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c.txt"), "hello");

    await expect(removeTempDir(dir)).resolves.toBe(true);
    expect(await exists(dir)).toBe(false);
  }, 60_000);

  it("is a no-op for a path that never existed", async () => {
    const warnings: string[] = [];
    const missing = join(tmpdir(), `genie-temp-dir-absent-${process.pid}-${Date.now()}`);

    await expect(removeTempDir(missing, { onWarn: (m) => warnings.push(m) })).resolves.toBe(true);
    expect(warnings).toEqual([]);
  }, 60_000);

  it("asks node to retry the transient errors that cause the flake", async () => {
    // `force` alone does not cover ENOTEMPTY, and `maxRetries` defaults to 0 —
    // this is the option set whose absence produced the CI failure.
    expect(TEMP_DIR_RM_OPTIONS.recursive).toBe(true);
    expect(TEMP_DIR_RM_OPTIONS.force).toBe(true);
    expect(TEMP_DIR_RM_OPTIONS.maxRetries).toBeGreaterThanOrEqual(3);
    expect(TEMP_DIR_RM_OPTIONS.retryDelay).toBeGreaterThan(0);

    const seen: unknown[] = [];
    await removeTempDir("/nowhere", {
      remove: async (_path, options) => {
        seen.push(options);
      },
    });
    expect(seen).toEqual([TEMP_DIR_RM_OPTIONS]);
  });

  it("reports rather than throws when removal keeps failing", async () => {
    const warnings: string[] = [];
    const boom = Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir '/x/.cline/data'"), {
      code: "ENOTEMPTY",
    });

    await expect(
      removeTempDir("/x", {
        remove: () => Promise.reject(boom),
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(false);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/x");
    expect(warnings[0]).toContain("ENOTEMPTY");
  });

  it("does not throw while a live process writes into the tree", async () => {
    // The production race, reproduced deterministically: a detached child is
    // re-creating `<dir>/.cline/data` faster than the recursive walk can empty
    // it, exactly as Cline's hub daemon does. A bare
    // `rm(dir, { recursive: true, force: true })` rejects with ENOTEMPTY here.
    const dir = await mkdtemp(join(tmpdir(), "genie-temp-dir-race-"));
    const writer = await startWriter(dir);

    // The assertion is that it RESOLVES at all. Whether the tree actually went
    // away is genuinely timing-dependent and deliberately not asserted; that a
    // bare `fs.rm` would have REJECTED here is the whole point.
    await expect(removeTempDir(dir, { onWarn: () => {} })).resolves.toBeTypeOf("boolean");

    // And once the writer is gone — the state the daemon shutdown guarantees —
    // removal completes.
    await stopWriter(writer);
    await expect(removeTempDir(dir)).resolves.toBe(true);
    expect(await exists(dir)).toBe(false);
  }, 120_000);
});
