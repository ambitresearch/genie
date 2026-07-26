/**
 * Regression tests for the harness temp-dir cleanup helper (#259).
 *
 * `m5-smoke-cline.test.ts` intermittently failed in *teardown* — not in an
 * assertion — with `ENOTEMPTY: directory not empty, rmdir '<tmp>/.cline/data'`.
 * The pinned Cline CLI leaves a background host process writing into its data
 * directory after `execFile` resolves, so files reappear between the recursive
 * walk and the final `rmdir`.
 *
 * Two properties fix that, and both are pinned here:
 *
 *  1. Removal must **retry** on the transient POSIX codes the OS raises when a
 *     directory is concurrently repopulated (`ENOTEMPTY`, `EBUSY`, `EPERM`,
 *     `EMFILE`, `ENFILE`). `fs.rm` already implements exactly this back-off via
 *     `maxRetries` / `retryDelay`, so the helper forwards them rather than
 *     re-implementing a retry loop — but nothing forced those options to be
 *     passed, so the forwarding itself is asserted.
 *  2. Removal must **never throw**. A leaked directory under the OS temp root is
 *     not a correctness problem; failing the suite over one turns a cosmetic
 *     race into a red build.
 */
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { removeTempDir, type RemoveTempDirRmOptions } from "./temp-dir.js";

/** Builds an `Error` carrying a POSIX `code`, as `fs` rejections do. */
function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("removeTempDir (#259)", () => {
  it("forwards the retry options fs.rm needs to survive a repopulating directory", async () => {
    const calls: Array<[string, RemoveTempDirRmOptions]> = [];
    const removed = await removeTempDir("/tmp/does-not-matter", {
      rm: async (dir, options) => {
        calls.push([dir, options]);
      },
    });

    expect(removed).toBe(true);
    expect(calls).toHaveLength(1);
    const [dir, options] = calls[0]!;
    expect(dir).toBe("/tmp/does-not-matter");
    expect(options.recursive).toBe(true);
    expect(options.force).toBe(true);
    // The two that actually mitigate ENOTEMPTY. Without them fs.rm makes a
    // single attempt and the Cline race is unmitigated.
    expect(options.maxRetries).toBeGreaterThan(0);
    expect(options.retryDelay).toBeGreaterThan(0);
  });

  it("honours caller-supplied retry tuning", async () => {
    let seen: RemoveTempDirRmOptions | undefined;
    await removeTempDir("/tmp/tuned", {
      maxRetries: 9,
      retryDelay: 250,
      rm: async (_dir, options) => {
        seen = options;
      },
    });

    expect(seen?.maxRetries).toBe(9);
    expect(seen?.retryDelay).toBe(250);
  });

  it("swallows ENOTEMPTY rather than failing teardown, and reports it", async () => {
    const warnings: string[] = [];
    const removed = await removeTempDir("/tmp/genie-cline-cli-smoke-XXXX", {
      rm: async () => {
        throw fsError("ENOTEMPTY");
      },
      warn: (message) => warnings.push(message),
    });

    expect(removed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/tmp/genie-cline-cli-smoke-XXXX");
    expect(warnings[0]).toContain("ENOTEMPTY");
  });

  it("swallows non-transient errors too — teardown must never fail the run", async () => {
    const warnings: string[] = [];
    const removed = await removeTempDir("/tmp/genie-eacces", {
      rm: async () => {
        throw fsError("EACCES");
      },
      warn: (message) => warnings.push(message),
    });

    expect(removed).toBe(false);
    expect(warnings[0]).toContain("EACCES");
  });

  it("swallows a non-Error rejection without losing the directory in the message", async () => {
    const warnings: string[] = [];
    const removed = await removeTempDir("/tmp/genie-weird", {
      rm: async () => {
        throw "not an Error";
      },
      warn: (message) => warnings.push(message),
    });

    expect(removed).toBe(false);
    expect(warnings[0]).toContain("/tmp/genie-weird");
    expect(warnings[0]).toContain("not an Error");
  });

  it("removes a real populated tree via the default fs.rm", async () => {
    const base = await mkdtemp(join(tmpdir(), "genie-259-real-"));
    await mkdir(join(base, "a", "b"), { recursive: true });
    await writeFile(join(base, "a", "b", "leaf.txt"), "x");

    const removed = await removeTempDir(base);

    expect(removed).toBe(true);
    await expect(stat(base)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an already-absent directory as success and stays quiet", async () => {
    const warnings: string[] = [];
    const removed = await removeTempDir(join(tmpdir(), "genie-259-never-created"), {
      warn: (message) => warnings.push(message),
    });

    expect(removed).toBe(true);
    expect(warnings).toEqual([]);
  });
});
