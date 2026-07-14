/**
 * M5-09 (DRO-281) — Claude Code harness smoke test.
 *
 * Drives the documented four-verb chain (`conjure → write_files → preview →
 * validate`) exactly as `docs/harness/claude-code.md` tells a Claude Code user
 * to invoke genie's tools — `mcp__genie__<verb>` names, real MCP `tools/call`
 * request shape — and asserts every call returns non-error (AC5).
 *
 * NOTE on ordering: this is `write_files` BEFORE `preview`, not the other way
 * around. `preview` compiles the grid manifest from whatever the kit
 * directory holds on disk right now (`ensureManifest`/`compileManifest` in
 * `packages/server/src/manifest/`), so calling it before the conjured
 * component is persisted would serve a stale/empty grid — the smoke test
 * would "pass" without ever proving the new component is visible. This
 * matches the doc's own stated workflow ("`conjure → plan → write_files →
 * preview`", see `docs/harness/claude-code.md`'s "What you get here"
 * section), not a literal `conjure → preview → write_files` reading.
 *
 * ── What this file can and cannot prove in this environment ─────────────────
 * AC4/AC6/AC7 call for booting an actual Claude Code CLI inside a Docker
 * sandbox, installing the MCP server, and driving the chain through Claude's
 * own agent loop with screenshots. That requires a container runtime
 * (`docker`/`testcontainers`, the same gate `m1-conformance.test.ts`'s AC5 leg
 * and `gitea-conformance.test.ts` already use) AND the `claude` CLI baked into
 * the image. Neither this authoring sandbox nor a bare CI runner has a
 * container runtime by default, so — following the exact pattern this repo
 * already uses for Docker-gated suites — the full-harness leg below is
 * **skipped, not faked**, whenever no container runtime is reachable, with a
 * visible breadcrumb so a green run is never mistaken for "ran the real CLI".
 * `GENIE_REQUIRE_DOCKER=1` (CI's dedicated, manually-triggered `m5-smoke-
 * claude-code` job, AC7) makes that skip fail loudly instead.
 *
 * What DOES run unconditionally (no Docker, no Claude Code binary needed) is
 * the protocol-level proof: an in-process MCP client (SDK `InMemoryTransport`,
 * same harness `m1-conformance.test.ts` uses) calls the four tools by their
 * exact `mcp__genie__*` names in the documented order and asserts each
 * succeeds. This is the part of AC5 ("each tool call returns non-error") that
 * doesn't require a live Claude Code process to prove, and it is real
 * confidence: if the tool surface's request/response shape ever breaks the
 * chain the doc promises, this fails on every PR, Docker or not.
 *
 * The `conjure` step needs a real LLM endpoint (same M2-01 requirement
 * `m2-generation.test.ts` gates on) — this suite reuses that exact
 * `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` gate so it never spends real
 * dollars or fails on an unconfigured machine; it skips (with a breadcrumb)
 * rather than throwing when unset.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../../server/src/server.js";
import { CONJURE_TOOL_NAME } from "../../server/src/tools/conjure.js";
import { PREVIEW_TOOL_NAME } from "../../server/src/tools/preview.js";
import { WRITE_FILES_TOOL_NAME } from "../../server/src/tools/write_files.js";

const VALIDATE_TOOL_NAME = "mcp__genie__validate";
const CREATE_KIT_TOOL_NAME = "mcp__genie__create_kit";

// ── Gate 1: real LLM endpoint (conjure needs it) ─────────────────────────────
// Same env vars, same skip-not-throw contract as m2-generation.test.ts (AC2
// there). Re-declared as literals rather than imported so this file has no
// import-time dependency on the server's LLM client module construction.
const hasLlmConfig = Boolean(
  process.env["GENIE_LLM_BASE_URL"]?.trim() && process.env["GENIE_LLM_API_KEY"]?.trim(),
);
if (!hasLlmConfig) {
  console.info(
    "[m5-smoke-claude-code] GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is not set — " +
      "skipping the conjure→write_files→preview→validate protocol walk. Set both to a " +
      "real OpenAI-compatible endpoint to run this suite for real.",
  );
}
if (!hasLlmConfig && process.env["GENIE_REQUIRE_LLM"] === "1") {
  throw new Error(
    "GENIE_REQUIRE_LLM=1 but GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is missing/empty — " +
      "the m5-smoke-claude-code job must run this walk for real, not silently skip it.",
  );
}

// ── Gate 2: container runtime (full Claude-Code-CLI-in-Docker leg, AC4/6/7) ──
// Statically skipped in this authoring sandbox and any bare CI runner without
// Docker. `GENIE_REQUIRE_DOCKER=1` (set only by the dedicated, manually
// triggered CI job once it has confirmed a daemon is reachable — AC7) turns a
// regression into a hard failure instead of a silent, vacuous skip.
async function isDockerAvailable(): Promise<boolean> {
  if (process.env["GENIE_SKIP_DOCKER_TESTS"] === "1") return false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.info(
    "[m5-smoke-claude-code] no container runtime detected — skipping the full Claude Code " +
      "CLI-in-Docker leg (AC4/AC6/AC7: boot Claude Code, install genie, drive the chain through " +
      "Claude's own agent loop, capture screenshots). Provision Docker + the `claude` CLI in the " +
      "image to run it for real; CI's dedicated m5-smoke-claude-code job (manually triggered) " +
      "runs it.",
  );
}
if (!dockerAvailable && process.env["GENIE_REQUIRE_DOCKER"] === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but no container runtime is reachable — the m5-smoke-claude-code " +
      "CI job must run the real Claude-Code-in-Docker leg, not skip it.",
  );
}

// ── Harness (mirrors m1-conformance.test.ts) ─────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

function payload(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

describe.skipIf(!hasLlmConfig)(
  "M5-09 — conjure → write_files → preview → validate, exactly as documented for Claude Code",
  () => {
    let base: string;
    let client: Client;
    let close: () => Promise<void>;

    beforeAll(async () => {
      base = await mkdtemp(join(tmpdir(), "genie-m5-smoke-claude-code-"));
      const roots = {
        projectsRoot: join(base, "projects"),
        kitsRoot: join(base, "kits"),
        reportsDir: join(base, "reports"),
      };
      await mkdir(roots.kitsRoot, { recursive: true });
      const server = createServer(roots);
      client = new Client({ name: "m5-smoke-claude-code", version: "0" });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      close = async () => {
        await client.close();
      };
    }, 30_000);

    afterAll(async () => {
      await close?.();
      await rm(base, { recursive: true, force: true });
    });

    it("advertises the four documented verbs under their mcp__genie__ names (AC5 precondition)", async () => {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      for (const verb of [CONJURE_TOOL_NAME, PREVIEW_TOOL_NAME, WRITE_FILES_TOOL_NAME, VALIDATE_TOOL_NAME]) {
        expect(names, `expected ${verb} to be registered`).toContain(verb);
      }
    });

    it(
      "runs conjure → write_files → preview → validate and every call returns non-error (AC5)",
      async () => {
        // create_kit isn't one of the four AC-named verbs but is the
        // prerequisite every doc snippet assumes ("ask for a component" inside
        // an existing kit) — not itself asserted as a chain step.
        const createKit = await client.callTool({
          name: CREATE_KIT_TOOL_NAME,
          arguments: { name: "m5-smoke-claude-code" },
        });
        expect(createKit.isError, JSON.stringify(createKit)).toBeFalsy();
        const { kitId } = payload(createKit as ToolResult) as { kitId: string };

        // 1. conjure — generate one component against the real LLM endpoint.
        // `model` defaults to genie's own deployed alias ("design-default"),
        // resolved by that operator's litellm config — not guaranteed to
        // exist on every environment's gateway. Allow an explicit override
        // (GENIE_SMOKE_MODEL) so this suite proves the tool chain itself
        // rather than depending on one specific alias being provisioned.
        const model = process.env["GENIE_SMOKE_MODEL"]?.trim();
        const conjureResult = await client.callTool({
          name: CONJURE_TOOL_NAME,
          arguments: {
            kitId,
            kit: "Acme kit: clay accent #c87c5e, 8px radius, Inter type scale.",
            prompt: "A simple primary Button component with a label prop.",
            ...(model ? { model } : {}),
          },
        });
        expect(conjureResult.isError, JSON.stringify(conjureResult)).toBeFalsy();
        const conjured = payload(conjureResult as ToolResult) as {
          componentName: string;
          group: string;
          files: { path: string; content: string }[];
          manifestEntry: unknown;
        };
        expect(conjured.files.length).toBeGreaterThan(0);

        // 2. write_files — persist what conjure returned (requires a plan,
        // same MCP write-gate every write_files caller goes through). This
        // MUST run before `preview` — see the file header note on ordering.
        const plan = await client.callTool({
          name: "mcp__genie__plan",
          arguments: { kitId, writes: conjured.files.map((f) => f.path) },
        });
        expect(plan.isError, JSON.stringify(plan)).toBeFalsy();
        const { planId } = payload(plan as ToolResult) as { planId: string };

        const writeResult = await client.callTool({
          name: WRITE_FILES_TOOL_NAME,
          arguments: {
            kitId,
            planId,
            files: conjured.files.map((f) => ({ path: f.path, data: f.content })),
            manifestEntry: conjured.manifestEntry,
          },
        });
        expect(writeResult.isError, JSON.stringify(writeResult)).toBeFalsy();

        // 3. preview — compile + serve the grid; asserts a viewer URL or an
        // inline ui:// resource comes back, not that a browser renders it
        // (that's m4-viewer.test.ts's job).
        const previewResult = await client.callTool({
          name: PREVIEW_TOOL_NAME,
          arguments: { kitId },
        });
        expect(previewResult.isError, JSON.stringify(previewResult)).toBeFalsy();

        // 4. validate — full-scan facet over the kit that now has the
        // just-written component.
        const validateResult = await client.callTool({
          name: VALIDATE_TOOL_NAME,
          arguments: { kitId },
        });
        expect(validateResult.isError, JSON.stringify(validateResult)).toBeFalsy();
      },
      120_000,
    );
  },
);

// ── Full Claude-Code-in-Docker leg (AC4, AC6, AC7) ───────────────────────────
// Deliberately left as a named, skip-visible placeholder rather than a fake
// pass: actually booting Claude Code CLI in a Docker sandbox, wiring
// ~/.claude.json to a running genie HTTP server, and driving the four verbs
// through Claude's own agent loop (not an MCP SDK client standing in for it)
// needs an image with the `claude` binary and network egress to an LLM
// endpoint from inside the container — none of which this suite provisions
// today. Tracked as a follow-up rather than silently declared done; see the
// issue this file implements (DRO-281) for the acceptance-criteria checklist.
describe("AC4/AC6/AC7 — Claude Code CLI in Docker", () => {
  if (dockerAvailable) {
    it.todo(
      "boot Claude Code CLI in a Docker sandbox, install the genie MCP server, run the four-verb " +
        "chain through Claude's own agent loop, capture screenshots to docs/harness/screenshots/claude-code/ " +
        "(needs a Docker image with the `claude` CLI baked in — see DRO-281 follow-up)",
    );
  } else {
    // Not `it.todo` here on purpose: an unconditional `it.todo` silently
    // reports "todo" in the summary without ever printing *why* — a reader
    // skimming green/todo counts can mistake that for "not urgent" rather
    // than "AC4/AC6 are entirely unverified in this run". This test always
    // executes, always fails loudly if GENIE_REQUIRE_DOCKER=1, and otherwise
    // prints an explicit, greppable skip breadcrumb before marking itself
    // skipped so both the console output AND the test-runner summary flag it.
    it("SKIPPED: Docker/Claude CLI unavailable in this sandbox; AC4/AC6 not verified", (ctx) => {
      const message =
        "[m5-smoke-claude-code] SKIPPED: Docker/Claude CLI unavailable in this sandbox; " +
        "AC4/AC6 not verified. The full Claude-Code-CLI-in-Docker leg (boot Claude Code, " +
        "install the genie MCP server, drive the four-verb chain through Claude's own agent " +
        "loop, capture screenshots to docs/harness/screenshots/claude-code/) did NOT run. " +
        "Set GENIE_REQUIRE_DOCKER=1 once Docker + the `claude` CLI are provisioned to turn " +
        "this into a hard failure instead of a skip.";
      console.warn(message);
      (ctx.task.meta as Record<string, unknown>)["acStatus"] = "AC4/AC6 unverified — skipped (no Docker)";
      ctx.skip();
    });
  }
});
