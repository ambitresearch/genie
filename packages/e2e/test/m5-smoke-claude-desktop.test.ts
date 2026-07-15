/**
 * M5-10 (DRO-282) — Claude Desktop harness smoke test.
 *
 * Claude Desktop cannot be driven headlessly in this (or any) CI environment
 * — it is a native desktop GUI app with no scriptable automation surface,
 * and AC6's literal ask ("installs the .mcpb, opens Claude Desktop, fires
 * list_kits, captures screenshot") requires a human tester operating the
 * actual application. That manual verification is out of scope for an
 * automated suite and is called out explicitly in
 * `docs/harness/claude-desktop.md`'s review notes / PR description — it is
 * NOT something this file claims to cover.
 *
 * What Claude Desktop's stdio `mcpServers` entry (the manual JSON snippet
 * documented in claude-desktop.md, and what the `.mcpb` bundle wraps once
 * M5-05 ships) actually invokes is genie's REAL built server
 * (`packages/server/dist/cli.js --transport stdio`) as a child process over
 * stdio — the exact transport every other harness in this repo's smoke
 * suite already exercises (see `m5-smoke-cursor.test.ts`, `m5-smoke-codex.test.ts`).
 * There is nothing Claude-Desktop-specific about the wire protocol: this
 * suite proves the SAME executable claim those suites do — the four-verb
 * chain is reachable over real stdio and `preview` emits the `ui://genie/grid`
 * resource pointer Claude Desktop's inline Apps rendering consumes — which is
 * the full extent of what's verifiable from genie's side of this harness.
 *
 *   AC1/AC2/AC3/AC5 (documenting the snippet, Linux non-support, the
 *   `~/Library/Logs/Claude/mcp*.log` debugging path, and `.mcpb`-first
 *   install ordering) are pure documentation claims — see
 *   claude-desktop.md — with no executable surface on genie's side.
 *
 *   AC4 (`mcp-remote` bridge pattern) is also documentation: `mcp-remote` is
 *   a third-party npm package Claude Desktop launches in place of genie's
 *   own CLI; genie's server is unaware of it and there is nothing to test
 *   here beyond the doc snippet.
 *
 *   AC6's executable portion, covered below: genie's real stdio server
 *   completes the full `create_kit -> plan -> write_files -> preview` chain
 *   (the same operations a Claude Desktop user would drive by typing a
 *   request) and preview's `_meta.ui.resourceUri` points at
 *   `ui://genie/grid`, exactly like Claude Desktop's own inline rendering
 *   would consume. `conjure`'s fail-closed behavior without `GENIE_LLM_*` is
 *   also exercised, since `list_kits`/`create_kit` etc. are always available
 *   regardless of LLM configuration. Actually launching the Claude Desktop
 *   app, installing a `.mcpb`, and capturing a screenshot remain a human
 *   tester's job — flag that explicitly rather than fake it here.
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
  "AC6 — Claude Desktop's real stdio transport: four-verb chain reachable, preview emits ui://genie/grid",
  () => {
    let client: Client;
    let kitsRoot: string;

    beforeAll(async () => {
      kitsRoot = await mkdtemp(join(tmpdir(), "genie-m5-claude-desktop-kits-"));
      const transport = new StdioClientTransport({
        command: "node",
        args: [SERVER_CLI, "--transport", "stdio"],
        env: {
          ...(process.env as Record<string, string>),
          GENIE_KITS_ROOT: kitsRoot,
          // Required secret validation (packages/server/src/config/secrets.ts)
          // — unrelated to the MCP surface this smoke test exercises.
          OAUTH_HS256_KEY: "claude-desktop-smoke-test-not-a-real-secret",
          ...(hasLlmEnv
            ? {}
            : {
                GENIE_LLM_API_KEY: "claude-desktop-smoke-test-not-a-real-secret-key",
                GENIE_LLM_BASE_URL: "http://127.0.0.1:1/v1",
              }),
        },
      });
      client = new Client({ name: "m5-smoke-claude-desktop", version: "0" });
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await rm(kitsRoot, { recursive: true, force: true });
    });

    it("create_kit -> plan -> write_files -> preview round-trips over real stdio and preview's _meta.ui.resourceUri points at ui://genie/grid", async () => {
      const kitResult = (await client.callTool({
        name: "mcp__genie__create_kit",
        arguments: { name: "Claude Desktop Smoke Kit" },
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

    it("list_kits is reachable over real stdio and reflects a kit created earlier in this chain (proxy for AC6's `list_kits` claim without a live Desktop UI)", async () => {
      const kitResult = (await client.callTool({
        name: "mcp__genie__create_kit",
        arguments: { name: "Claude Desktop list_kits Probe Kit" },
      })) as ToolResult;
      expect(kitResult.isError, JSON.stringify(kitResult)).not.toBe(true);
      const kitId = (payload(kitResult) as { kitId: string }).kitId;

      const listResult = (await client.callTool({
        name: "mcp__genie__list_kits",
        arguments: {},
      })) as ToolResult;
      expect(listResult.isError, JSON.stringify(listResult)).not.toBe(true);
      const listed = payload(listResult) as { kits: { id: string }[] };
      expect(listed.kits.some((k) => k.id === kitId)).toBe(true);
    });

    it("conjure is registered over real stdio and fails closed (typed error, no silent no-op) without GENIE_LLM_*", async () => {
      if (hasLlmEnv) {
        return;
      }
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "mcp__genie__conjure")).toBe(true);

      const result = (await client.callTool({
        name: "mcp__genie__conjure",
        arguments: { prompt: "a button" },
      })) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it.skipIf(!hasLlmEnv)(
      "conjure -> plan -> write_files -> preview is one contiguous chain over real stdio when an LLM endpoint is configured",
      async () => {
        const kitResult = (await client.callTool({
          name: "mcp__genie__create_kit",
          arguments: { name: "Claude Desktop Smoke Conjure Kit" },
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
  },
);
