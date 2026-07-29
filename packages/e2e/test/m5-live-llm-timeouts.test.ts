// ─────────────────────────────────────────────────────────────────────────────
// #301 — live-LLM smoke tests must not inherit the MCP SDK's 60s default
// ─────────────────────────────────────────────────────────────────────────────
//
// `Client.callTool(params, resultSchema, options)` takes its per-request budget
// as the THIRD argument. Leave `options` unset and the SDK quietly applies
// `DEFAULT_REQUEST_TIMEOUT_MSEC` (60_000) — regardless of what the surrounding
// `it(name, fn, timeoutMs)` claims to allow.
//
// That is exactly how `main` went red: `m5-smoke-claude-desktop.test.ts`
// declared a 180s budget, drove the chain with a bare `client.callTool({...})`,
// and died at 60032ms with `McpError -32001: Request timed out`. The test said
// 180s; the wire gave it 60s.
//
// A live `conjure` is *documented in this repo* to take far longer than 60s —
// see `m2-generation.test.ts:128-156`, which measured ~101s / ~114s / up to
// ~125s for a single call against the real endpoint and raised its own ceiling
// to 360s, concluding the failure class "was a test-infra timeout, not a
// generation failure".
//
// WHY THIS GUARD IS STRUCTURAL RATHER THAN BEHAVIOURAL
// ----------------------------------------------------
// The behavioural failure only reproduces under live endpoint latency that CI
// cannot deterministically force. Reproducing it for real would mean either
// sleeping >60s in CI or asserting against the SDK's own timer instead of our
// code. So this asserts on the call sites themselves — the same technique
// `m2-generation.test.ts:242` already uses to meta-assert CI job config with
// `expect(m2Job).toContain("timeout-minutes: 25")`.
//
// It is cheap, deterministic, always runs (no LLM env required), and fails the
// moment a live call site regains the implicit 60s default.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Worst-case latency observed for a SINGLE live `conjure`, as measured and
 * recorded in `m2-generation.test.ts:128-156`. This is the number every budget
 * below has to clear — with margin, not by a hair.
 */
const OBSERVED_WORST_CASE_CONJURE_MS = 125_000;

/**
 * Required headroom over that worst case. m2's own post-mortem is that a
 * ceiling sized close to the observed maximum is what produced the flake in the
 * first place, so "just above the max" is not good enough.
 */
const REQUIRED_MARGIN_MULTIPLIER = 1.5;

/** The CI job cap these suites run under (`ci.yml` → `timeout-minutes: 25`). */
const CI_JOB_CEILING_MS = 25 * 60 * 1000;

interface LiveSuite {
  /** Test file, relative to this directory. */
  file: string;
  /**
   * Title fragment identifying the live chain test. Slicing the source from
   * here is what scopes the assertions to the LIVE call site — `cursor`, for
   * example, also has an earlier deliberately-unconfigured `conjure` call that
   * asserts a tool-level error and correctly needs no timeout.
   */
  liveTestMarker: string;
  /**
   * Source text identifying the live `conjure` call within that block. Most
   * suites name the tool with a string literal; `m5-smoke-claude-code` imports
   * the `CONJURE_TOOL_NAME` constant instead.
   */
  conjureCallMarker: string;
  /**
   * Set only when the live call does NOT reach `client.callTool` directly.
   * `m5-smoke-copilot` goes through a local `Harness.call` wrapper, so AC1
   * proves the CALLER supplied `{ timeout }` and nothing more — the wrapper in
   * between must also forward it as callTool's THIRD argument, or the request
   * silently reverts to the SDK default while every assertion here stays
   * green. That is the #301 defect re-entering through the indirection.
   *
   * Suites without this field are asserted to be direct callers instead, so a
   * newly-introduced wrapper cannot quietly slip past this check either.
   */
  wrapperForwarding?: {
    /** Source text where the wrapper's delegation begins. */
    marker: string;
    /**
     * Required delegation shape. Anchored on the result-schema argument so a
     * regressed two-argument `callTool(params, CallToolResultSchema)` — which
     * is exactly what drops the budget back to 60s — cannot match.
     */
    pattern: RegExp;
  };
}

const LIVE_SUITES: LiveSuite[] = [
  {
    file: "m5-smoke-claude-desktop.test.ts",
    liveTestMarker: "one contiguous chain over real stdio when an LLM endpoint is configured",
    conjureCallMarker: '"mcp__genie__conjure"',
  },
  {
    file: "m5-smoke-cursor.test.ts",
    liveTestMarker: "one contiguous chain over real stdio when an LLM endpoint is configured",
    conjureCallMarker: '"mcp__genie__conjure"',
  },
  {
    // Runs over `InMemoryTransport`, but the SDK's request timeout is a
    // Protocol-level concern, so this suite is capped at 60s just the same.
    file: "m5-smoke-copilot.test.ts",
    liveTestMarker:
      "against a REAL GENIE_LLM_*-configured endpoint, conjure -> plan -> write_files -> preview succeeds",
    conjureCallMarker: '"mcp__genie__conjure"',
    // This suite alone reaches the SDK through a wrapper. The behavioural
    // companion proof lives in the suite itself ("Harness.call forwards
    // `options` ..."), which drives a real request against a stalled tool
    // handler; this is the cheap structural half of the same guarantee.
    wrapperForwarding: {
      marker: "call: (name, args, options) =>",
      pattern: /client\.callTool\(\s*\{[^}]*\}\s*,\s*CallToolResultSchema\s*,\s*options\s*,?\s*\)/,
    },
  },
  {
    // Runs live in CI via the manual-dispatch `M5-09 Claude Code smoke` job,
    // which sets GENIE_REQUIRE_LLM=1 against real secrets.
    file: "m5-smoke-claude-code.test.ts",
    liveTestMarker:
      "M5-09 — conjure → write_files → preview → validate, exactly as documented for Claude Code",
    conjureCallMarker: "name: CONJURE_TOOL_NAME",
  },
];

function sourceOf(file: string): string {
  return readFileSync(resolve(here, file), "utf8");
}

/** Read a `const NAME = 123_456;` numeric literal out of a source file. */
function numericConst(source: string, name: string): number | undefined {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`).exec(source);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits.replace(/_/g, ""));
}

/** The live `conjure` call expression, scoped to the live test block. */
function liveConjureCallSite(source: string, marker: string, conjureMarker: string): string {
  const markerAt = source.indexOf(marker);
  expect(markerAt, `live test marker not found: ${marker}`).toBeGreaterThan(-1);
  const liveBlock = source.slice(markerAt);
  const conjureAt = liveBlock.indexOf(conjureMarker);
  expect(conjureAt, "no live conjure call found after the live test marker").toBeGreaterThan(-1);
  return liveBlock.slice(conjureAt, conjureAt + 800);
}

describe("#301 — live-LLM call sites carry an explicit request timeout", () => {
  // The premise every assertion below rests on. If the SDK ever raises its
  // default, this fails loudly instead of leaving a stale rationale in place.
  it("the MCP SDK default request timeout is still smaller than a real conjure", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBe(60_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBeLessThan(OBSERVED_WORST_CASE_CONJURE_MS);
  });

  describe.each(LIVE_SUITES)(
    "$file",
    ({ file, liveTestMarker, conjureCallMarker, wrapperForwarding }) => {
      // AC1 — the actual bug: the call must stop inheriting the SDK default.
      it("passes an explicit timeout to the live conjure callTool", () => {
        const callSite = liveConjureCallSite(sourceOf(file), liveTestMarker, conjureCallMarker);
        expect(callSite).toContain("timeout: LIVE_CONJURE_TIMEOUT_MS");
      });

      // AC2 — sized from measured reality, with real margin.
      it("sizes that timeout above the observed worst-case conjure, with margin", () => {
        const source = sourceOf(file);
        const requestTimeout = numericConst(source, "LIVE_CONJURE_TIMEOUT_MS");
        expect(requestTimeout, "LIVE_CONJURE_TIMEOUT_MS is not declared").toBeDefined();
        expect(requestTimeout!).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MSEC);
        expect(requestTimeout!).toBeGreaterThanOrEqual(
          OBSERVED_WORST_CASE_CONJURE_MS * REQUIRED_MARGIN_MULTIPLIER,
        );
      });

      // AC3 — vitest must not be the binding constraint, or a hung call gets
      // killed by the runner before the SDK can report a clean MCP error.
      it("gives the test a larger budget than the request timeout, and stays under the CI cap", () => {
        const source = sourceOf(file);
        const requestTimeout = numericConst(source, "LIVE_CONJURE_TIMEOUT_MS");
        const testBudget = numericConst(source, "LIVE_CHAIN_TEST_TIMEOUT_MS");
        expect(testBudget, "LIVE_CHAIN_TEST_TIMEOUT_MS is not declared").toBeDefined();
        expect(testBudget!).toBeGreaterThan(requestTimeout!);
        expect(testBudget!).toBeLessThan(CI_JOB_CEILING_MS);
      });

      // The constant is only meaningful if the test actually runs under it.
      // Matched in argument position (`, LIVE_..._MS,` or `, LIVE_..._MS)`) so
      // both the trailing-comma and inline `}, TIMEOUT);` call styles qualify.
      it("applies that budget as the live test's vitest timeout argument", () => {
        const source = sourceOf(file);
        const liveBlock = source.slice(source.indexOf(liveTestMarker));
        expect(liveBlock).toMatch(/LIVE_CHAIN_TEST_TIMEOUT_MS\s*[,)]/);
      });

      // AC1 proves the caller's INTENT. This proves the request BOUNDARY: that
      // the timeout actually lands in `callTool`'s third argument, including
      // across any wrapper sitting between the two. Without it, a wrapper that
      // stopped forwarding `options` would silently restore the 60s default
      // while every other assertion in this file still passed.
      it("lands that timeout in callTool's third argument, through any wrapper", () => {
        const source = sourceOf(file);

        if (wrapperForwarding) {
          const wrapperAt = source.indexOf(wrapperForwarding.marker);
          expect(
            wrapperAt,
            `wrapper marker not found: ${wrapperForwarding.marker}`,
          ).toBeGreaterThan(-1);
          expect(
            source.slice(wrapperAt, wrapperAt + 400),
            "the wrapper must forward `options` as callTool's third argument",
          ).toMatch(wrapperForwarding.pattern);
          return;
        }

        // No wrapper declared, so the live call site must itself be the direct
        // caller — the timeout immediately following the result schema. This
        // also fails if a wrapper is introduced without registering it above.
        const callSite = liveConjureCallSite(source, liveTestMarker, conjureCallMarker);
        expect(callSite).toMatch(
          /CallToolResultSchema\s*,\s*\{\s*timeout:\s*LIVE_CONJURE_TIMEOUT_MS\s*,?\s*\}/,
        );
      });
    },
  );
});
