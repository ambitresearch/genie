/**
 * Tests for the plan-vs-write guard middleware (M1-13).
 *
 * Covers every AC:
 *   AC1 — withPlanGuard is a higher-order function.
 *   AC2 — the four checks: (a) planId present, (b) exists, (c) not expired,
 *         (d) every path matches the allow-list and stays in-boundary.
 *   AC3 — default rendering is MCP -32602 with a structured data.reason.
 *   AC4 — exercised by write_files/delete_files suites (integration); here we
 *         prove mapReason preserves a tool's own error taxonomy.
 *   AC5 — this file (colocated with the middleware).
 *   AC6 — a structured plan.guard.reject line is emitted on every rejection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasDotSegment,
  logPlanGuardReject,
  PlanGuardError,
  runPlanGuard,
  withPlanGuard,
  type PlanGuardContext,
} from "./plan-guard.js";
import { createPlan, getPlanTTL, PLAN_TTL_ENV } from "../plans/index.js";

const KIT_ID = "kit-guard-test";

interface Env {
  home: string;
  kitsRoot: string;
  kitDir: string;
}

async function setup(): Promise<Env> {
  const home = await mkdtemp(join(tmpdir(), "genie-planguard-"));
  process.env.GENIE_HOME = home;
  const kitsRoot = join(home, "kits");
  const kitDir = join(kitsRoot, KIT_ID);
  return { home, kitsRoot, kitDir };
}

let env: Env;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await rm(env.home, { recursive: true, force: true });
  delete process.env.GENIE_HOME;
  delete process.env[PLAN_TTL_ENV];
});

/** Options for a write-class guard against a plan's localDir boundary. */
function writeOptions(getPlanId: () => string | undefined, paths: string[]) {
  return {
    kind: "write" as const,
    getPlanId,
    getPaths: () => paths,
    resolveBoundary: (plan: { localDir: string }) => resolve(plan.localDir),
  };
}

/** Options for a delete-class guard against the kit root boundary. */
function deleteOptions(kitsRoot: string, getPlanId: () => string | undefined, paths: string[]) {
  return {
    kind: "delete" as const,
    getPlanId,
    getPaths: () => paths,
    resolveBoundary: (plan: { kitId: string }) => resolve(kitsRoot, plan.kitId),
    rootForBoundary: resolve(kitsRoot),
  };
}

// ── AC1 — withPlanGuard is a HOF ──────────────────────────────────────────────
describe("AC1 — withPlanGuard higher-order function", () => {
  it("returns a callable that wraps a handler", () => {
    const wrapped = withPlanGuard(async () => ({ content: [] }), {
      kind: "write",
      getPlanId: () => "x",
      getPaths: () => [],
      resolveBoundary: () => "/tmp",
    });
    expect(typeof wrapped).toBe("function");
  });

  it("invokes the handler with a validated context on success", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    let seen: PlanGuardContext | undefined;
    const wrapped = withPlanGuard(
      async (_args: unknown, ctx) => {
        seen = ctx;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
      writeOptions(() => planId, ["components/Button.tsx"]),
    );

    const result = await wrapped({});
    expect(result.isError).toBeFalsy();
    expect(seen?.plan.planId).toBe(planId);
    expect(seen?.paths).toEqual(["components/Button.tsx"]);
  });
});

// ── AC2 — the four checks ─────────────────────────────────────────────────────
describe("AC2 — guard checks (a) present (b) exists (c) not expired (d) in-plan", () => {
  it("(a) rejects a missing planId with MISSING_PLAN_ID", async () => {
    await expect(
      runPlanGuard({}, writeOptions(() => undefined, ["a.tsx"])),
    ).rejects.toMatchObject({ reason: "MISSING_PLAN_ID" });
  });

  it("(a) rejects an empty-string planId with MISSING_PLAN_ID", async () => {
    await expect(
      runPlanGuard({}, writeOptions(() => "", ["a.tsx"])),
    ).rejects.toMatchObject({ reason: "MISSING_PLAN_ID" });
  });

  it("(b) rejects an unknown planId with PLAN_NOT_FOUND", async () => {
    await expect(
      runPlanGuard(
        {},
        writeOptions(() => "00000000-0000-0000-0000-000000000000", ["a.tsx"]),
      ),
    ).rejects.toMatchObject({ reason: "PLAN_NOT_FOUND" });
  });

  it("(b) rejects a malformed (non-UUID) planId with PLAN_NOT_FOUND", async () => {
    await expect(
      runPlanGuard({}, writeOptions(() => "../../etc", ["a.tsx"])),
    ).rejects.toMatchObject({ reason: "PLAN_NOT_FOUND" });
  });

  it("(c) rejects an expired plan with PLAN_NOT_FOUND", async () => {
    // TTL of 1ms → the plan is expired by the time we read it back.
    process.env[PLAN_TTL_ENV] = "1";
    expect(getPlanTTL()).toBe(1);
    const planId = (await createPlan(KIT_ID, ["**"], [], env.kitDir)).planId;
    await new Promise((r) => setTimeout(r, 5));
    await expect(
      runPlanGuard({}, writeOptions(() => planId, ["a.tsx"])),
    ).rejects.toMatchObject({ reason: "PLAN_NOT_FOUND" });
  });

  it("(d) accepts a path inside the plan's writes and boundary", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    const ctx = await runPlanGuard({}, writeOptions(() => planId, ["components/Card.tsx"]));
    expect(ctx.paths).toEqual(["components/Card.tsx"]);
  });

  it("(d) rejects a path matching no writes glob with PATH_NOT_IN_PLAN", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    await expect(
      runPlanGuard({}, writeOptions(() => planId, ["secrets/key.txt"])),
    ).rejects.toMatchObject({ reason: "PATH_NOT_IN_PLAN", path: "secrets/key.txt" });
  });

  it("(d) rejects a dot-segment path with PATH_DOT_SEGMENT (before glob check)", async () => {
    // A permissive glob that WOULD match the raw string, proving the dot-segment
    // guard fires first and gating never depends on micromatch's `..` handling.
    const planId = (await createPlan(KIT_ID, ["**"], [], env.kitDir)).planId;
    await expect(
      runPlanGuard({}, writeOptions(() => planId, ["allowed/../secret.txt"])),
    ).rejects.toMatchObject({ reason: "PATH_DOT_SEGMENT", path: "allowed/../secret.txt" });
  });

  it("(d) rejects an absolute path that escapes the boundary with PATH_ESCAPES_PLAN", async () => {
    // `**` matches "/etc/passwd" under micromatch, and resolve(localDir, "/x")
    // returns "/x" verbatim — so glob-membership alone is insufficient. The
    // boundary containment check is what stops it.
    const planId = (await createPlan(KIT_ID, ["**"], [], env.kitDir)).planId;
    await expect(
      runPlanGuard({}, writeOptions(() => planId, ["/etc/passwd"])),
    ).rejects.toMatchObject({ reason: "PATH_ESCAPES_PLAN", path: "/etc/passwd" });
  });

  it("(d) delete-class gates against `deletes`, not `writes`", async () => {
    // writes allows components/**, deletes allows ONLY stale/**. A path under
    // components must be rejected for a delete-class guard.
    const planId = (await createPlan(KIT_ID, ["components/**"], ["stale/**"], env.kitDir)).planId;
    await expect(
      runPlanGuard({}, deleteOptions(env.kitsRoot, () => planId, ["components/Card.tsx"])),
    ).rejects.toMatchObject({ reason: "PATH_NOT_IN_PLAN" });
    // …but a stale/** path is accepted.
    const ok = await runPlanGuard(
      {},
      deleteOptions(env.kitsRoot, () => planId, ["stale/old.tsx"]),
    );
    expect(ok.paths).toEqual(["stale/old.tsx"]);
  });

  it("(d) rejects a plan whose kitId escapes kitsRoot with PATH_ESCAPES_PLAN (defence in depth)", async () => {
    // A hostile plan authored with kitId ".." resolves a boundary OUTSIDE
    // kitsRoot; the guard must reject before examining any path.
    const planId = (await createPlan("..", ["**"], ["**"], env.kitDir)).planId;
    await expect(
      runPlanGuard({}, deleteOptions(env.kitsRoot, () => planId, ["x.txt"])),
    ).rejects.toMatchObject({ reason: "PATH_ESCAPES_PLAN" });
  });

  it("de-duplicates repeated paths, preserving first-seen order", async () => {
    const planId = (await createPlan(KIT_ID, ["**"], [], env.kitDir)).planId;
    const ctx = await runPlanGuard(
      {},
      writeOptions(() => planId, ["a.tsx", "b.tsx", "a.tsx"]),
    );
    expect(ctx.paths).toEqual(["a.tsx", "b.tsx"]);
  });
});

// ── AC3 — default rendering is -32602 + data.reason ───────────────────────────
describe("AC3 — default MCP error rendering", () => {
  it("renders an out-of-plan path as isError -32602 with data.reason", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    const wrapped = withPlanGuard(
      async () => ({ content: [{ type: "text" as const, text: "unreached" }] }),
      writeOptions(() => planId, ["secrets/k.txt"]),
    );
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe(-32602);
    expect(body.data.reason).toBe("PATH_NOT_IN_PLAN");
    expect(body.data.path).toBe("secrets/k.txt");
  });

  it("does not invoke the handler when the guard rejects", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    let called = false;
    const wrapped = withPlanGuard(
      async () => {
        called = true;
        return { content: [] };
      },
      writeOptions(() => planId, ["outside/x"]),
    );
    await wrapped({});
    expect(called).toBe(false);
  });
});

// ── AC4 — mapReason preserves a tool's own error taxonomy ─────────────────────
describe("AC4 — mapReason lets a tool keep its own error taxonomy", () => {
  class ToolSpecificError extends Error {
    constructor(readonly reason: string) {
      super(`tool-specific: ${reason}`);
      this.name = "ToolSpecificError";
    }
  }

  it("throws the tool's own error (not the default -32602 result) via mapReason", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    const wrapped = withPlanGuard(async () => ({ content: [] }), {
      ...writeOptions(() => planId, ["outside/x.tsx"]),
      mapReason: (e) => new ToolSpecificError(e.reason),
    });
    await expect(wrapped({})).rejects.toBeInstanceOf(ToolSpecificError);
  });
});

// ── AC6 — structured plan.guard.reject audit line ─────────────────────────────
describe("AC6 — plan.guard.reject audit logging", () => {
  it("emits a structured line with planId, reason and path, and no contents", () => {
    const lines: string[] = [];
    const sink = { write: (c: string) => void lines.push(c) };
    logPlanGuardReject(
      "plan-123",
      new PlanGuardError("PATH_NOT_IN_PLAN", "nope", "secrets/k.txt"),
      sink,
    );
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toEqual({
      event: "plan.guard.reject",
      planId: "plan-123",
      reason: "PATH_NOT_IN_PLAN",
      path: "secrets/k.txt",
    });
    // No file contents ever leak into the audit line.
    expect(lines[0]).not.toContain("content");
  });

  it("omits path for a plan-level (non-path) rejection and null-encodes a missing planId", () => {
    const lines: string[] = [];
    const sink = { write: (c: string) => void lines.push(c) };
    logPlanGuardReject(undefined, new PlanGuardError("MISSING_PLAN_ID", "no id"), sink);
    const record = JSON.parse(lines[0]!);
    expect(record).toEqual({
      event: "plan.guard.reject",
      planId: null,
      reason: "MISSING_PLAN_ID",
    });
    expect(record).not.toHaveProperty("path");
  });

  it("withPlanGuard emits exactly one audit line per rejection", async () => {
    const planId = (await createPlan(KIT_ID, ["components/**"], [], env.kitDir)).planId;
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // Capture stderr for the duration of the call.
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      lines.push(c);
      return true;
    };
    try {
      const wrapped = withPlanGuard(
        async () => ({ content: [] }),
        writeOptions(() => planId, ["outside/x"]),
      );
      await wrapped({});
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const rejectLines = lines.filter((l) => l.includes("plan.guard.reject"));
    expect(rejectLines).toHaveLength(1);
  });
});

// ── hasDotSegment unit coverage (the shared traversal primitive) ──────────────
describe("hasDotSegment", () => {
  it.each([
    ["a/../b", true],
    ["./a", true],
    ["a/./b", true],
    ["..", true],
    ["a\\..\\b", true], // backslash separator (Windows)
    ["a/b/c.txt", false],
    ["components/Button.tsx", false],
    ["a..b/c", false], // ".." only as a full segment, not a substring
  ])("hasDotSegment(%j) === %s", (input, expected) => {
    expect(hasDotSegment(input)).toBe(expected);
  });
});
