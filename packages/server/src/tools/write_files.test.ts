import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir, platform } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createPlan, PlanNotFoundError } from "../plans/index.js";
import { registerPlan } from "./plan.js";
import {
  DEFAULT_WRITE_BYTE_CAP,
  MAX_FILES_PER_CALL,
  WRITE_FILES_TOOL_NAME,
  registerWriteFilesTool,
  writeFiles,
} from "./write_files.js";

// `tools/plan.ts` doesn't export a name constant for its tool (unlike
// write_files' own WRITE_FILES_TOOL_NAME) — the shipped M1-07 code and its
// own test file both use this literal directly, so this test mirrors that.
const PLAN_TOOL_NAME = "mcp__genie__plan";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("writeFiles (core logic)", () => {
  let localDir: string;
  let genieHome: string;

  beforeEach(async () => {
    localDir = await tempDir("genie-wf-local-");
    // `plans/index.ts` persists every plan to `${GENIE_HOME}/plans/...` and
    // reads GENIE_HOME fresh on every call (see createPlan/plan.test.ts's own
    // isolation pattern) — scope it to a fresh temp dir per test so this
    // suite never touches the real `<cwd>/.genie/plans/`.
    genieHome = await tempDir("genie-wf-home-");
    process.env["GENIE_HOME"] = genieHome;
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(localDir, { recursive: true, force: true });
    await rm(genieHome, { recursive: true, force: true });
  });

  it("AC8 — happy path: writes files from data and returns writtenPaths in input order", async () => {
    const plan = await createPlan("k", ["components/**/*.html", "tokens.css"], [], localDir);

    const result = await writeFiles({
      planId: plan.planId,
      files: [
        { path: "components/Button.html", data: "<button>Hi</button>" },
        { path: "tokens.css", data: ":root { --c: red; }" },
      ],
    });

    expect(result.writtenPaths).toEqual(["components/Button.html", "tokens.css"]);
    await expect(readFile(join(localDir, "components", "Button.html"), "utf-8")).resolves.toBe(
      "<button>Hi</button>",
    );
    await expect(readFile(join(localDir, "tokens.css"), "utf-8")).resolves.toBe(
      ":root { --c: red; }",
    );
  });

  it("writes files from localPath, resolved against the plan's localDir", async () => {
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    await mkdir(join(localDir, "src"), { recursive: true });
    await writeFile(join(localDir, "src", "input.html"), "<div>from disk</div>", "utf-8");

    const result = await writeFiles({
      planId: plan.planId,
      files: [{ path: "dest/input.html", localPath: "src/input.html" }],
    });

    expect(result.writtenPaths).toEqual(["dest/input.html"]);
    await expect(readFile(join(localDir, "dest", "input.html"), "utf-8")).resolves.toBe(
      "<div>from disk</div>",
    );
  });

  it("writes base64-encoded inline data, decoded correctly", async () => {
    const plan = await createPlan("k", ["*.bin"], [], localDir);
    const base64 = Buffer.from("hello world", "utf-8").toString("base64");

    await writeFiles({
      planId: plan.planId,
      files: [{ path: "greeting.bin", data: base64, encoding: "base64" }],
    });

    await expect(readFile(join(localDir, "greeting.bin"), "utf-8")).resolves.toBe("hello world");
  });

  it("AC5 — rejects an unknown planId with PlanNotFoundError", async () => {
    await expect(
      writeFiles({
        planId: "00000000-0000-4000-8000-000000000000",
        files: [{ path: "a.html", data: "x" }],
      }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it("AC5 — rejects an expired planId with PlanNotFoundError", async () => {
    // plans/index.ts has no injectable clock — TTL expiry is driven by the
    // real `GENIE_PLAN_TTL` (ms) env var + real elapsed time, matching the
    // pattern the shipped plan.test.ts itself uses for its own TTL tests.
    // Shipped M1-07 collapses "never existed" and "expired" into one
    // PlanNotFoundError — there's no separate PlanExpiredError.
    process.env["GENIE_PLAN_TTL"] = "50";
    try {
      const plan = await createPlan("k", ["a.html"], [], localDir);
      await new Promise((r) => setTimeout(r, 150));

      await expect(
        writeFiles({ planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
      ).rejects.toBeInstanceOf(PlanNotFoundError);
    } finally {
      delete process.env["GENIE_PLAN_TTL"];
    }
  });

  it("AC3 — rejects more than 256 files with TooManyFilesError", async () => {
    const plan = await createPlan("k", ["*.html"], [], localDir);
    const files = Array.from({ length: MAX_FILES_PER_CALL + 1 }, (_, i) => ({
      path: `f${i}.html`,
      data: "x",
    }));

    await expect(writeFiles({ planId: plan.planId, files })).rejects.toMatchObject({
      code: "TooManyFilesError",
      count: MAX_FILES_PER_CALL + 1,
      max: MAX_FILES_PER_CALL,
    });
  });

  it("accepts exactly 256 files (boundary)", async () => {
    const plan = await createPlan("k", ["*.html"], [], localDir);
    const files = Array.from({ length: MAX_FILES_PER_CALL }, (_, i) => ({
      path: `f${i}.html`,
      data: "x",
    }));

    const result = await writeFiles({ planId: plan.planId, files });
    expect(result.writtenPaths).toHaveLength(MAX_FILES_PER_CALL);
  });

  it("rejects a call with two files targeting the same path with DuplicatePathError (Copilot review finding)", async () => {
    // Regression guard: without this check, resolvedLocalPaths (keyed by
    // file.path) would silently drop the first entry's localPath in favor
    // of the second's, and writtenPaths would list the same path twice as
    // if two distinct files had committed — when in fact only one, whichever
    // committed last, actually landed.
    const plan = await createPlan("k", ["*.txt"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [
          { path: "a.txt", data: "first" },
          { path: "a.txt", data: "second" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DuplicatePathError", path: "a.txt" });

    // Nothing lands — rejected before any staging begins.
    await expect(stat(join(localDir, "a.txt"))).rejects.toThrow();
  });

  it("rejects duplicate paths even when sourced differently (data vs. localPath)", async () => {
    const plan = await createPlan("k", ["*.txt"], [], localDir);
    await writeFile(join(localDir, "src.txt"), "from disk", "utf-8");

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [
          { path: "a.txt", data: "inline" },
          { path: "a.txt", localPath: "src.txt" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DuplicatePathError", path: "a.txt" });
  });

  it("AC4 — rejects a path outside the plan's writes with PathOutsidePlanError (reason: glob)", async () => {
    const plan = await createPlan("k", ["components/**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "secrets/token.txt", data: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "PathOutsidePlanError",
      path: "secrets/token.txt",
      reason: "glob",
    });
  });

  it("AC4 — no file lands when even one path in the batch is outside the plan (all-or-nothing)", async () => {
    const plan = await createPlan("k", ["components/**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [
          { path: "components/Good.html", data: "ok" },
          { path: "outside/Bad.html", data: "nope" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    await expect(stat(join(localDir, "components", "Good.html"))).rejects.toThrow();
  });

  it("AC4 — rejects an absolute path that matches a permissive glob but escapes localDir (Copilot review finding)", async () => {
    // Regression guard: a glob match alone does not guarantee containment.
    // "**" matches the literal string "/etc/passwd" under micromatch (an
    // absolute path is still just a string to the glob matcher), and
    // `resolve(localDir, "/etc/passwd")` returns "/etc/passwd" verbatim since
    // `path.resolve` treats an absolute second argument as an override rather
    // than joining it — so without the isPathInsideLocalDir check, this call
    // would have written outside localDir entirely, ignoring the plan's
    // containment guarantee.
    const plan = await createPlan("k", ["**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "/etc/passwd-genie-test-should-not-write", data: "pwned" }],
      }),
    ).rejects.toMatchObject({
      code: "PathOutsidePlanError",
      // reason: "escapesLocalDir" (not "glob") — a Copilot review finding
      // flagged that the error message previously always claimed a glob
      // mismatch even when the true cause was the containment check; this
      // path DOES match the "**" glob, so a plain glob-mismatch message
      // would have been actively misleading for debugging.
      reason: "escapesLocalDir",
    });

    await expect(stat("/etc/passwd-genie-test-should-not-write")).rejects.toThrow();
  });

  it("AC4 — rejects a path containing a parent-traversal segment even under a permissive glob", async () => {
    // Belt-and-suspenders: micromatch's own semantics already reject "../x"
    // against "**", but assert it explicitly so a future glob-library swap
    // can't silently reopen this.
    const plan = await createPlan("k", ["**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "../escaped.html", data: "x" }],
      }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });
  });

  it("AC6 — rejects a localPath that escapes the plan's localDir (parent traversal)", async () => {
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    // A sibling directory outside localDir with a file we must not be able to read.
    const secretsDir = await tempDir("genie-wf-secret-");
    await writeFile(join(secretsDir, "secret.txt"), "top secret", "utf-8");
    // basename() is separator-agnostic (unlike a raw `.split("/")`, which
    // would silently misparse a Windows-style path), matching this file's
    // and the codebase's established containment-helper conventions.
    const escapePath = join("..", basename(secretsDir), "secret.txt");

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "dest/leak.txt", localPath: escapePath }],
      }),
    ).rejects.toMatchObject({ code: "LocalPathEscapeError" });

    await rm(secretsDir, { recursive: true, force: true });
  });

  it("AC6 — rejects an absolute localPath outside localDir", async () => {
    const plan = await createPlan("k", ["dest/**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "dest/leak.txt", localPath: "/etc/hostname" }],
      }),
    ).rejects.toMatchObject({ code: "LocalPathEscapeError" });
  });

  it("AC6 — accepts a localPath inside a nested subdirectory of localDir", async () => {
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    await mkdir(join(localDir, "a", "b", "c"), { recursive: true });
    await writeFile(join(localDir, "a", "b", "c", "deep.html"), "deep", "utf-8");

    const result = await writeFiles({
      planId: plan.planId,
      files: [{ path: "dest/deep.html", localPath: "a/b/c/deep.html" }],
    });
    expect(result.writtenPaths).toEqual(["dest/deep.html"]);
  });

  it("AC7 — rejects a file with neither localPath nor data", async () => {
    const plan = await createPlan("k", ["*.html"], [], localDir);

    await expect(
      writeFiles({ planId: plan.planId, files: [{ path: "a.html" }] }),
    ).rejects.toMatchObject({ code: "InvalidFileInputError", path: "a.html" });
  });

  it("AC7 — rejects a file with BOTH localPath and data set", async () => {
    const plan = await createPlan("k", ["*.html"], [], localDir);
    await writeFile(join(localDir, "src.html"), "from disk", "utf-8");

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "a.html", localPath: "src.html", data: "inline" }],
      }),
    ).rejects.toMatchObject({ code: "InvalidFileInputError", path: "a.html" });
  });

  it("rejects invalid base64 data when encoding: base64 is declared", async () => {
    const plan = await createPlan("k", ["*.bin"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "a.bin", data: "not valid base64!!!", encoding: "base64" }],
      }),
    ).rejects.toMatchObject({ code: "InvalidEncodingError" });
  });

  it("AC9 — rejects a payload exceeding the configured byte cap with PayloadTooLargeError", async () => {
    const plan = await createPlan("k", ["*.txt"], [], localDir);
    const big = "x".repeat(1000);

    await expect(
      writeFiles(
        { planId: plan.planId, files: [{ path: "a.txt", data: big }] },
        { GENIE_WRITE_BYTE_CAP: "500" },
      ),
    ).rejects.toMatchObject({
      code: "PayloadTooLargeError",
      totalBytes: 1000,
      maxBytes: 500,
      retryMaxFiles: 1,
    });

    // Nothing landed.
    await expect(stat(join(localDir, "a.txt"))).rejects.toThrow();
  });

  it("AC9 — retryMaxFiles halves the file count from the failing call", async () => {
    const plan = await createPlan("k", ["*.txt"], [], localDir);
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.txt`,
      data: "x".repeat(100),
    }));

    await expect(
      writeFiles({ planId: plan.planId, files }, { GENIE_WRITE_BYTE_CAP: "500" }),
    ).rejects.toMatchObject({ code: "PayloadTooLargeError", retryMaxFiles: 5 });
  });

  it("defaults the byte cap to 16 MiB when GENIE_WRITE_BYTE_CAP is unset", async () => {
    expect(DEFAULT_WRITE_BYTE_CAP).toBe(16 * 1024 * 1024);
  });

  it("sums localPath file sizes toward the byte cap without loading them into memory", async () => {
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    await writeFile(join(localDir, "big.txt"), "y".repeat(1000), "utf-8");

    await expect(
      writeFiles(
        { planId: plan.planId, files: [{ path: "dest/big.txt", localPath: "big.txt" }] },
        { GENIE_WRITE_BYTE_CAP: "500" },
      ),
    ).rejects.toMatchObject({ code: "PayloadTooLargeError", totalBytes: 1000 });
  });

  it("AC10 — rolls back the whole call if one file fails to commit, restoring the pre-existing file", async () => {
    if (platform() === "win32") return; // permission-based fault injection is POSIX-only
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    // "dest/existing.html" already has content the failed call must not disturb.
    await mkdir(join(localDir, "dest"), { recursive: true });
    await writeFile(join(localDir, "dest", "existing.html"), "original content", "utf-8");

    // Make the destination directory for the SECOND file read-only, so its
    // commit-phase rename fails after the first file already renamed clean.
    const lockedDir = join(localDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    try {
      await expect(
        writeFiles({
          planId: plan.planId,
          files: [
            { path: "dest/existing.html", data: "new content" }, // would succeed alone
            { path: "dest/locked/blocked.html", data: "unreachable" }, // fails: read-only dir
          ],
        }),
      ).rejects.toMatchObject({ code: "WriteFailedError" });
    } finally {
      await chmod(lockedDir, 0o755); // restore so afterEach can clean up
    }

    // Rollback: the pre-existing file must be back to its ORIGINAL content,
    // not the new content from the failed call.
    await expect(readFile(join(localDir, "dest", "existing.html"), "utf-8")).resolves.toBe(
      "original content",
    );
    // The blocked file must not exist.
    await expect(stat(join(localDir, "dest", "locked", "blocked.html"))).rejects.toThrow();
  });

  it("AC10 — rolls back cleanly when NONE of the destinations pre-existed", async () => {
    if (platform() === "win32") return;
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    const lockedDir = join(localDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    try {
      await expect(
        writeFiles({
          planId: plan.planId,
          files: [
            { path: "dest/fresh.html", data: "new" },
            { path: "dest/locked/blocked.html", data: "unreachable" },
          ],
        }),
      ).rejects.toMatchObject({ code: "WriteFailedError" });
    } finally {
      await chmod(lockedDir, 0o755);
    }

    // Nothing from this call should have landed.
    await expect(stat(join(localDir, "dest", "fresh.html"))).rejects.toThrow();
  });

  it("AC10 — refuses to overwrite a destination that already exists as a directory (Copilot review finding)", async () => {
    // Regression guard: `rename()` doesn't distinguish files from
    // directories — without an explicit guard, this call would have renamed
    // the pre-existing "dest/existing" directory into the backup slot, then
    // renamed a FILE into its place. Since the call would otherwise succeed,
    // the backup (containing the original directory) gets deleted by the
    // caller's cleanup — silently destroying the directory and its contents.
    const plan = await createPlan("k", ["dest/**"], [], localDir);
    const existingDir = join(localDir, "dest", "existing");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "precious.txt"), "do not delete me", "utf-8");

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "dest/existing", data: "this should never land" }],
      }),
    ).rejects.toMatchObject({ code: "WriteFailedError" });

    // The directory and its contents must be completely untouched.
    const stats = await stat(existingDir);
    expect(stats.isDirectory()).toBe(true);
    await expect(readFile(join(existingDir, "precious.txt"), "utf-8")).resolves.toBe(
      "do not delete me",
    );
  });

  it("does not mutate the destination tree at all when plan/schema validation fails before staging", async () => {
    const plan = await createPlan("k", ["components/**"], [], localDir);

    await expect(
      writeFiles({
        planId: plan.planId,
        files: [{ path: "outside/nope.html", data: "x" }],
      }),
    ).rejects.toThrow();

    const entries = await readdir(localDir);
    expect(entries).toEqual([]);
  });
});

// ─── MCP wire-level tests (tool registration + JSON error shapes) ───────────

interface WireHarness {
  client: Client;
  localDir: string;
  genieHome: string;
  close: () => Promise<void>;
}

async function makeWireHarness(): Promise<WireHarness> {
  const genieHome = await tempDir("genie-wf-wire-home-");
  process.env["GENIE_HOME"] = genieHome;
  const localDir = await tempDir("genie-wf-wire-local-");
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerPlan(server);
  registerWriteFilesTool(server);

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    localDir,
    genieHome,
    close: async () => {
      await client.close();
      delete process.env["GENIE_HOME"];
      await rm(localDir, { recursive: true, force: true });
      await rm(genieHome, { recursive: true, force: true });
    },
  };
}

function firstTextOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]?.text ?? "";
}

describe("mcp__genie__write_files tool (MCP wire level)", () => {
  let h: WireHarness;

  beforeEach(async () => {
    h = await makeWireHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("AC1 — is registered under the name mcp__genie__write_files", async () => {
    expect(WRITE_FILES_TOOL_NAME).toBe("mcp__genie__write_files");
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp__genie__write_files");
  });

  it("AC8 — end-to-end: plan then write_files returns writtenPaths in order", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: "k", writes: ["*.html"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };

    const writeResult = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: {
        planId,
        files: [
          { path: "a.html", data: "A" },
          { path: "b.html", data: "B" },
        ],
      },
    });

    expect(writeResult.isError).toBeFalsy();
    expect(writeResult.structuredContent).toEqual({ writtenPaths: ["a.html", "b.html"] });
    await expect(readFile(join(h.localDir, "a.html"), "utf-8")).resolves.toBe("A");
    await expect(readFile(join(h.localDir, "b.html"), "utf-8")).resolves.toBe("B");
  });

  it("AC5 — an unknown planId returns a structured PlanNotFoundError, not a thrown protocol error", async () => {
    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: {
        planId: "00000000-0000-4000-8000-000000000000",
        files: [{ path: "a.html", data: "x" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(firstTextOf(result)).toContain("PlanNotFoundError");
  });

  it("AC4 — a path outside the plan surfaces PathOutsidePlanError with the offending path", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: "k", writes: ["components/**"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };

    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: { planId, files: [{ path: "outside/x.html", data: "x" }] },
    });
    expect(result.isError).toBe(true);
    const text = firstTextOf(result);
    expect(text).toContain("PathOutsidePlanError");
    expect(text).toContain("outside/x.html");
  });

  it("AC9 — payload-too-large surfaces code -32099 with retryWith.maxFiles in data", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: "k", writes: ["*.txt"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };

    // write_files reads GENIE_WRITE_BYTE_CAP from process.env by default; the
    // wire-level handler doesn't accept an env override, so exercise this
    // path against the real env var for the duration of the call.
    const prev = process.env["GENIE_WRITE_BYTE_CAP"];
    process.env["GENIE_WRITE_BYTE_CAP"] = "10";
    try {
      const result = await h.client.callTool({
        name: WRITE_FILES_TOOL_NAME,
        arguments: { planId, files: [{ path: "big.txt", data: "x".repeat(100) }] },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(firstTextOf(result));
      expect(parsed.code).toBe(-32099);
      expect(parsed.data.retryWith).toEqual({ maxFiles: 1 });
    } finally {
      if (prev === undefined) delete process.env["GENIE_WRITE_BYTE_CAP"];
      else process.env["GENIE_WRITE_BYTE_CAP"] = prev;
    }
  });

  it("AC3 — more than 256 files surfaces TooManyFilesError", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: "k", writes: ["*.html"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };
    const files = Array.from({ length: MAX_FILES_PER_CALL + 1 }, (_, i) => ({
      path: `f${i}.html`,
      data: "x",
    }));

    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: { planId, files },
    });
    expect(result.isError).toBe(true);
    expect(firstTextOf(result)).toContain("TooManyFilesError");
  });
});
