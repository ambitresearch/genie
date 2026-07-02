import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../server.js";
import {
  createPlan,
  validateGlobPatterns,
  TooManyWritesError,
  TooComplexGlobError,
  MAX_WRITES,
  MAX_WILDCARDS,
  getPlan,
  pruneExpiredPlans,
  PlanNotFoundError,
  pathMatchesGlobs,
  isPathInsideLocalDir,
} from "../plans/index.js";

// ────────────────────────────────────────────────────────────
// Unit tests — pure functions
// ────────────────────────────────────────────────────────────

describe("validateGlobPatterns", () => {
  it("accepts patterns with ≤3 wildcards", () => {
    expect(() => validateGlobPatterns(["*.js"])).not.toThrow();
    expect(() => validateGlobPatterns(["**/*.js"])).not.toThrow();
    expect(() => validateGlobPatterns(["src/**/*.ts"])).not.toThrow();
    expect(() => validateGlobPatterns(["a/*/b/*/c/*.js"])).not.toThrow();
  });

  it("rejects patterns with >3 wildcards", () => {
    expect(() => validateGlobPatterns(["a/*/b/*/c/*/d/*.js"])).toThrow(TooComplexGlobError);
    expect(() => validateGlobPatterns(["*/*/*/*/*"])).toThrow(TooComplexGlobError);
  });

  it("counts ** as one wildcard", () => {
    // This has 3 wildcards: **, *, *
    expect(() => validateGlobPatterns(["**/a/*/b/*.js"])).not.toThrow();
    // This has 4: **, *, *, *
    expect(() => validateGlobPatterns(["**/a/*/b/*/c/*.js"])).toThrow(TooComplexGlobError);
  });
});

describe("pathMatchesGlobs", () => {
  it("matches exact paths", () => {
    expect(pathMatchesGlobs("foo.js", ["foo.js"])).toBe(true);
    expect(pathMatchesGlobs("bar.js", ["foo.js"])).toBe(false);
  });

  it("matches wildcard patterns", () => {
    expect(pathMatchesGlobs("foo.js", ["*.js"])).toBe(true);
    expect(pathMatchesGlobs("foo.ts", ["*.js"])).toBe(false);
  });

  it("matches deep patterns with **", () => {
    expect(pathMatchesGlobs("src/components/Button.tsx", ["**/*.tsx"])).toBe(true);
    expect(pathMatchesGlobs("README.md", ["**/*.tsx"])).toBe(false);
  });

  it("matches dotfiles when dot: true is set", () => {
    expect(pathMatchesGlobs(".gitignore", [".*"])).toBe(true);
  });
});

describe("isPathInsideLocalDir", () => {
  it("returns true for paths inside localDir", () => {
    expect(isPathInsideLocalDir("/home/user/project/src/index.ts", "/home/user/project")).toBe(
      true,
    );
  });

  it("returns true for paths equal to localDir", () => {
    expect(isPathInsideLocalDir("/home/user/project", "/home/user/project")).toBe(true);
  });

  it("returns false for paths outside localDir", () => {
    expect(isPathInsideLocalDir("/etc/passwd", "/home/user/project")).toBe(false);
  });

  it("handles relative paths", () => {
    const cwd = process.cwd();
    expect(isPathInsideLocalDir("./foo.js", cwd)).toBe(true);
    expect(isPathInsideLocalDir("../outside.js", cwd)).toBe(false);
  });

  it("returns false for a sibling directory that shares localDir as a string prefix", () => {
    // Regression guard for the naive `startsWith(localDir)` bug: "/home/user/project-evil"
    // starts with the string "/home/user/project" but is NOT inside it.
    expect(isPathInsideLocalDir("/home/user/project-evil/file.js", "/home/user/project")).toBe(
      false,
    );
  });

  it("does not depend on a hard-coded POSIX separator (Windows-safe containment)", () => {
    // Regression guard: the original implementation checked
    // `resolvedPath.startsWith(resolvedLocalDir + "/")`, which never matches
    // on Windows where `path.resolve` joins with "\\". Using `path.relative`
    // (as asserted here) is separator-agnostic, matching the codebase's
    // established `safePath` pattern (store/local.ts, tools/read_file.ts).
    const cwd = process.cwd();
    const nested = join(cwd, "nested", "dir", "file.ts");
    expect(isPathInsideLocalDir(nested, cwd)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Plan state management tests
// ────────────────────────────────────────────────────────────

describe("createPlan", () => {
  let tempHome: string;

  beforeEach(async () => {
    // Scope GENIE_HOME to a temp dir for every test in this block — createPlan
    // persists to disk immediately, and without this, plan JSON files leak
    // into the real repo tree at `<cwd>/.genie/plans/` on every test run.
    tempHome = await mkdtemp(join(tmpdir(), "genie-plans-"));
    process.env.GENIE_HOME = tempHome;
    // Set a short TTL for testing
    process.env.GENIE_PLAN_TTL = "1000";
  });

  afterEach(async () => {
    delete process.env.GENIE_PLAN_TTL;
    delete process.env.GENIE_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("creates a plan with valid inputs", async () => {
    const state = await createPlan("kit-abc123", ["*.js", "**/*.ts"], ["*.tmp"], process.cwd());

    expect(state.planId).toBeTruthy();
    expect(state.kitId).toBe("kit-abc123");
    expect(state.writes).toEqual(["*.js", "**/*.ts"]);
    expect(state.deletes).toEqual(["*.tmp"]);
    expect(state.localDir).toBe(process.cwd());
    expect(state.createdAt).toBeTruthy();
    expect(state.lastAccessedAt).toBe(state.createdAt);
  });

  it("rejects plans with >256 writes", async () => {
    const writes = Array.from({ length: 257 }, (_, i) => `file${i}.js`);
    await expect(createPlan("kit-abc123", writes, [], process.cwd())).rejects.toThrow(
      TooManyWritesError,
    );
  });

  it("accepts plans with exactly 256 writes", async () => {
    const writes = Array.from({ length: 256 }, (_, i) => `file${i}.js`);
    await expect(createPlan("kit-abc123", writes, [], process.cwd())).resolves.not.toThrow();
  });

  it("rejects patterns with >3 wildcards", async () => {
    await expect(
      createPlan("kit-abc123", ["a/*/b/*/c/*/d/*.js"], [], process.cwd()),
    ).rejects.toThrow(TooComplexGlobError);
  });
});

describe("getPlan", () => {
  let tempHome: string;

  beforeEach(async () => {
    // Same isolation rationale as the createPlan block above.
    tempHome = await mkdtemp(join(tmpdir(), "genie-plans-"));
    process.env.GENIE_HOME = tempHome;
  });

  afterEach(async () => {
    delete process.env.GENIE_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("retrieves an existing plan", async () => {
    const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
    const retrieved = await getPlan(state.planId);

    expect(retrieved.planId).toBe(state.planId);
    expect(retrieved.kitId).toBe(state.kitId);
    expect(retrieved.writes).toEqual(state.writes);
  });

  it("throws PlanNotFoundError for non-existent plans", async () => {
    await expect(getPlan("nonexistent")).rejects.toThrow(PlanNotFoundError);
  });

  it("updates lastAccessedAt on retrieval", async () => {
    const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
    const originalAccessed = state.lastAccessedAt;

    // Wait a bit to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    const retrieved = await getPlan(state.planId);
    expect(retrieved.lastAccessedAt).not.toBe(originalAccessed);
  });

  it("does not expire before the configured TTL elapses (AC7)", async () => {
    process.env.GENIE_PLAN_TTL = "500";
    try {
      const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(getPlan(state.planId)).resolves.not.toThrow();
    } finally {
      delete process.env.GENIE_PLAN_TTL;
    }
  });

  it("expires after the configured TTL of inactivity (AC7)", async () => {
    process.env.GENIE_PLAN_TTL = "50";
    try {
      const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(getPlan(state.planId)).rejects.toThrow(PlanNotFoundError);
    } finally {
      delete process.env.GENIE_PLAN_TTL;
    }
  });

  it("deletes the on-disk snapshot once a plan is found expired (no unbounded growth)", async () => {
    process.env.GENIE_PLAN_TTL = "50";
    try {
      const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
      const planPath = join(tempHome, "plans", `${state.planId}.json`);

      // Snapshot exists immediately after creation.
      await expect(stat(planPath)).resolves.toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(getPlan(state.planId)).rejects.toThrow(PlanNotFoundError);

      // Regression guard: previously, expiry only deleted the in-memory
      // entry, so the disk snapshot lingered under `${GENIE_HOME}/plans/`
      // forever (each subsequent getPlan miss would even re-read and
      // re-discard it). It must now be unlinked as part of expiry.
      await expect(stat(planPath)).rejects.toThrow();
    } finally {
      delete process.env.GENIE_PLAN_TTL;
    }
  });

  it("survives a server restart via disk persistence (AC8)", async () => {
    const state = await createPlan(
      "kit-restart-test",
      ["*.js", "**/*.tsx"],
      ["*.tmp"],
      process.cwd(),
    );

    // Simulate a server restart: reset the module cache so re-importing
    // plans/index.js constructs a brand-new, empty in-memory planRegistry.
    // The only way getPlan() can then find the plan is by falling back to
    // ${GENIE_HOME}/plans/<planId>.json on disk — proving AC8 for real,
    // rather than just asserting a file exists.
    vi.resetModules();
    const fresh = await import("../plans/index.js");

    const retrieved = await fresh.getPlan(state.planId);
    expect(retrieved.planId).toBe(state.planId);
    expect(retrieved.kitId).toBe("kit-restart-test");
    expect(retrieved.writes).toEqual(["*.js", "**/*.tsx"]);
    expect(retrieved.deletes).toEqual(["*.tmp"]);
  });
});

describe("pruneExpiredPlans", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "genie-plans-"));
    process.env.GENIE_HOME = tempHome;
  });

  afterEach(async () => {
    delete process.env.GENIE_PLAN_TTL;
    delete process.env.GENIE_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("removes both the in-memory entry and the disk snapshot for expired plans", async () => {
    process.env.GENIE_PLAN_TTL = "50";
    const state = await createPlan("kit-abc123", ["*.js"], [], process.cwd());
    const planPath = join(tempHome, "plans", `${state.planId}.json`);

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Note: `planRegistry` is a module-level singleton shared across every
    // test in this file (by design — it models one long-lived server
    // process), so `pruneExpiredPlans()` here may also sweep up unrelated
    // expired plans left behind by earlier tests. Assert on this test's own
    // plan rather than the total pruned count.
    const pruned = await pruneExpiredPlans();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Disk snapshot must be gone too, not just the in-memory Map entry.
    await expect(stat(planPath)).rejects.toThrow();
    // And it's no longer retrievable at all (in-memory entry gone too).
    await expect(getPlan(state.planId)).rejects.toThrow(PlanNotFoundError);
  });
});

// ────────────────────────────────────────────────────────────
// Integration: plan tool via MCP client
// ────────────────────────────────────────────────────────────

describe("plan tool (via MCP)", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    process.env.GENIE_HOME = tempDir;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("creates a plan and returns planId", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js", "**/*.ts"] },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const response = JSON.parse(text) as { planId: string };
    expect(response.planId).toBeTruthy();
    expect(typeof response.planId).toBe("string");
    // Parity with list_kits/get_kit/read_file/list_components: MCP clients can
    // consume the result without re-parsing the text part.
    expect(result.structuredContent).toEqual({ planId: response.planId });
  });

  it("accepts optional deletes parameter", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"], deletes: ["*.tmp"] },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const response = JSON.parse(text) as { planId: string };
    expect(response.planId).toBeTruthy();
  });

  it("defaults localDir to cwd when omitted", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"] },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const response = JSON.parse(text) as { planId: string };

    const plan = await getPlan(response.planId);
    expect(plan.localDir).toBe(process.cwd());
  });

  it("accepts custom localDir", async () => {
    const customDir = join(tempDir, "custom");
    await mkdir(customDir, { recursive: true });

    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"], localDir: customDir },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const response = JSON.parse(text) as { planId: string };

    const plan = await getPlan(response.planId);
    expect(plan.localDir).toBe(customDir);
  });

  it("rejects non-existent localDir", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"], localDir: "/nonexistent/path" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const error = JSON.parse(text) as { error: string };
    expect(error.error).toBe("InvalidLocalDir");
  });

  it("rejects a localDir that exists but is a regular file, not a directory (AC5)", async () => {
    // Regression guard: `existsSync` (the original check) returns true for
    // any existing path, including a plain file, so a file path would have
    // silently produced a plan with an unusable localDir.
    const filePath = join(tempDir, "not-a-dir.txt");
    await writeFile(filePath, "hello", "utf-8");

    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"], localDir: filePath },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const error = JSON.parse(text) as { error: string };
    expect(error.error).toBe("InvalidLocalDir");
  });

  it("rejects plans with >256 writes", async () => {
    const writes = Array.from({ length: 257 }, (_, i) => `file${i}.js`);

    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const error = JSON.parse(text) as { error: string; count: number; max: number };
    expect(error.error).toBe("TooManyWritesError");
    expect(error.count).toBe(257);
    expect(error.max).toBe(MAX_WRITES);
  });

  it("rejects patterns with >3 wildcards", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["a/*/b/*/c/*/d/*.js"] },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const error = JSON.parse(text) as { error: string; wildcardCount: number };
    expect(error.error).toBe("TooComplexGlobError");
    expect(error.wildcardCount).toBeGreaterThan(MAX_WILDCARDS);
  });

  it("allows concurrent plans for the same kit", async () => {
    const result1 = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.js"] },
    });

    const result2 = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "kit-abc123", writes: ["*.ts"] },
    });

    expect(result1.isError).toBeUndefined();
    expect(result2.isError).toBeUndefined();

    const text1 = (result1.content as { type: string; text: string }[])[0]?.text ?? "";
    const text2 = (result2.content as { type: string; text: string }[])[0]?.text ?? "";
    const response1 = JSON.parse(text1) as { planId: string };
    const response2 = JSON.parse(text2) as { planId: string };

    expect(response1.planId).not.toBe(response2.planId);
  });
});
