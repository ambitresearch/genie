import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir, platform } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createPlan, PlanNotFoundError } from "../plans/index.js";
import { LocalFsKitStore } from "../store/local.js";
import { type KitStore } from "../store/interface.js";
import { seedKit } from "../../test/helpers/seed-kit.js";
import { deleteFiles } from "./delete_files.js";
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

// The kitId every plan in this suite is created against. The destination of a
// write is the KIT (DRO-565 re-plumb) — `<kitsRoot>/<KIT_ID>/…` — while
// `localDir` remains only the SOURCE base a `localPath` is read from.
//
// The wire-level tests route through the `plan` tool, which since #252 requires
// the kit to RESOLVE in the store, so `makeWireHarness` seeds a kit under this
// id. That is an existence requirement, not a shape one: `plan` gates on the
// store's `isSafeKitId` (any non-empty, non-traversing id), deliberately NOT on
// the narrower create_kit-shaped `KIT_ID_PATTERN`. The core-logic tests below
// call `createPlan` directly, beneath the tool layer, so they are unaffected.
const KIT_ID = "wf-kit";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("writeFiles (core logic)", () => {
  let localDir: string; // localPath SOURCE base
  let kitsRoot: string; // where kits live
  let kitDir: string; // write DESTINATION base = <kitsRoot>/<KIT_ID>
  let store: KitStore;
  let genieHome: string;

  beforeEach(async () => {
    localDir = await tempDir("genie-wf-local-");
    kitsRoot = await tempDir("genie-wf-kits-");
    kitDir = join(kitsRoot, KIT_ID);
    store = new LocalFsKitStore(kitsRoot);
    // `plans/index.ts` persists every plan to `${GENIE_HOME}/plans/...` and
    // reads GENIE_HOME fresh on every call (see createPlan/plan.test.ts's own
    // isolation pattern) — scope it to a fresh temp dir per test so this
    // suite never touches the real `<cwd>/.genie/plans/`.
    genieHome = await tempDir("genie-wf-home-");
    process.env["GENIE_HOME"] = genieHome;
    // #269 — the kit must exist before `write_files` will commit into it. These
    // core tests call `createPlan` directly (beneath the tool layer, see the
    // file header), so they bypass the #252 plan-time `getKit` gate that every
    // production caller passes through — `plan.ts:216` is `createPlan`'s ONLY
    // production caller and it has been kit-gated since #252. Before #269 these
    // tests leaned on `LocalFsKitStore.writeFiles`' `ensureDir` to conjure the
    // kit dir; that implicit creation is exactly the bug #269 fixes, so the
    // fixture now seeds the kit explicitly instead. See `seedKit` for why this
    // is not `store.createKit`.
    await seedKit(kitsRoot, KIT_ID, "Write Files Kit");
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(localDir, { recursive: true, force: true });
    await rm(kitsRoot, { recursive: true, force: true });
    await rm(genieHome, { recursive: true, force: true });
  });

  it("AC8 — happy path: writes files from data and returns writtenPaths in input order", async () => {
    const plan = await createPlan(KIT_ID, ["components/**/*.html", "tokens.css"], [], localDir);

    const result = await writeFiles(store, {
      planId: plan.planId,
      files: [
        { path: "components/Button.html", data: "<button>Hi</button>" },
        { path: "tokens.css", data: ":root { --c: red; }" },
      ],
    });

    expect(result.writtenPaths).toEqual(["components/Button.html", "tokens.css"]);
    // Destination is the KIT, not localDir.
    await expect(readFile(join(kitDir, "components", "Button.html"), "utf-8")).resolves.toBe(
      "<button>Hi</button>",
    );
    await expect(readFile(join(kitDir, "tokens.css"), "utf-8")).resolves.toBe(
      ":root { --c: red; }",
    );
  });

  it("writes files from localPath (source), resolved against the plan's localDir", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    // localPath is read from localDir (the SOURCE base)…
    await mkdir(join(localDir, "src"), { recursive: true });
    await writeFile(join(localDir, "src", "input.html"), "<div>from disk</div>", "utf-8");

    const result = await writeFiles(store, {
      planId: plan.planId,
      files: [{ path: "dest/input.html", localPath: "src/input.html" }],
    });

    expect(result.writtenPaths).toEqual(["dest/input.html"]);
    // …and written to the KIT (the destination).
    await expect(readFile(join(kitDir, "dest", "input.html"), "utf-8")).resolves.toBe(
      "<div>from disk</div>",
    );
  });

  it("writes base64-encoded inline data, decoded correctly", async () => {
    const plan = await createPlan(KIT_ID, ["*.bin"], [], localDir);
    const base64 = Buffer.from("hello world", "utf-8").toString("base64");

    await writeFiles(store, {
      planId: plan.planId,
      files: [{ path: "greeting.bin", data: base64, encoding: "base64" }],
    });

    await expect(readFile(join(kitDir, "greeting.bin"), "utf-8")).resolves.toBe("hello world");
  });

  it("AC5 — rejects an unknown planId with PlanNotFoundError", async () => {
    await expect(
      writeFiles(store, {
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
      const plan = await createPlan(KIT_ID, ["a.html"], [], localDir);
      await new Promise((r) => setTimeout(r, 150));

      await expect(
        writeFiles(store, { planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
      ).rejects.toBeInstanceOf(PlanNotFoundError);
    } finally {
      delete process.env["GENIE_PLAN_TTL"];
    }
  });

  it("AC3 — rejects more than 256 files with TooManyFilesError", async () => {
    const plan = await createPlan(KIT_ID, ["*.html"], [], localDir);
    const files = Array.from({ length: MAX_FILES_PER_CALL + 1 }, (_, i) => ({
      path: `f${i}.html`,
      data: "x",
    }));

    await expect(writeFiles(store, { planId: plan.planId, files })).rejects.toMatchObject({
      code: "TooManyFilesError",
      count: MAX_FILES_PER_CALL + 1,
      max: MAX_FILES_PER_CALL,
    });
  });

  it("accepts exactly 256 files (boundary)", async () => {
    const plan = await createPlan(KIT_ID, ["*.html"], [], localDir);
    const files = Array.from({ length: MAX_FILES_PER_CALL }, (_, i) => ({
      path: `f${i}.html`,
      data: "x",
    }));

    const result = await writeFiles(store, { planId: plan.planId, files });
    expect(result.writtenPaths).toHaveLength(MAX_FILES_PER_CALL);
  });

  it("rejects a call with two files targeting the same path with DuplicatePathError (Copilot review finding)", async () => {
    // Regression guard: without this check, the WriteOp for the first entry
    // would be silently superseded by the second's, and writtenPaths would list
    // the same path twice as if two distinct files had committed — when in fact
    // only one, whichever committed last, actually landed.
    const plan = await createPlan(KIT_ID, ["*.txt"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [
          { path: "a.txt", data: "first" },
          { path: "a.txt", data: "second" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DuplicatePathError", path: "a.txt" });

    // Nothing lands — rejected before any staging begins.
    await expect(stat(join(kitDir, "a.txt"))).rejects.toThrow();
  });

  it("rejects duplicate paths even when sourced differently (data vs. localPath)", async () => {
    const plan = await createPlan(KIT_ID, ["*.txt"], [], localDir);
    await writeFile(join(localDir, "src.txt"), "from disk", "utf-8");

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [
          { path: "a.txt", data: "inline" },
          { path: "a.txt", localPath: "src.txt" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DuplicatePathError", path: "a.txt" });
  });

  it("AC4 — rejects a path outside the plan's writes with PathOutsidePlanError (reason: glob)", async () => {
    const plan = await createPlan(KIT_ID, ["components/**"], [], localDir);

    await expect(
      writeFiles(store, {
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
    const plan = await createPlan(KIT_ID, ["components/**"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [
          { path: "components/Good.html", data: "ok" },
          { path: "outside/Bad.html", data: "nope" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    await expect(stat(join(kitDir, "components", "Good.html"))).rejects.toThrow();
  });

  it("AC4 — rejects an absolute path that matches a permissive glob but escapes the kit (Copilot review finding)", async () => {
    // Regression guard: a glob match alone does not guarantee containment.
    // "**" matches the literal string "/etc/passwd" under micromatch (an
    // absolute path is still just a string to the glob matcher), so without the
    // kit-relative containment check this call would have written outside the
    // kit entirely, ignoring the plan's containment guarantee.
    const plan = await createPlan(KIT_ID, ["**"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "/etc/passwd-genie-test-should-not-write", data: "pwned" }],
      }),
    ).rejects.toMatchObject({
      // reason: "escapesLocalDir" (not "glob") — the error message previously
      // always claimed a glob mismatch even when the true cause was the
      // containment check; this path DOES match the "**" glob, so a plain
      // glob-mismatch message would be actively misleading. (The reason code is
      // kept verbatim from the pre-store-replumb contract even though the
      // destination is now the kit — the semantics "escaped the write-scope"
      // are the same.)
      code: "PathOutsidePlanError",
      reason: "escapesLocalDir",
    });

    await expect(stat("/etc/passwd-genie-test-should-not-write")).rejects.toThrow();
  });

  it("AC4 — rejects a path containing a parent-traversal segment even under a permissive glob", async () => {
    // Belt-and-suspenders: micromatch's own semantics already reject "../x"
    // against "**", but the kit-relative containment check rejects any `..`
    // segment explicitly so a future glob-library swap can't silently reopen it.
    const plan = await createPlan(KIT_ID, ["**"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "../escaped.html", data: "x" }],
      }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });
  });

  it("AC6 — rejects a localPath that escapes the plan's localDir (parent traversal)", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    // A sibling directory outside localDir with a file we must not be able to read.
    const secretsDir = await tempDir("genie-wf-secret-");
    await writeFile(join(secretsDir, "secret.txt"), "top secret", "utf-8");
    // basename() is separator-agnostic (unlike a raw `.split("/")`, which
    // would silently misparse a Windows-style path), matching this file's
    // and the codebase's established containment-helper conventions.
    const escapePath = join("..", basename(secretsDir), "secret.txt");

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "dest/leak.txt", localPath: escapePath }],
      }),
    ).rejects.toMatchObject({ code: "LocalPathEscapeError" });

    await rm(secretsDir, { recursive: true, force: true });
  });

  it("AC6 — rejects an absolute localPath outside localDir", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "dest/leak.txt", localPath: "/etc/hostname" }],
      }),
    ).rejects.toMatchObject({ code: "LocalPathEscapeError" });
  });

  it("AC6 — accepts a localPath inside a nested subdirectory of localDir", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    await mkdir(join(localDir, "a", "b", "c"), { recursive: true });
    await writeFile(join(localDir, "a", "b", "c", "deep.html"), "deep", "utf-8");

    const result = await writeFiles(store, {
      planId: plan.planId,
      files: [{ path: "dest/deep.html", localPath: "a/b/c/deep.html" }],
    });
    expect(result.writtenPaths).toEqual(["dest/deep.html"]);
  });

  it("AC7 — rejects a file with neither localPath nor data", async () => {
    const plan = await createPlan(KIT_ID, ["*.html"], [], localDir);

    await expect(
      writeFiles(store, { planId: plan.planId, files: [{ path: "a.html" }] }),
    ).rejects.toMatchObject({ code: "InvalidFileInputError", path: "a.html" });
  });

  it("AC7 — rejects a file with BOTH localPath and data set", async () => {
    const plan = await createPlan(KIT_ID, ["*.html"], [], localDir);
    await writeFile(join(localDir, "src.html"), "from disk", "utf-8");

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "a.html", localPath: "src.html", data: "inline" }],
      }),
    ).rejects.toMatchObject({ code: "InvalidFileInputError", path: "a.html" });
  });

  it("rejects invalid base64 data when encoding: base64 is declared", async () => {
    const plan = await createPlan(KIT_ID, ["*.bin"], [], localDir);

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "a.bin", data: "not valid base64!!!", encoding: "base64" }],
      }),
    ).rejects.toMatchObject({ code: "InvalidEncodingError" });
  });

  it("AC9 — rejects a payload exceeding the configured byte cap with PayloadTooLargeError", async () => {
    const plan = await createPlan(KIT_ID, ["*.txt"], [], localDir);
    const big = "x".repeat(1000);

    await expect(
      writeFiles(
        store,
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
    await expect(stat(join(kitDir, "a.txt"))).rejects.toThrow();
  });

  it("AC9 — retryMaxFiles halves the file count from the failing call", async () => {
    const plan = await createPlan(KIT_ID, ["*.txt"], [], localDir);
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.txt`,
      data: "x".repeat(100),
    }));

    await expect(
      writeFiles(store, { planId: plan.planId, files }, { GENIE_WRITE_BYTE_CAP: "500" }),
    ).rejects.toMatchObject({ code: "PayloadTooLargeError", retryMaxFiles: 5 });
  });

  it("defaults the byte cap to 16 MiB when GENIE_WRITE_BYTE_CAP is unset", async () => {
    expect(DEFAULT_WRITE_BYTE_CAP).toBe(16 * 1024 * 1024);
  });

  it("sums localPath file sizes toward the byte cap without loading them into memory", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    await writeFile(join(localDir, "big.txt"), "y".repeat(1000), "utf-8");

    await expect(
      writeFiles(
        store,
        { planId: plan.planId, files: [{ path: "dest/big.txt", localPath: "big.txt" }] },
        { GENIE_WRITE_BYTE_CAP: "500" },
      ),
    ).rejects.toMatchObject({ code: "PayloadTooLargeError", totalBytes: 1000 });
  });

  it("AC10 — rolls back the whole call if one file fails to commit, restoring the pre-existing file", async () => {
    if (platform() === "win32") return; // permission-based fault injection is POSIX-only
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    // "dest/existing.html" already exists IN THE KIT with content the failed
    // call must not disturb.
    await mkdir(join(kitDir, "dest"), { recursive: true });
    await writeFile(join(kitDir, "dest", "existing.html"), "original content", "utf-8");

    // Make the destination directory for the SECOND file read-only, so its
    // commit-phase rename fails after the first file already renamed clean.
    const lockedDir = join(kitDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    try {
      await expect(
        writeFiles(store, {
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
    await expect(readFile(join(kitDir, "dest", "existing.html"), "utf-8")).resolves.toBe(
      "original content",
    );
    // The blocked file must not exist.
    await expect(stat(join(kitDir, "dest", "locked", "blocked.html"))).rejects.toThrow();
  });

  it("AC10 — rolls back cleanly when NONE of the destinations pre-existed", async () => {
    if (platform() === "win32") return;
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    const lockedDir = join(kitDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    try {
      await expect(
        writeFiles(store, {
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
    await expect(stat(join(kitDir, "dest", "fresh.html"))).rejects.toThrow();
  });

  it("AC10 — refuses to overwrite a destination that already exists as a directory (Copilot review finding)", async () => {
    // Regression guard: `rename()` doesn't distinguish files from
    // directories — without an explicit guard, this call would have renamed
    // the pre-existing "dest/existing" directory into the backup slot, then
    // renamed a FILE into its place. Since the call would otherwise succeed,
    // the backup (containing the original directory) gets deleted by the
    // caller's cleanup — silently destroying the directory and its contents.
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    const existingDir = join(kitDir, "dest", "existing");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "precious.txt"), "do not delete me", "utf-8");

    await expect(
      writeFiles(store, {
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

  it("does not mutate the kit at all when plan/schema validation fails before staging", async () => {
    const plan = await createPlan(KIT_ID, ["components/**"], [], localDir);
    // Snapshot rather than hardcode: the fixture seeds `.kit.json` and this
    // test's invariant is "the write changed nothing", not "the kit contains
    // exactly these files".
    const before = (await readdir(kitDir)).sort();

    await expect(
      writeFiles(store, {
        planId: plan.planId,
        files: [{ path: "outside/nope.html", data: "x" }],
      }),
    ).rejects.toThrow();

    // Nothing was staged. Pre-#269 this asserted the kit dir did not exist at
    // all — it only ever came into being via the `ensureDir` that #269 removes
    // reliance on. The kit is now seeded up front (see beforeEach), so the
    // equivalent assertion is that its contents are byte-for-byte unchanged.
    expect((await readdir(kitDir)).sort()).toEqual(before);
    expect(before).not.toContain("outside");
  });
});

// ─── MCP wire-level tests (tool registration + JSON error shapes) ───────────

interface WireHarness {
  client: Client;
  localDir: string;
  kitsRoot: string;
  kitDir: string;
  genieHome: string;
  close: () => Promise<void>;
}

async function makeWireHarness(): Promise<WireHarness> {
  const genieHome = await tempDir("genie-wf-wire-home-");
  process.env["GENIE_HOME"] = genieHome;
  const localDir = await tempDir("genie-wf-wire-local-");
  const kitsRoot = await tempDir("genie-wf-wire-kits-");
  const kitDir = join(kitsRoot, KIT_ID);
  const kitStore = new LocalFsKitStore(kitsRoot);
  // `plan` now resolves the kit before issuing a planId (#252), so the wire
  // harness seeds a real kit in the same store the plan tool validates against.
  await kitStore.createKit("Write Files Wire Kit", KIT_ID);
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerPlan(server, kitStore);
  registerWriteFilesTool(server, kitStore);

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    localDir,
    kitsRoot,
    kitDir,
    genieHome,
    close: async () => {
      await client.close();
      delete process.env["GENIE_HOME"];
      await rm(localDir, { recursive: true, force: true });
      await rm(kitsRoot, { recursive: true, force: true });
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
      arguments: { kitId: KIT_ID, writes: ["*.html"], localDir: h.localDir },
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
    // Files landed in the KIT (destination), not localDir (source base).
    await expect(readFile(join(h.kitDir, "a.html"), "utf-8")).resolves.toBe("A");
    await expect(readFile(join(h.kitDir, "b.html"), "utf-8")).resolves.toBe("B");
  });

  it("AC5 — an unknown planId returns a canonical -32602 plan-guard rejection (M1-13)", async () => {
    // Post-M1-13 the plan-guard middleware (packages/server/src/middleware/
    // plan-guard.ts) owns the planId-not-found rejection, and normalises the
    // response to a JSON-RPC-shaped `{ code: -32602, message, data: { reason,
    // planId } }` payload. This test asserts the middleware envelope rather
    // than the old code-name-string ("PlanNotFoundError") — that path is
    // now unreachable at the wire level (see the belt-and-suspenders branch
    // in write_files.ts) and would only surface for a direct in-process
    // caller, which the core-logic suite above covers.
    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: {
        planId: "00000000-0000-4000-8000-000000000000",
        files: [{ path: "a.html", data: "x" }],
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstTextOf(result));
    expect(parsed.code).toBe(-32602);
    expect(parsed.data.reason).toBe("planNotFound");
    expect(parsed.data.planId).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("AC4 — a path outside the plan surfaces a -32602 plan-guard rejection with the offending path (M1-13)", async () => {
    // Same rationale as the AC5 test above: the M1-13 middleware normalises
    // this response, so the assertion targets the canonical envelope's
    // `data.reason` + `data.path` rather than the old code-name string.
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: KIT_ID, writes: ["components/**"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };

    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: { planId, files: [{ path: "outside/x.html", data: "x" }] },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstTextOf(result));
    expect(parsed.code).toBe(-32602);
    expect(parsed.data.reason).toBe("pathOutsidePlan");
    expect(parsed.data.path).toBe("outside/x.html");
  });

  it("AC9 — payload-too-large surfaces code -32099 with retryWith.maxFiles in data", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: KIT_ID, writes: ["*.txt"], localDir: h.localDir },
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
      arguments: { kitId: KIT_ID, writes: ["*.html"], localDir: h.localDir },
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

// ─── #269: the kit must still exist at COMMIT time (TOCTOU re-check) ────────

/**
 * #252 made `plan` reject a kitId that does not resolve — but that is a
 * point-in-time guarantee, checked once when the plan is issued. Plans live for
 * `DEFAULT_PLAN_TTL` (1 h), and `LocalFsKitStore.writeFiles` calls
 * `ensureDir(kitDir)` by design, so before this fix a kit deleted inside that
 * window was silently RE-CREATED by the write.
 *
 * These tests pin the commit-time re-check that closes the window, and — just as
 * importantly — lock in the two behaviours the fix must NOT change: the
 * brand-new-kit `ensureDir` case, and `delete_files`' idempotent no-op.
 */
describe("write_files re-checks the kit at commit time (#269)", () => {
  const TOCTOU_KIT_ID = "wf-toctou-kit";
  let localDir: string;
  let kitsRoot: string;
  let kitDir: string;
  let store: LocalFsKitStore;
  let genieHome: string;

  beforeEach(async () => {
    localDir = await tempDir("genie-wf-toctou-local-");
    kitsRoot = await tempDir("genie-wf-toctou-kits-");
    kitDir = join(kitsRoot, TOCTOU_KIT_ID);
    store = new LocalFsKitStore(kitsRoot);
    genieHome = await tempDir("genie-wf-toctou-home-");
    process.env["GENIE_HOME"] = genieHome;
    // A plan can only exist for a kit that resolved — `plan.ts:216` is the only
    // production caller of `createPlan`, and since #252 it is `getKit`-gated. So
    // seeding a real kit is what production always does, not test convenience.
    await seedKit(kitsRoot, TOCTOU_KIT_ID, "TOCTOU Kit");
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(localDir, { recursive: true, force: true });
    await rm(kitsRoot, { recursive: true, force: true });
    await rm(genieHome, { recursive: true, force: true });
  });

  it("rejects the write when the kit was deleted after the plan was issued", async () => {
    const plan = await createPlan(TOCTOU_KIT_ID, ["**"], [], localDir);
    // The out-of-band deletion the issue describes: a user `rm -rf`, an external
    // sync, or a shared GENIE_HOME. There is no `delete_kit` MCP tool, which is
    // exactly why this is a narrow gap rather than an agent-reachable one.
    await rm(kitDir, { recursive: true, force: true });

    await expect(
      writeFiles(store, { planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
    ).rejects.toMatchObject({ code: "KitNotFoundError", kitId: TOCTOU_KIT_ID });
  });

  it("does not re-create the deleted kit directory (the 'writes anyway' half of the bug)", async () => {
    const plan = await createPlan(TOCTOU_KIT_ID, ["**"], [], localDir);
    await rm(kitDir, { recursive: true, force: true });

    await expect(
      writeFiles(store, { planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
    ).rejects.toThrow();

    // Nothing on disk: no resurrected kit dir, and therefore no written file.
    await expect(stat(kitDir)).rejects.toThrow();
  });

  it("🔒 still writes into a kit that exists (the ensureDir brand-new-kit case must not regress)", async () => {
    const plan = await createPlan(TOCTOU_KIT_ID, ["**"], [], localDir);

    const result = await writeFiles(store, {
      planId: plan.planId,
      files: [{ path: "components/Button.html", data: "<button>Hi</button>" }],
    });

    expect(result.writtenPaths).toEqual(["components/Button.html"]);
    await expect(readFile(join(kitDir, "components", "Button.html"), "utf-8")).resolves.toBe(
      "<button>Hi</button>",
    );
  });

  it("🔒 delete_files against a deleted kit still returns the idempotent no-op", async () => {
    // local.ts:606-619 documents "a missing kit is the same idempotent no-op as
    // a missing file … we do NOT pre-stat the kit dir." The asymmetry is the
    // point of #269: write RE-CREATES, delete does not. This proves the fix did
    // not leak into the delete path (and is why it cannot live in withPlanGuard).
    const plan = await createPlan(TOCTOU_KIT_ID, [], ["**"], localDir);
    await rm(kitDir, { recursive: true, force: true });

    const result = await deleteFiles(store, { planId: plan.planId, paths: ["a.html"] });

    expect(result.deletedPaths).toEqual([]);
    expect(result.notFoundPaths).toEqual(["a.html"]);
    await expect(stat(kitDir)).rejects.toThrow();
  });

  it("rejects a path-shaped plan.kitId before it reaches the store", async () => {
    // `delete_files.ts:161` already guards this "as the first destructive
    // consumer"; write_files had NO equivalent. It must run before the existence
    // check, because LocalFsKitStore.getKit resolves via `kitDir`, not
    // `safeKitDir` — so `getKit("..")` would itself read above the kits root.
    //
    // Asserting only the rejection would NOT test what this name claims: if the
    // two stages were reordered, `getKit("..")` would resolve above the kits
    // root, fail, and raise the very same KitNotFoundError — a green test over a
    // reopened traversal. Spying on getKit is what actually pins the ordering.
    const getKitSpy = vi.spyOn(store, "getKit");
    const plan = await createPlan("..", ["**"], [], localDir);

    await expect(
      writeFiles(store, { planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
    ).rejects.toMatchObject({ code: "KitNotFoundError", kitId: ".." });

    expect(getKitSpy).not.toHaveBeenCalled();
    getKitSpy.mockRestore();
  });

  it("re-throws a store fault instead of reporting it as a missing kit", async () => {
    // Fail-closed is not fail-silent. A genuine "no such kit" is a kitNotFound
    // rejection; an I/O or transport fault (EACCES, or a network error behind a
    // git-host store) must surface as ITSELF, so an operator can tell a deleted
    // kit apart from an unreadable disk. Widening the catch in step 9b to a bare
    // `catch` would silently tell users their kit was gone when the backend was
    // merely unreachable. Mirrors the plan-time lock in plan.test.ts.
    const boom = new Error("EACCES: permission denied, open '.kit.json'");
    const writeFilesSpy = vi.fn();
    const failingStore = {
      getKit: vi.fn(async () => {
        throw boom;
      }),
      writeFiles: writeFilesSpy,
    } as unknown as KitStore;

    const plan = await createPlan(TOCTOU_KIT_ID, ["**"], [], localDir);

    await expect(
      writeFiles(failingStore, { planId: plan.planId, files: [{ path: "a.html", data: "x" }] }),
    ).rejects.toBe(boom);

    // Crucially NOT mislabelled, and nothing committed.
    expect(writeFilesSpy).not.toHaveBeenCalled();
  });

  it("🔒 accepts a kit deleted and re-created under the same id (existence-only, by design)", async () => {
    // The issue's open question, answered in code rather than prose: the check is
    // existence-only, so a plan SURVIVES delete-and-recreate. The stronger
    // identity check (kit.createdAt > plan.createdAt) was rejected because
    // GitHostKitStore.getKit returns the git host's clock (`repo.created_at`)
    // while PlanState.createdAt is local — skew would intermittently false-reject
    // legitimate writes, a worse failure mode than the narrow gap it closes.
    const plan = await createPlan(TOCTOU_KIT_ID, ["**"], [], localDir);
    await rm(kitDir, { recursive: true, force: true });
    await seedKit(kitsRoot, TOCTOU_KIT_ID, "TOCTOU Kit Reborn");

    const result = await writeFiles(store, {
      planId: plan.planId,
      files: [{ path: "a.html", data: "x" }],
    });

    expect(result.writtenPaths).toEqual(["a.html"]);
  });
});

describe("mcp__genie__write_files kit re-check (MCP wire level, #269)", () => {
  let h: WireHarness;

  beforeEach(async () => {
    h = await makeWireHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("surfaces a canonical -32602 kitNotFound envelope, matching plan's (#252)", async () => {
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: KIT_ID, writes: ["*.html"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };

    await rm(h.kitDir, { recursive: true, force: true });

    const result = await h.client.callTool({
      name: WRITE_FILES_TOOL_NAME,
      arguments: { planId, files: [{ path: "a.html", data: "x" }] },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstTextOf(result));
    expect(parsed.code).toBe(-32602);
    expect(parsed.data.reason).toBe("kitNotFound");
    expect(parsed.data.kitId).toBe(KIT_ID);
    // And still nothing on disk.
    await expect(stat(h.kitDir)).rejects.toThrow();
  });

  it("emits a write_files.rejected audit line to stderr, not stdout", async () => {
    // On the stdio transport stdout *is* the JSON-RPC stream, so a stray line
    // there corrupts client framing. Mirrors plan.rejected from #252.
    const planResult = await h.client.callTool({
      name: PLAN_TOOL_NAME,
      arguments: { kitId: KIT_ID, writes: ["*.html"], localDir: h.localDir },
    });
    const { planId } = planResult.structuredContent as { planId: string };
    await rm(h.kitDir, { recursive: true, force: true });

    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    try {
      await h.client.callTool({
        name: WRITE_FILES_TOOL_NAME,
        arguments: { planId, files: [{ path: "a.html", data: "x" }] },
      });

      const auditLine = stderrLines.find((l) => l.includes("write_files.rejected"));
      expect(auditLine).toBeTruthy();
      expect(JSON.parse(auditLine as string)).toMatchObject({
        event: "write_files.rejected",
        reason: "kitNotFound",
        kitId: KIT_ID,
      });
      expect(stdoutLines.some((l) => l.includes("write_files.rejected"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
