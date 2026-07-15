/**
 * M5-13 (DRO-285) — Cursor harness smoke test.
 *
 * Cursor talks MCP over the same protocol every other harness uses (stdio /
 * Streamable HTTP via `@modelcontextprotocol/sdk`), so there is nothing
 * Cursor-specific to fake at the wire level — this suite launches genie's
 * REAL built server (`packages/server/dist/cli.js`) as a child process over
 * stdio, the exact transport Cursor's local `.cursor/mcp.json` `command`
 * entry launches (see `docs/harness/m5-11`'s Codex sibling suite for the same
 * pattern), and asserts the two things `docs/harness/cursor.md` documents as
 * executable claims:
 *
 *   AC3 — the four-verb chain (`conjure → plan → write_files → preview`) is
 *         reachable as ONE contiguous chain over real stdio and `preview`
 *         emits the `ui://genie/grid` resource pointer Cursor's inline Apps
 *         extension consumes. `conjure` requires `GENIE_LLM_*` (M2-01); this
 *         suite drives `plan → write_files → preview` directly (the three
 *         verbs that don't need an LLM call) unconditionally, and separately
 *         runs the FULL `conjure → plan → write_files → preview` chain over
 *         the same live stdio connection — carrying conjure's own generated
 *         files forward into plan/write_files/preview, not four isolated
 *         calls — whenever `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` are
 *         configured, plus an unconditional check that `conjure` fails
 *         closed with a typed error when no LLM endpoint is configured, so
 *         the chain's reachability is proven either way.
 *
 *   AC4 — the historical "Cursor caps tool lists at 40" claim (research §4/§8,
 *         unverified against current docs) is tested empirically here against
 *         genie's OWN server/SDK layer only: this suite spawns genie's real
 *         built server as a real stdio child process (a second one, alongside
 *         the AC3 connection) with 50+ additional dummy tools registered on
 *         that live instance via a test-only CLI env hook, then asserts
 *         `tools/list` returns ALL of them over that real stdio transport.
 *         This proves genie's server and the `@modelcontextprotocol/sdk`
 *         impose no cap and ship the full list for Cursor to choose from —
 *         it does NOT observe what Cursor's own client actually
 *         loads/displays, which can only be checked by a human tester inside
 *         a live Cursor session (see `docs/harness/cursor.md`'s finding
 *         section for the precise scope of this claim).
 *
 * AC1/AC2/AC5 (documenting the snippet's `auth` block, `env:` tokens, and the
 * static OAuth callback URL) are pure documentation — see `cursor.md` — and
 * have no executable surface: Cursor's OAuth exchange happens in Cursor's own
 * process, not genie's, so there is nothing here to drive live.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = resolve(here, "../../server/dist/cli.js");

const hasBuiltServer =
  spawnSync("node", ["-e", `require("node:fs").accessSync(${JSON.stringify(SERVER_CLI)})`])
    .status === 0;

const hasLlmEnv = Boolean(
  process.env.GENIE_LLM_BASE_URL?.trim() && process.env.GENIE_LLM_API_KEY?.trim(),
);

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
  _meta?: Record<string, unknown>;
}

function payload(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

describe.skipIf(!hasBuiltServer)(
  "AC3/AC4 — Cursor's real stdio transport: four-verb chain + tool-cap probe",
  () => {
    let client: Client;
    let kitsRoot: string;

    beforeAll(async () => {
      kitsRoot = await mkdtemp(join(tmpdir(), "genie-m5-cursor-kits-"));
      const transport = new StdioClientTransport({
        command: "node",
        args: [SERVER_CLI, "--transport", "stdio"],
        env: {
          ...(process.env as Record<string, string>),
          GENIE_KITS_ROOT: kitsRoot,
          // Required secret validation (packages/server/src/config/secrets.ts)
          // — unrelated to the MCP surface this smoke test exercises.
          // OAUTH_HS256_KEY always needs a throwaway value to boot; when a
          // real GENIE_LLM_API_KEY isn't already set (no live LLM leg), a
          // throwaway 16+ char value satisfies the same boot-time length
          // check without enabling real generation (the fail-closed test
          // below still exercises `conjure` failing on the invalid
          // base-URL/key pair, not on a missing-env crash before boot).
          OAUTH_HS256_KEY: "cursor-smoke-test-not-a-real-secret",
          // Deliberately leave GENIE_LLM_BASE_URL unset when no real endpoint
          // is configured, so the fail-closed test below exercises the actual
          // MissingLLMConfigError path (conjure.ts -> llm/client.ts
          // createLLMClient) rather than a connection/retry failure against a
          // fake dead port — a prior version pointed both vars at
          // http://127.0.0.1:1/v1, which made `conjure` fail on a transport
          // error instead of the advertised missing-config path (Copilot
          // review). GENIE_LLM_API_KEY still needs a throwaway value here:
          // it's in secrets.ts's *required-to-boot* list (unlike
          // GENIE_LLM_BASE_URL, which boot-time validation doesn't check), so
          // leaving it unset would crash the server before it even starts
          // serving MCP, rather than exercising conjure's own fail-closed path.
          ...(hasLlmEnv
            ? {}
            : {
                GENIE_LLM_API_KEY: "cursor-smoke-test-not-a-real-secret-key",
                GENIE_LLM_BASE_URL: "",
              }),
        },
      });
      client = new Client({ name: "m5-smoke-cursor", version: "0" });
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await rm(kitsRoot, { recursive: true, force: true });
    });

    describe("AC3 — Cursor's four-verb chain is reachable and preview emits ui://genie/grid", () => {
      it("plan -> write_files -> preview round-trips over real stdio and preview's _meta.ui.resourceUri points at ui://genie/grid", async () => {
        const kitResult = (await client.callTool({
          name: "mcp__genie__create_kit",
          arguments: { name: "Cursor Smoke Kit" },
        })) as ToolResult;
        expect(kitResult.isError, JSON.stringify(kitResult)).not.toBe(true);
        const kitId = (payload(kitResult) as { kitId: string }).kitId;
        expect(kitId).toMatch(/^[a-z0-9-]{3,64}$/);

        const kitDir = join(kitsRoot, kitId);
        const planResult = (await client.callTool({
          name: "mcp__genie__plan",
          arguments: { kitId, writes: ["components/hello.html"], deletes: [], localDir: kitDir },
        })) as ToolResult;
        expect(planResult.isError, JSON.stringify(planResult)).not.toBe(true);
        const planId = (payload(planResult) as { planId: string }).planId;
        expect(typeof planId).toBe("string");

        const writeResult = (await client.callTool({
          name: "mcp__genie__write_files",
          arguments: {
            planId,
            files: [
              {
                path: "components/hello.html",
                data: "<!doctype html><body>@genie-marker hello</body>",
              },
            ],
          },
        })) as ToolResult;
        expect(writeResult.isError, JSON.stringify(writeResult)).not.toBe(true);

        const previewResult = (await client.callTool({
          name: "mcp__genie__preview",
          arguments: { kitId },
        })) as ToolResult;
        expect(previewResult.isError, JSON.stringify(previewResult)).not.toBe(true);
        const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
        expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
        expect(meta?.ui?.resourceUri).toContain(`kitId=${kitId}`);
      });

      it("conjure is registered over real stdio and fails closed (typed error, no silent no-op) without GENIE_LLM_*", async () => {
        if (hasLlmEnv) {
          // This leg specifically asserts the fail-closed path; when an LLM
          // endpoint IS configured, the dedicated live-generation test below
          // covers `conjure` succeeding instead. Skip here to avoid asserting
          // a failure against a server that will legitimately succeed.
          return;
        }
        const { tools } = await client.listTools();
        expect(tools.some((t) => t.name === "mcp__genie__conjure")).toBe(true);

        const kitResult = (await client.callTool({
          name: "mcp__genie__create_kit",
          arguments: { name: "Cursor Smoke Fail-Closed Kit" },
        })) as ToolResult;
        expect(kitResult.isError, JSON.stringify(kitResult)).not.toBe(true);
        const kitId = (payload(kitResult) as { kitId: string }).kitId;

        const result = (await client.callTool({
          name: "mcp__genie__conjure",
          arguments: {
            kitId,
            kit: "A minimal UI kit. Uses semantic HTML and plain CSS.",
            prompt: "a button",
          },
        })) as ToolResult;
        // Missing LLM config must surface as a tool-level error identifying
        // the missing configuration (MissingLLMConfigError), not a silent
        // pass-through, a generic transport failure, or a crash of the MCP
        // connection itself.
        expect(result.isError).toBe(true);
        const errorText = result.content?.[0]?.text ?? "";
        expect(errorText).toMatch(/GENIE_LLM_BASE_URL|GENIE_LLM_API_KEY|Missing.*LLM/i);
      });

      it.skipIf(!hasLlmEnv)(
        "conjure -> plan -> write_files -> preview is one contiguous chain over real stdio when an LLM endpoint is configured (full chain incl. generation, preview emits ui://genie/grid)",
        async () => {
          const kitResult = (await client.callTool({
            name: "mcp__genie__create_kit",
            arguments: { name: "Cursor Smoke Conjure Kit" },
          })) as ToolResult;
          expect(kitResult.isError, JSON.stringify(kitResult)).not.toBe(true);
          const kitId = (payload(kitResult) as { kitId: string }).kitId;

          const conjureResult = (await client.callTool({
            name: "mcp__genie__conjure",
            arguments: {
              kitId,
              kit: "A minimal UI kit. Uses semantic HTML and plain CSS.",
              prompt: "a small button component",
            },
          })) as ToolResult;
          expect(conjureResult.isError, JSON.stringify(conjureResult)).not.toBe(true);
          // Shape per packages/server/src/tools/conjure.ts `conjureOutputShape`:
          // { componentName, group, files: [{path, content, mimeType, encoding}], manifestEntry, usage }.
          // Deliberately pure generation (no write) — plan/write_files below is
          // the caller's separate, plan-gated step, per the tool's own description.
          const conjured = payload(conjureResult) as {
            files: {
              path: string;
              content: string;
              mimeType: string;
              encoding: "utf-8" | "base64";
            }[];
          };
          expect(conjured.files.length).toBeGreaterThan(0);
          const writes = conjured.files.map((f) => f.path);

          // Carry the SAME kit/generation forward through plan -> write_files
          // -> preview so this is one contiguous chain, not four isolated
          // calls — the exact gap the changes-requested review flagged.
          const kitDir = join(kitsRoot, kitId);
          const planResult = (await client.callTool({
            name: "mcp__genie__plan",
            arguments: { kitId, writes, deletes: [], localDir: kitDir },
          })) as ToolResult;
          expect(planResult.isError, JSON.stringify(planResult)).not.toBe(true);
          const planId = (payload(planResult) as { planId: string }).planId;

          const writeResult = (await client.callTool({
            name: "mcp__genie__write_files",
            arguments: {
              planId,
              files: conjured.files.map((f) => ({
                path: f.path,
                data: f.content,
                mimeType: f.mimeType,
                encoding: f.encoding,
              })),
            },
          })) as ToolResult;
          expect(writeResult.isError, JSON.stringify(writeResult)).not.toBe(true);

          const previewResult = (await client.callTool({
            name: "mcp__genie__preview",
            arguments: { kitId },
          })) as ToolResult;
          expect(previewResult.isError, JSON.stringify(previewResult)).not.toBe(true);
          const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
          expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
          expect(meta?.ui?.resourceUri).toContain(`kitId=${kitId}`);
        },
        180_000,
      );
    });

    describe("AC4 — tool-cap probe (genie/SDK server-side only): does anything server-side truncate tools/list at 40?", () => {
      it("registers 50+ dummy tools on the real server over the real stdio child-process transport and tools/list returns every one of them", async () => {
        // Reviewer feedback (changes-requested): the previous version of this
        // probe used InMemoryTransport while cursor.md claimed real stdio.
        // This version spawns the SAME built server binary Cursor's local
        // `.cursor/mcp.json` `command` entry launches, over a real stdio
        // child process, with `GENIE_TEST_EXTRA_TOOLS` set — a dedicated
        // test-only CLI hook (packages/server/src/cli.ts) that registers N
        // no-op tools on that exact live server instance before it starts
        // serving `tools/list`. This is real stdio end to end, matching the
        // doc's transport claim.
        const DUMMY_TOOL_COUNT = 55;
        const base = await mkdtemp(join(tmpdir(), "genie-m5-cursor-toolcap-"));

        const baselineTransport = new StdioClientTransport({
          command: "node",
          args: [SERVER_CLI, "--transport", "stdio"],
          env: {
            ...(process.env as Record<string, string>),
            GENIE_KITS_ROOT: join(base, "kits-baseline"),
            OAUTH_HS256_KEY: "cursor-smoke-test-not-a-real-secret",
            GENIE_LLM_API_KEY: "cursor-smoke-test-not-a-real-secret-key",
            GENIE_LLM_BASE_URL: "http://127.0.0.1:1/v1",
          },
        });
        const baselineClient = new Client({ name: "m5-smoke-cursor-baseline", version: "0" });
        await baselineClient.connect(baselineTransport);
        const { tools: baselineTools } = await baselineClient.listTools();
        const realToolCount = baselineTools.length;
        await baselineClient.close();
        expect(realToolCount).toBeGreaterThan(0);

        const probeTransport = new StdioClientTransport({
          command: "node",
          args: [SERVER_CLI, "--transport", "stdio"],
          env: {
            ...(process.env as Record<string, string>),
            GENIE_KITS_ROOT: join(base, "kits-probe"),
            OAUTH_HS256_KEY: "cursor-smoke-test-not-a-real-secret",
            GENIE_LLM_API_KEY: "cursor-smoke-test-not-a-real-secret-key",
            GENIE_LLM_BASE_URL: "http://127.0.0.1:1/v1",
            GENIE_TEST_EXTRA_TOOLS: String(DUMMY_TOOL_COUNT),
          },
        });
        const probeClient = new Client({ name: "m5-smoke-cursor-toolcap", version: "0" });
        try {
          await probeClient.connect(probeTransport);
          const { tools } = await probeClient.listTools();
          const dummyNames = tools.filter((t) => t.name.startsWith("dummy_tool_"));

          // Empirical finding (AC4, server-side scope): the MCP SDK / genie
          // server impose no server-side cap. All registered tools — real +
          // dummy — are returned by tools/list over real stdio. This does
          // NOT prove or disprove what Cursor's own client actually
          // loads/displays; if Cursor still limits the displayed/attached
          // tool count today, that enforcement is entirely CLIENT-side
          // inside Cursor itself — not something genie can detect,
          // influence, or test from the server. Ship your full tool
          // surface; if Cursor only exposes a subset to the model, that's
          // Cursor's own selection policy, observable only by a human
          // tester inside an actual Cursor session (file a follow-up
          // against Cursor's own docs/support if a live cap is reproduced
          // that way).
          expect(dummyNames).toHaveLength(DUMMY_TOOL_COUNT);
          expect(tools.length).toBe(realToolCount + DUMMY_TOOL_COUNT);
          expect(tools.length).toBeGreaterThan(40);
        } finally {
          await probeClient.close();
          await rm(base, { recursive: true, force: true });
        }
      });
    });
  },
);
