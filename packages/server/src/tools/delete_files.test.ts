import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import {
  DELETE_FILES_TOOL_NAME,
  DeleteFilesError,
  deleteFiles,
  sortPathsLongestFirst,
} from "./delete_files.js";
import { createPlan, PlanNotFoundError } from "../plans/index.js";
import { LocalFsKitStore } from "../store/local.js";

const KIT_ID = "kit-test";

interface Harness {
  home: string;
  kitsRoot: string;
  kitDir: string;
  /** The injected kit backend the re-plumbed tool deletes through (DRO-540). */
  store: LocalFsKitStore;
}

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "genie-delfiles-"));
  process.env.GENIE_HOME = home;
  const kitsRoot = join(home, "kits");
  const kitDir = join(kitsRoot, KIT_ID);
  await mkdir(kitDir, { recursive: true });
  // The tool now deletes via KitStore.deleteFile; a LocalFsKitStore rooted at
  // kitsRoot resolves `<kitsRoot>/<kitId>/<path>` — exactly where `seed` writes.
  const store = new LocalFsKitStore(kitsRoot);
  return { home, kitsRoot, kitDir, store };
}

async function seed(kitDir: string, relPath: string, content = "x"): Promise<void> {
  const full = join(kitDir, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** Seed a plan whose `deletes` globs authorize the given patterns. */
async function seedPlan(deletes: string[]): Promise<string> {
  const state = await createPlan(KIT_ID, ["**/*"], deletes, process.cwd());
  return state.planId;
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await rm(harness.home, { recursive: true, force: true });
  delete process.env.GENIE_HOME;
});

// ────────────────────────────────────────────────────────────
// sortPathsLongestFirst — Implementation Note (delete files before dirs)
// ────────────────────────────────────────────────────────────

describe("sortPathsLongestFirst", () => {
  it("orders longer (deeper) paths before their prefixes", () => {
    expect(sortPathsLongestFirst(["a", "a/b/c.txt", "a/b"])).toEqual(["a/b/c.txt", "a/b", "a"]);
  });

  it("breaks length ties deterministically (localeCompare)", () => {
    expect(sortPathsLongestFirst(["bb", "aa"])).toEqual(["aa", "bb"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "a/b"];
    sortPathsLongestFirst(input);
    expect(input).toEqual(["a", "a/b"]);
  });
});

// ────────────────────────────────────────────────────────────
// deleteFiles — core behaviour (AC3–AC6)
// ────────────────────────────────────────────────────────────

describe("deleteFiles", () => {
  it("AC4 — deletes files matching the plan's deletes and returns them", async () => {
    await seed(harness.kitDir, "old/a.txt");
    await seed(harness.kitDir, "old/b.txt");
    const planId = await seedPlan(["old/*.txt"]);

    const result = await deleteFiles(harness.store, {
      planId,
      paths: ["old/a.txt", "old/b.txt"],
    });

    expect(result.deletedPaths.sort()).toEqual(["old/a.txt", "old/b.txt"]);
    expect(result.notFoundPaths).toEqual([]);
    expect(existsSync(join(harness.kitDir, "old/a.txt"))).toBe(false);
    expect(existsSync(join(harness.kitDir, "old/b.txt"))).toBe(false);
  });

  it("AC5 — a missing path is a non-error and lands in notFoundPaths (silent retry)", async () => {
    const planId = await seedPlan(["_preview/*.html"]);

    const result = await deleteFiles(harness.store, {
      planId,
      paths: ["_preview/Button.html"],
    });

    expect(result.deletedPaths).toEqual([]);
    expect(result.notFoundPaths).toEqual(["_preview/Button.html"]);
  });

  it("AC4/AC5 — mixed present + missing: only present ones are 'deleted'", async () => {
    await seed(harness.kitDir, "keep/present.txt");
    const planId = await seedPlan(["keep/*.txt"]);

    const result = await deleteFiles(harness.store, {
      planId,
      paths: ["keep/present.txt", "keep/absent.txt"],
    });

    expect(result.deletedPaths).toEqual(["keep/present.txt"]);
    expect(result.notFoundPaths).toEqual(["keep/absent.txt"]);
    expect(existsSync(join(harness.kitDir, "keep/present.txt"))).toBe(false);
  });

  it("AC3 — a path outside the plan's deletes throws PathOutsidePlanError and deletes nothing", async () => {
    await seed(harness.kitDir, "old/a.txt");
    await seed(harness.kitDir, "secret.txt");
    const planId = await seedPlan(["old/*.txt"]);

    await expect(
      deleteFiles(harness.store, { planId, paths: ["old/a.txt", "secret.txt"] }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    // Atomic pre-flight: the in-plan sibling must NOT have been deleted.
    expect(existsSync(join(harness.kitDir, "old/a.txt"))).toBe(true);
    expect(existsSync(join(harness.kitDir, "secret.txt"))).toBe(true);
  });

  it("AC3 — an empty deletes list authorizes no deletions", async () => {
    await seed(harness.kitDir, "a.txt");
    const planId = await seedPlan([]);

    await expect(
      deleteFiles(harness.store, { planId, paths: ["a.txt"] }),
    ).rejects.toBeInstanceOf(DeleteFilesError);
    expect(existsSync(join(harness.kitDir, "a.txt"))).toBe(true);
  });

  it("AC3 — path traversal is rejected as PathOutsidePlanError without touching disk", async () => {
    // A sentinel file OUTSIDE the kit that a traversal path could target.
    const sentinel = join(harness.kitsRoot, "sentinel.txt");
    await writeFile(sentinel, "do-not-delete", "utf8");
    const planId = await seedPlan(["**/*"]);

    await expect(
      deleteFiles(harness.store, { planId, paths: ["../sentinel.txt"] }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    expect(existsSync(sentinel)).toBe(true);
  });

  it("AC3 — a plan whose kitId escapes kitsRoot cannot delete outside the kit tree (defense in depth)", async () => {
    // `plan` accepts kitId: z.string().min(1) with NO traversal guard, and
    // createPlan stores it verbatim. A plan authored with a traversal kitId
    // (e.g. "..") resolves a kitRoot OUTSIDE kitsRoot; a path that is in-bounds
    // *relative to that escaped root* would then pass the per-path containment
    // check and unlink a file outside the kit tree. delete_files is the first
    // destructive consumer, so it must verify the resolved kitRoot stays within
    // kitsRoot before deleting anything.
    const outsideFile = join(harness.home, "outside-secret.txt");
    await writeFile(outsideFile, "do-not-delete", "utf8");

    // kitsRoot is `${home}/kits`; kitId ".." escapes to `${home}`, so
    // `outside-secret.txt` sits directly in the escaped kitRoot. The plan
    // authorizes deleting it by name.
    const state = await createPlan("..", ["**/*"], ["outside-secret.txt"], process.cwd());

    await expect(
      deleteFiles(harness.store, { planId: state.planId, paths: ["outside-secret.txt"] }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    // The file outside the kit tree must survive.
    expect(existsSync(outsideFile)).toBe(true);
  });

  it("AC3 — a dot-segment path is rejected before glob-match/resolve even when a glob would match it", async () => {
    // Plan gating checks the RAW string but deletion resolves it, so the two
    // views can disagree. A glob authored with a literal `..` segment
    // (`inside/../*.txt`) DOES micromatch-match `inside/../secret.txt`, which
    // resolves to `kitRoot/secret.txt` — inside kitRoot, so the containment
    // check alone would pass and unlink a file the plan never meant to name.
    // Rejecting any `.`/`..` segment up front closes that gap.
    await seed(harness.kitDir, "secret.txt");
    const planId = await seedPlan(["inside/../*.txt"]);

    await expect(
      deleteFiles(harness.store, { planId, paths: ["inside/../secret.txt"] }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    // The resolved-but-unauthorized file must survive untouched.
    expect(existsSync(join(harness.kitDir, "secret.txt"))).toBe(true);
  });

  it("AC3 — a `.` (current-dir) segment is rejected too", async () => {
    await seed(harness.kitDir, "a.txt");
    const planId = await seedPlan(["**/*"]);

    await expect(
      deleteFiles(harness.store, { planId, paths: ["./a.txt"] }),
    ).rejects.toMatchObject({ code: "PathOutsidePlanError" });

    expect(existsSync(join(harness.kitDir, "a.txt"))).toBe(true);
  });

  it("AC6 — a non-ENOENT failure (directory target) fails the whole call", async () => {
    // Directory delete is out of scope; unlink on a directory throws EISDIR/EPERM,
    // which must surface as a hard error rather than being swallowed as not-found.
    await mkdir(join(harness.kitDir, "adir"), { recursive: true });
    await seed(harness.kitDir, "adir/inner.txt");
    const planId = await seedPlan(["adir", "adir/*.txt"]);

    await expect(deleteFiles(harness.store, { planId, paths: ["adir"] })).rejects.toBeInstanceOf(
      DeleteFilesError,
    );
    expect(existsSync(join(harness.kitDir, "adir"))).toBe(true);
  });

  it("deletes deeper paths before their prefixes (longest-first)", async () => {
    await seed(harness.kitDir, "nested/deep/file.txt");
    await seed(harness.kitDir, "nested/deep/other.txt");
    const planId = await seedPlan(["nested/**/*.txt"]);

    const result = await deleteFiles(harness.store, {
      planId,
      paths: ["nested/deep/file.txt", "nested/deep/other.txt"],
    });

    expect(result.deletedPaths.length).toBe(2);
    expect(existsSync(join(harness.kitDir, "nested/deep/file.txt"))).toBe(false);
    expect(existsSync(join(harness.kitDir, "nested/deep/other.txt"))).toBe(false);
  });

  it("dedupes repeated paths so one file never appears in both result arrays", async () => {
    await seed(harness.kitDir, "dup.txt");
    const planId = await seedPlan(["dup.txt"]);

    const result = await deleteFiles(harness.store, {
      planId,
      paths: ["dup.txt", "dup.txt"],
    });

    expect(result.deletedPaths).toEqual(["dup.txt"]);
    expect(result.notFoundPaths).toEqual([]);
  });

  it("rejects an unknown / expired planId with PlanNotFoundError", async () => {
    await expect(
      deleteFiles(harness.store, {
        planId: "00000000-0000-0000-0000-000000000000",
        paths: ["a.txt"],
      }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it("rejects a malformed planId (AC2 shape) with InvalidArguments", async () => {
    await expect(
      deleteFiles(harness.store, { planId: "", paths: ["a.txt"] }),
    ).rejects.toMatchObject({ code: "InvalidArguments" });
  });

  it("rejects an empty paths array (AC2 shape) with InvalidArguments", async () => {
    const planId = await seedPlan(["*.txt"]);
    await expect(deleteFiles(harness.store, { planId, paths: [] })).rejects.toMatchObject({
      code: "InvalidArguments",
    });
  });
});

// ────────────────────────────────────────────────────────────
// deleteFiles via MCP (AC1, AC2, structuredContent + outputSchema)
// ────────────────────────────────────────────────────────────

describe("delete_files tool (via MCP)", () => {
  let client: Client;
  let kitsRoot: string;
  let kitDir: string;

  beforeEach(async () => {
    kitsRoot = harness.kitsRoot;
    kitDir = harness.kitDir;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ kitsRoot });
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("AC1 — registers mcp__genie__delete_files and advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === DELETE_FILES_TOOL_NAME);
    expect(DELETE_FILES_TOOL_NAME).toBe("mcp__genie__delete_files");
    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["deletedPaths"],
    });
  });

  it("AC2/AC4/AC5 — deletes in-plan files and returns structuredContent", async () => {
    await seed(kitDir, "old/a.txt");
    const planId = await seedPlan(["old/*.txt"]);

    const result = await client.callTool({
      name: DELETE_FILES_TOOL_NAME,
      arguments: { planId, paths: ["old/a.txt", "old/missing.txt"] },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      deletedPaths: ["old/a.txt"],
      notFoundPaths: ["old/missing.txt"],
    });
    expect(existsSync(join(kitDir, "old/a.txt"))).toBe(false);
  });

  it("AC3 — an out-of-plan path yields isError with a PathOutsidePlanError payload", async () => {
    await seed(kitDir, "secret.txt");
    const planId = await seedPlan(["old/*.txt"]);

    const result = await client.callTool({
      name: DELETE_FILES_TOOL_NAME,
      arguments: { planId, paths: ["secret.txt"] },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const payload = JSON.parse(text) as { error: string; path?: string };
    expect(payload.error).toBe("PathOutsidePlanError");
    expect(existsSync(join(kitDir, "secret.txt"))).toBe(true);
  });
});
