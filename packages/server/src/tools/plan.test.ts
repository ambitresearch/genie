import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../server.js";
import { compileManifest } from "../manifest/compiler.js";
import { registerPlan } from "./plan.js";
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
  isValidPlanId,
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

  it("anchors a relative path to localDir, not process.cwd()", () => {
    // Regression guard: the original `resolve(path)` anchored relative paths to
    // the server's cwd. A relative localPath must be resolved against localDir
    // (the RFC's base for write_files), so this stays inside even when localDir
    // differs from cwd — and an escaping "../" relative path is still rejected.
    const localDir = "/home/user/project";
    expect(isPathInsideLocalDir("src/index.ts", localDir)).toBe(true);
    expect(isPathInsideLocalDir("./nested/a.ts", localDir)).toBe(true);
    expect(isPathInsideLocalDir("../evil.ts", localDir)).toBe(false);
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

  it("rejects a path-traversal planId before it touches a disk path", async () => {
    // A hostile planId must never be interpolated into `<planId>.json`; it is
    // rejected up front as not-found because it can't be a real (UUID) plan.
    await expect(getPlan("../../etc/passwd")).rejects.toThrow(PlanNotFoundError);
    await expect(getPlan("..")).rejects.toThrow(PlanNotFoundError);
    expect(isValidPlanId("../../x")).toBe(false);
    expect(isValidPlanId("11111111-2222-3333-4444-555555555555")).toBe(true);
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
  let kitId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    process.env.GENIE_HOME = tempDir;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // `plan` resolves the kit before issuing a planId (#252), so these cases —
    // which are about writes/deletes/localDir, not kit identity — mint a real
    // kit through the public verb rather than asserting against a literal id.
    const created = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Plan Test Kit" },
    });
    const createdText = (created.content as { type: string; text: string }[])[0]?.text ?? "";
    kitId = (JSON.parse(createdText) as { kitId: string }).kitId;
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("creates a plan and returns planId", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["*.js", "**/*.ts"] },
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

  it("advertises an outputSchema in tools/list (repo-wide convention)", async () => {
    // Every tool returning structuredContent also declares outputSchema so
    // clients can validate the result (see list_kits/get_project/bind_kit).
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "mcp__genie__plan");
    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["planId"],
    });
  });

  it("emits a plan.created audit line to stderr, not stdout (AC10)", async () => {
    // The audit log MUST go to stderr: on the stdio transport, stdout *is* the
    // JSON-RPC protocol stream, so a stray line there corrupts client framing.
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
      const result = await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId, writes: ["*.js", "**/*.ts"], deletes: ["*.tmp"] },
      });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      const { planId } = JSON.parse(text) as { planId: string };

      const auditLine = stderrLines.find((l) => l.includes("plan.created"));
      expect(auditLine).toBeTruthy();
      const audit = JSON.parse(auditLine as string) as Record<string, unknown>;
      expect(audit).toMatchObject({
        event: "plan.created",
        kitId,
        planId,
        writeCount: 2,
        deleteCount: 1,
      });

      // Never on stdout — that would corrupt the JSON-RPC framing.
      expect(stdoutLines.some((l) => l.includes("plan.created"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("accepts optional deletes parameter", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["*.js"], deletes: ["*.tmp"] },
    });

    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const response = JSON.parse(text) as { planId: string };
    expect(response.planId).toBeTruthy();
  });

  it("defaults localDir to cwd when omitted", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["*.js"] },
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
      arguments: { kitId, writes: ["*.js"], localDir: customDir },
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
      arguments: { kitId, writes: ["*.js"], localDir: "/nonexistent/path" },
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
      arguments: { kitId, writes: ["*.js"], localDir: filePath },
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
      arguments: { kitId, writes },
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
      arguments: { kitId, writes: ["a/*/b/*/c/*/d/*.js"] },
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
      arguments: { kitId, writes: ["*.js"] },
    });

    const result2 = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["*.ts"] },
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

// ────────────────────────────────────────────────────────────
// kitId validation (#252)
// ────────────────────────────────────────────────────────────

describe("plan tool — kitId validation (#252)", () => {
  let tempDir: string;
  let kitsRoot: string;
  let client: Client;
  let kitId: string;

  const payload = (result: unknown): Record<string, unknown> => {
    const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
    return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    process.env.GENIE_HOME = tempDir;
    kitsRoot = join(tempDir, "kits");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ kitsRoot });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // Mint a real kit so the happy paths below exercise a kit that genuinely
    // resolves through the same store the server writes with.
    const created = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Plan Validation Kit" },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    kitId = payload(created).kitId as string;
    expect(kitId).toBeTruthy();
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("rejects a well-formed kitId that names no existing kit", async () => {
    // The reported bug: `plan` happily issued a planId for a kit that does not
    // exist, and `write_files` then created the directory and wrote bytes into
    // it. A plan is a scoped write authorization for a *specific* kit, and path
    // containment is enforced relative to that kit — so an unresolvable kit
    // weakens the containment guarantee itself, not just the error message.
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "no-such-kit-000000", writes: ["*.html"] },
    });

    expect(result.isError).toBe(true);
    // Same envelope as the plan-guard's planNotFound / pathOutsidePlan
    // rejections, so a client can branch on code/data.reason uniformly.
    expect(payload(result)).toMatchObject({
      code: -32602,
      data: { reason: "kitNotFound", kitId: "no-such-kit-000000" },
    });
  });

  it("rejects containment-unsafe kitIds with the same typed error", async () => {
    // `""`, `.`, `..`, and any id carrying a path separator escape the
    // single-kit namespace, so they are refused by the shared `isSafeKitId`
    // rule *before* the store is touched — which also keeps `getKit` (it
    // resolves a path without re-checking id safety) from reading above
    // kitsRoot. They surface as the same rejection a genuinely-missing kit
    // would, mirroring the store's own precedent for unsafe ids.
    for (const bad of ["..", ".", "../escape", "a/b", "a\\b"]) {
      const result = await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId: bad, writes: ["*.html"] },
      });

      expect(result.isError, `expected rejection for kitId ${JSON.stringify(bad)}`).toBe(true);
      expect(payload(result)).toMatchObject({
        code: -32602,
        data: { reason: "kitNotFound", kitId: bad },
      });
    }
  });

  it("rejects safe-but-absent kitIds by lookup, with the same typed error", async () => {
    // These are all containment-safe, so they reach the store and are refused
    // because no such kit resolves — not because of their charset. Same
    // envelope either way, so a client branches on one reason.
    for (const bad of ["UPPER", "ab", "a".repeat(65), "My_Kit.2", "..kit"]) {
      const result = await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId: bad, writes: ["*.html"] },
      });

      expect(result.isError, `expected rejection for kitId ${JSON.stringify(bad)}`).toBe(true);
      expect(payload(result)).toMatchObject({
        code: -32602,
        data: { reason: "kitNotFound", kitId: bad },
      });
    }
  });

  it("🔒 plans against a resolvable kit whose id is not create_kit-shaped", async () => {
    // Regression lock for the review finding on #263: `KitId` is an opaque,
    // adapter-assigned string. `KIT_ID_PATTERN` (/^[a-z0-9-]{3,64}$/) describes
    // only ids MINTED by create_kit, while an imported or git-host kit may
    // legitimately be named `My_Kit.2` or `a`. `read_file`/`list_files` already
    // browse such kits through `isSafeKitId`, and `list_kits` promises the ids
    // it returns are valid input to `plan` — so gating `plan` on the stricter
    // pattern would make a resolvable, browsable kit unwritable.
    for (const importedId of ["My_Kit.2", "a", "..kit"]) {
      const kitDir = join(kitsRoot, importedId);
      await mkdir(kitDir, { recursive: true });
      await writeFile(
        join(kitDir, ".kit.json"),
        JSON.stringify({
          id: importedId,
          name: `Imported ${importedId}`,
          type: "GENIE_KIT",
          createdAt: new Date().toISOString(),
        }),
      );

      const result = await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId: importedId, writes: ["*.html"], localDir: tempDir },
      });

      expect(
        result.isError,
        `expected ${JSON.stringify(importedId)} to plan: ${JSON.stringify(result)}`,
      ).toBeFalsy();
      expect(payload(result).planId).toBeTruthy();
    }
  });

  it("issues no plan when the kit is rejected", async () => {
    // A rejected call must not leave a usable write authorization behind.
    const before = await readdir(join(tempDir, "plans")).catch(() => [] as string[]);

    await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: "no-such-kit-000000", writes: ["*.html"] },
    });

    const after = await readdir(join(tempDir, "plans")).catch(() => [] as string[]);
    expect(after).toEqual(before);
  });

  it("emits a plan.rejected audit line to stderr, not stdout", async () => {
    // Same constraint as plan.created: on the stdio transport stdout *is* the
    // JSON-RPC stream, so a stray line there corrupts client framing.
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
      await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId: "no-such-kit-000000", writes: ["*.html"] },
      });

      const auditLine = stderrLines.find((l) => l.includes("plan.rejected"));
      expect(auditLine).toBeTruthy();
      expect(JSON.parse(auditLine as string)).toMatchObject({
        event: "plan.rejected",
        reason: "kitNotFound",
        kitId: "no-such-kit-000000",
      });
      expect(stdoutLines.some((l) => l.includes("plan.rejected"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("still plans and writes for a kit that exists", async () => {
    const planResult = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["components/**/*.html"], localDir: tempDir },
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const planId = payload(planResult).planId as string;
    expect(planId).toBeTruthy();

    const writeResult = await client.callTool({
      name: "mcp__genie__write_files",
      arguments: {
        planId,
        files: [{ path: "components/Button.html", data: "<button>Hi</button>" }],
      },
    });
    expect(writeResult.isError, JSON.stringify(writeResult)).toBeFalsy();

    const written = await stat(join(kitsRoot, kitId, "components", "Button.html"));
    expect(written.isFile()).toBe(true);
  });

  it("accepts the manifest name the embedded Browse tier passes as kitId", async () => {
    // Regression lock for the two kit-identity namespaces tracked in #254.
    //
    // In the embedded Browse → Review → Apply path the viewer seeds its
    // `options.kitId` from the *compiled manifest name*, not from `kit.id`
    // (viewer.js: `kitId: browseSeedManifest && browseSeedManifest.name`), and
    // hands that value to `plan`. That works today only because the manifest
    // name is `basename(projectRoot)` (manifest/compiler.ts) and the kit
    // directory *is* the kit id (store/local.ts `kitDir = join(baseDir, kitId)`,
    // reached via grid-resource's `resolveKitDir = join(kitsRoot, kitId)`).
    //
    // That equivalence is load-bearing: validating kitId at plan time is only
    // safe for Browse while it holds. Assert it directly so a future change to
    // the compiler's name derivation or to kit-dir layout fails loudly here
    // instead of silently breaking Apply in the embedded tier.
    const { manifest } = await compileManifest(join(kitsRoot, kitId));
    expect(manifest.name).toBe(kitId);

    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: manifest.name, writes: ["components/**/*.html"], localDir: tempDir },
    });

    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(payload(result).planId).toBeTruthy();
  });

  it("re-throws a store fault instead of reporting it as a missing kit", async () => {
    // Fail-closed is not the same as fail-silent. A genuine "no such kit" is a
    // `kitNotFound` rejection; an I/O or transport fault (EACCES, or a network
    // error behind a git-host store) must surface as itself so an operator can
    // tell a typo apart from a broken backend. Either way no plan is issued.
    const boom = new Error("EACCES: permission denied, open '.kit.json'");
    const failingStore = {
      getKit: vi.fn(async () => {
        throw boom;
      }),
    };

    const server = new McpServer({ name: "genie-test", version: "0" });
    registerPlan(server, failingStore);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const stubClient = new Client({ name: "stub-client", version: "1.0.0" }, { capabilities: {} });
    await stubClient.connect(clientTransport);

    try {
      const result = await stubClient.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId: "some-real-kit", writes: ["*.html"], localDir: tempDir },
      });

      expect(failingStore.getKit).toHaveBeenCalledWith("some-real-kit");
      expect(result.isError).toBe(true);

      const text = ((result.content as { type: string; text: string }[]) ?? [])[0]?.text ?? "";
      expect(text).toContain("EACCES");
      // Crucially NOT mislabelled as a missing kit.
      expect(text).not.toContain("kitNotFound");

      // And still fail-closed: no plan was persisted.
      let plans: string[] = [];
      try {
        plans = await readdir(join(tempDir, "plans"));
      } catch {
        plans = [];
      }
      expect(plans).toEqual([]);
    } finally {
      await stubClient.close();
    }
  });

  it("🔒 re-throws a REAL LocalFsKitStore read fault, not just a stubbed one", async () => {
    // Regression lock for the review finding on #263. The stub above proves the
    // branch in plan.ts, but not the adapter: `readMeta` used to `catch {}`
    // every error and return undefined, which `getKit` then turned into
    // NotFoundError — so an unreadable kit reached plan.ts already disguised as
    // a missing one and the narrowed catch could never fire. `readMeta` now
    // swallows only genuine absence (ENOENT/ENOTDIR) and re-throws real faults.
    //
    // Forced with a DIRECTORY at the .kit.json path: `readFile` then fails
    // EISDIR deterministically, on every platform and regardless of whether the
    // suite runs as root (which would defeat a chmod-based test in CI).
    const brokenId = "unreadable-kit";
    await mkdir(join(kitsRoot, brokenId, ".kit.json"), { recursive: true });

    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: brokenId, writes: ["*.html"], localDir: tempDir },
    });

    expect(result.isError, JSON.stringify(result)).toBe(true);
    const text = ((result.content as { type: string; text: string }[]) ?? [])[0]?.text ?? "";
    // The kit EXISTS but cannot be read — reporting "does not exist" would send
    // an operator hunting a typo instead of a broken backend.
    expect(text).not.toContain("kitNotFound");
    expect(text).toMatch(/EISDIR|illegal operation on a directory/i);

    // Still fail-closed: no plan authorization was issued.
    let plans: string[];
    try {
      plans = await readdir(join(tempDir, "plans"));
    } catch {
      plans = [];
    }
    expect(plans).toEqual([]);
  });

  it("still lists kits when one neighbour's metadata is unreadable", async () => {
    // The strictness above must NOT leak into enumeration: listKits walks a root
    // that may hold foreign or half-written entries, and one bad neighbour must
    // not fail the whole listing (hence readMetaIfReadable). Guards against a
    // fix for the above regressing list_kits / the empty-state grid.
    await mkdir(join(kitsRoot, "broken-neighbour", ".kit.json"), { recursive: true });

    const result = await client.callTool({ name: "mcp__genie__list_kits", arguments: {} });

    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
    const kits = JSON.parse(content[0]?.text ?? "[]") as { id: string }[];
    expect(kits.map((k) => k.id)).toContain(kitId);
    expect(kits.map((k) => k.id)).not.toContain("broken-neighbour");
  });
});
