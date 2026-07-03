/**
 * Tests for `withPlanGuard` — the centralised plan-vs-write guard middleware
 * (M1-13, DRO-239). Covers every rejection path from AC2 as well as the
 * happy-path passthrough, the JSON-RPC error shape from AC3, and the
 * structured `plan.guard.reject` log line from AC6.
 *
 * The middleware wraps an MCP tool-handler shape (`(args) => ToolResult`) with
 * plan-validation logic; on rejection it returns an `isError` tool response
 * that mirrors JSON-RPC -32602 `InvalidParams` with a structured
 * `data.reason` field. Successful validation delegates to the wrapped handler
 * and passes the resolved plan through in a second argument (so the handler
 * doesn't have to call `getPlan` a second time).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlan, type PlanState } from "../plans/index.js";
import { withPlanGuard } from "./plan-guard.js";

/**
 * Every rejection returns a text content part whose payload is a JSON-encoded
 * `{ code: -32602, message, data: { reason, ... } }` object — the JSON-RPC
 * error shape mandated by AC3. This helper unwraps that so tests can assert
 * against the structured payload directly.
 */
function parseGuardError(result: unknown): {
  code: number;
  message: string;
  data: { reason: string; planId?: string; path?: string };
} {
  const asObj = result as {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
  };
  if (asObj.isError !== true) {
    throw new Error(`expected isError=true, got ${JSON.stringify(result)}`);
  }
  const text = asObj.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

describe("withPlanGuard middleware", () => {
  let localDir: string;
  let genieHome: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localDir = await mkdtemp(join(tmpdir(), "genie-guard-local-"));
    // `plans/index.ts` persists to `${GENIE_HOME}/plans/…` — isolate each
    // test to a fresh temp dir so we never touch a shared registry.
    genieHome = await mkdtemp(join(tmpdir(), "genie-guard-home-"));
    process.env["GENIE_HOME"] = genieHome;
    // Capture the structured `plan.guard.reject` log lines (AC6). The plan
    // tool writes to stderr specifically so it doesn't corrupt the stdio
    // MCP framing on stdout; the guard follows the same convention.
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    delete process.env["GENIE_HOME"];
    await rm(localDir, { recursive: true, force: true });
    await rm(genieHome, { recursive: true, force: true });
  });

  // ─── AC2(a): planId presence check ────────────────────────────────────

  it("rejects when planId is missing entirely (undefined)", async () => {
    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({ files: [{ path: "a.html", data: "x" }] });

    const err = parseGuardError(result);
    expect(err.code).toBe(-32602);
    expect(err.data.reason).toBe("planIdMissing");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects when planId is an empty string", async () => {
    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({ planId: "", files: [] });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("planIdMissing");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects when planId is not a string", async () => {
    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({ planId: 123 as unknown as string, files: [] });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("planIdMissing");
    expect(handler).not.toHaveBeenCalled();
  });

  // ─── AC2(b): planId exists ────────────────────────────────────────────

  it("rejects an unknown planId with reason=planNotFound", async () => {
    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({
      planId: "00000000-0000-4000-8000-000000000000",
      files: [{ path: "a.html", data: "x" }],
    });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("planNotFound");
    expect(err.data.planId).toBe("00000000-0000-4000-8000-000000000000");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-UUID) planId with reason=planNotFound", async () => {
    // `getPlan` normalises "malformed UUID" and "unknown UUID" into a single
    // PlanNotFoundError (see plans/index.ts). The guard mirrors that: from
    // the caller's perspective, both are "no plan by that id."
    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({ planId: "../../x", files: [] });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("planNotFound");
    expect(handler).not.toHaveBeenCalled();
  });

  // ─── AC2(c): expiry ──────────────────────────────────────────────────

  it("rejects an expired planId with reason=planNotFound", async () => {
    // Set the TTL to 1 ms so a fresh plan expires after a single tick.
    // Note: `plans/index.ts`' `getPlanTTL` rejects `"0"` (its check is
    // `parsed > 0`, not `>= 0`) and falls back to the 1-hour default, so
    // we cannot force "instantly expired" — 1 ms plus a short real wait
    // (10 ms is well inside every filesystem's timer resolution) is the
    // deterministic way to hit the expiry branch without vi.useFakeTimers,
    // which would also fake `new Date()` inside `createPlan` and defeat
    // the setup.
    process.env["GENIE_PLAN_TTL"] = "1";
    try {
      const plan = await createPlan("k", ["**/*"], [], localDir);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const handler = vi.fn();
      const guarded = withPlanGuard({ mode: "writes" }, handler);
      const result = await guarded({
        planId: plan.planId,
        files: [{ path: "a.html", data: "x" }],
      });

      const err = parseGuardError(result);
      expect(err.data.reason).toBe("planNotFound");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      delete process.env["GENIE_PLAN_TTL"];
    }
  });

  // ─── AC2(d): path membership in writes/deletes globs ─────────────────

  it("mode=writes: rejects a path outside the plan's writes globs", async () => {
    const plan = await createPlan("k", ["components/**"], [], localDir);

    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({
      planId: plan.planId,
      files: [
        { path: "components/ok.html", data: "x" },
        { path: "outside/bad.html", data: "y" },
      ],
    });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("pathOutsidePlan");
    expect(err.data.path).toBe("outside/bad.html");
    expect(handler).not.toHaveBeenCalled();
  });

  it("mode=deletes: rejects a path outside the plan's deletes globs", async () => {
    const plan = await createPlan("k", ["**/*"], ["old/*.html"], localDir);

    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "deletes", pathsKey: "paths" }, handler);
    const result = await guarded({
      planId: plan.planId,
      paths: ["old/a.html", "secret.txt"],
    });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("pathOutsidePlan");
    expect(err.data.path).toBe("secret.txt");
    expect(handler).not.toHaveBeenCalled();
  });

  it("mode=writes checks against writes, not deletes (uses the right glob list)", async () => {
    // A path in `deletes` must NOT satisfy a write call — the two glob lists
    // are strictly separate. Without this, delete-scope-only paths could
    // silently be written by a plan that never authorised writing them.
    const plan = await createPlan("k", ["writes/**"], ["deletes/**"], localDir);

    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({
      planId: plan.planId,
      files: [{ path: "deletes/x.html", data: "x" }],
    });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("pathOutsidePlan");
    expect(err.data.path).toBe("deletes/x.html");
  });

  it("mode=deletes checks against deletes, not writes", async () => {
    const plan = await createPlan("k", ["writes/**"], ["deletes/**"], localDir);

    const handler = vi.fn();
    const guarded = withPlanGuard({ mode: "deletes", pathsKey: "paths" }, handler);
    const result = await guarded({ planId: plan.planId, paths: ["writes/x.html"] });

    const err = parseGuardError(result);
    expect(err.data.reason).toBe("pathOutsidePlan");
    expect(err.data.path).toBe("writes/x.html");
  });

  // ─── Happy-path passthrough ──────────────────────────────────────────

  it("delegates to the wrapped handler on success, passing the resolved plan", async () => {
    const plan = await createPlan("k", ["**/*"], [], localDir);

    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { writtenPaths: ["a.html"] },
    });

    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const args = { planId: plan.planId, files: [{ path: "a.html", data: "x" }] };
    const result = await guarded(args);

    // The wrapped handler should have been called with the original args and
    // a context object exposing the resolved plan (so the handler doesn't
    // need to call getPlan again for planId → plan lookup).
    expect(handler).toHaveBeenCalledTimes(1);
    const call = handler.mock.calls[0];
    expect(call[0]).toBe(args);
    // Second arg: guard context. The `plan` field should be the resolved
    // PlanState. We compare a couple of stable fields — lastAccessedAt is
    // bumped by getPlan and would otherwise cause a strict-equality mismatch.
    const ctx = call[1] as { plan: PlanState };
    expect(ctx.plan.planId).toBe(plan.planId);
    expect(ctx.plan.writes).toEqual(["**/*"]);
    expect(ctx.plan.localDir).toBe(localDir);

    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it("succeeds when every path matches the plan's writes globs", async () => {
    const plan = await createPlan("k", ["a.html", "b.html"], [], localDir);

    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({
      planId: plan.planId,
      files: [
        { path: "a.html", data: "x" },
        { path: "b.html", data: "y" },
      ],
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("succeeds with an empty files array (no paths to check)", async () => {
    const plan = await createPlan("k", ["**/*"], [], localDir);

    const handler = vi.fn().mockResolvedValue({ content: [] });
    const guarded = withPlanGuard({ mode: "writes" }, handler);
    const result = await guarded({ planId: plan.planId, files: [] });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ─── AC3: -32602 error code shape ────────────────────────────────────

  it("every rejection surfaces JSON-RPC code -32602 with a structured data.reason", async () => {
    // Cross-check that all three primary rejection paths (missing / not-
    // found / out-of-plan) produce the same envelope shape.
    const plan = await createPlan("k", ["allowed/**"], [], localDir);
    const handler = vi.fn();

    // Missing planId
    const r1 = await withPlanGuard({ mode: "writes" }, handler)({ files: [] });
    // Unknown planId
    const r2 = await withPlanGuard(
      { mode: "writes" },
      handler,
    )({ planId: "00000000-0000-4000-8000-000000000000", files: [] });
    // Out-of-plan path
    const r3 = await withPlanGuard(
      { mode: "writes" },
      handler,
    )({ planId: plan.planId, files: [{ path: "bad/x.html", data: "x" }] });

    for (const r of [r1, r2, r3]) {
      const err = parseGuardError(r);
      expect(err.code).toBe(-32602);
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
      expect(typeof err.data.reason).toBe("string");
    }
  });

  // ─── AC6: plan.guard.reject structured log event ─────────────────────

  it("logs a structured plan.guard.reject event on every rejection (no contents leaked)", async () => {
    const plan = await createPlan("k", ["allowed/**"], [], localDir);
    const handler = vi.fn();
    // Payload bytes we specifically DO NOT want to see in the log line —
    // AC6 says "no contents leaked". The guard should only log { planId,
    // reason, path? }, never any file data or metadata.
    const secretData = "SUPER-SECRET-PAYLOAD-BYTES-XYZ";

    await withPlanGuard(
      { mode: "writes" },
      handler,
    )({ planId: plan.planId, files: [{ path: "bad/x.html", data: secretData }] });

    // Collect every stderr write from this rejection. Some code paths may
    // also write via createPlan's `plan.created` — filter to guard events.
    const lines = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("plan.guard.reject"));

    expect(lines.length).toBeGreaterThan(0);
    const line = lines[0];
    const parsed = JSON.parse(line.trim());
    expect(parsed.event).toBe("plan.guard.reject");
    expect(parsed.planId).toBe(plan.planId);
    expect(parsed.reason).toBe("pathOutsidePlan");
    expect(parsed.path).toBe("bad/x.html");
    // The file contents must never appear in the log line.
    expect(line).not.toContain(secretData);
  });

  it("plan.guard.reject omits path when the rejection is not path-specific", async () => {
    const handler = vi.fn();
    await withPlanGuard({ mode: "writes" }, handler)({ files: [] });

    const lines = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("plan.guard.reject"));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0].trim());
    expect(parsed.event).toBe("plan.guard.reject");
    expect(parsed.reason).toBe("planIdMissing");
    // No planId for missing-id; no path for a non-path rejection.
    expect(parsed.path).toBeUndefined();
  });

  it("plan.guard.reject includes planId for planNotFound rejections", async () => {
    const handler = vi.fn();
    await withPlanGuard(
      { mode: "writes" },
      handler,
    )({ planId: "00000000-0000-4000-8000-000000000000", files: [] });

    const lines = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("plan.guard.reject"));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0].trim());
    expect(parsed.reason).toBe("planNotFound");
    expect(parsed.planId).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("does NOT log plan.guard.reject on the happy path (no false positives)", async () => {
    const plan = await createPlan("k", ["**/*"], [], localDir);
    const handler = vi.fn().mockResolvedValue({ content: [] });

    await withPlanGuard(
      { mode: "writes" },
      handler,
    )({
      planId: plan.planId,
      files: [{ path: "a.html", data: "x" }],
    });

    const guardLines = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("plan.guard.reject"));
    expect(guardLines).toHaveLength(0);
  });

  // ─── Configurability: extractPaths for tools with non-standard shapes ─

  it("accepts a custom extractPaths function for tools whose path list isn't `files`/`paths`", async () => {
    const plan = await createPlan("k", ["assets/**"], [], localDir);
    const handler = vi.fn().mockResolvedValue({ content: [] });

    // A future consumer (e.g. register_assets, per AC4's forward-compat
    // hook) supplies its own `path`-extraction function so the guard can
    // stay tool-agnostic. This test locks that seam.
    const guarded = withPlanGuard(
      {
        mode: "writes",
        extractPaths: (args: { assets: Array<{ path: string }> }) => args.assets.map((a) => a.path),
      },
      handler,
    );

    const okResult = await guarded({
      planId: plan.planId,
      assets: [{ path: "assets/card.html" }],
    });
    expect((okResult as { isError?: boolean }).isError).toBeFalsy();

    const badResult = await guarded({
      planId: plan.planId,
      assets: [{ path: "not-assets/x.html" }],
    });
    const err = parseGuardError(badResult);
    expect(err.data.reason).toBe("pathOutsidePlan");
    expect(err.data.path).toBe("not-assets/x.html");
  });
});
