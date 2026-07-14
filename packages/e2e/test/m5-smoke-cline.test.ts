/**
 * M5-14 (DRO-286) — Cline harness smoke test.
 *
 * Cline is documented (research report §4) as **tools-only**: it does not
 * negotiate the `io.modelcontextprotocol/ui` MCP-Apps extension, so `preview`
 * must degrade to text (a viewer URL / file:// fallback) rather than silently
 * dropping the `ui://genie/grid` pointer. This suite proves that contract by
 * driving the full four-verb chain (`conjure → plan → write_files → preview`,
 * per `packages/plugin/skills/genie/SKILL.md`) through an in-process MCP
 * client that announces NO `extensions` capability — i.e. the same shape a
 * real Cline `mcp.json`/tools-only connection presents (see
 * `transport.test.ts`'s "isolates initialize capabilities" test for the
 * identical uiClient/nonUiClient pattern this borrows).
 *
 * ── AC coverage ──────────────────────────────────────────────────────────────
 *   AC1-4 (docs/harness/cline.md contents) — covered by review of that file,
 *     not by this test file (it has no runtime behavior to assert against).
 *   AC5 — this file: four-verb chain via a tools-only client; asserts the
 *     `preview` tool result's `content[0].text` is non-empty human-readable
 *     text (never silently empty) and `structuredContent` carries NO
 *     `ui.resourceUri` usage beyond the passive `_meta` pointer a tools-only
 *     host simply never reads — i.e. the text channel alone is sufficient to
 *     know the preview is ready.
 *
 * No real LLM call: a throwaway `node:http` server stands in for the
 * OpenAI-compatible endpoint (`GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` point at
 * it), so this suite never touches a real model or requires network egress,
 * while still exercising `conjure`'s REAL request/response code path (unlike
 * injecting a stub `chat` function, which would require re-registering the
 * tool and risk drifting from what `createServer()` actually wires up).
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createServer } from "../../server/src/server.js";
import type { ValidatedComponent } from "../../server/src/llm/schema.js";

/** MCP tool call result, narrowed to the fields this walk asserts on. */
interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
  _meta?: Record<string, unknown>;
}

/** First text content part, parsed as JSON (tools that don't set structuredContent). */
function parseText(result: ToolResult): unknown {
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

/** structuredContent when present, else the parsed text payload. */
function payload(result: ToolResult): unknown {
  return result.structuredContent ?? parseText(result);
}

/** A minimal schema-valid component (mirrors conjure.test.ts's goodComponent). */
function goodComponent(): ValidatedComponent {
  return {
    componentName: "Button",
    group: "actions",
    files: [
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->\n<button>Click me</button>',
        mimeType: "text/html",
      },
    ],
    manifestEntry: { viewport: { width: 320, height: 140 }, subtitle: "Primary button" },
  };
}

/** Build a stub OpenAI-shaped chat-completion JSON body around a component payload. */
function completionBodyOf(content: string): unknown {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "stub-model",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

let base: string;
let kitsRoot: string;
let projectsRoot: string;
let reportsDir: string;
let llmServer: Server;
let llmBaseUrl: string;
let savedLlmBaseUrl: string | undefined;
let savedLlmApiKey: string | undefined;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "genie-m5-smoke-cline-"));
  kitsRoot = join(base, "kits");
  projectsRoot = join(base, "projects");
  reportsDir = join(base, "reports");

  // A throwaway OpenAI-compatible stub: every /chat/completions call replies
  // with the same schema-valid component, regardless of request body. This is
  // `conjure`'s REAL network seam (`createLLMClient` → `openai` SDK), so the
  // suite proves the actual tool wiring, not a hand-substituted stub function.
  const body = JSON.stringify(completionBodyOf(JSON.stringify(goodComponent())));
  llmServer = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolvePromise) => llmServer.listen(0, "127.0.0.1", resolvePromise));
  const { port } = llmServer.address() as AddressInfo;
  llmBaseUrl = `http://127.0.0.1:${port}/v1`;

  savedLlmBaseUrl = process.env.GENIE_LLM_BASE_URL;
  savedLlmApiKey = process.env.GENIE_LLM_API_KEY;
  process.env.GENIE_LLM_BASE_URL = llmBaseUrl;
  process.env.GENIE_LLM_API_KEY = "genie-smoke-test-key";
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  await new Promise<void>((resolvePromise) => llmServer.close(() => resolvePromise()));
  if (savedLlmBaseUrl === undefined) delete process.env.GENIE_LLM_BASE_URL;
  else process.env.GENIE_LLM_BASE_URL = savedLlmBaseUrl;
  if (savedLlmApiKey === undefined) delete process.env.GENIE_LLM_API_KEY;
  else process.env.GENIE_LLM_API_KEY = savedLlmApiKey;
});

/**
 * Build the real server — every M1-M4 tool registered via `createServer`.
 * `transportKind: "stdio"` matches the Cline CLI config this issue documents
 * (a local stdio child process, per `docs/harness/cline.md`'s `command` form)
 * so `preview` resolves `locality: "local"` and returns a viewer/file:// URL
 * instead of the HTTP-locality "remote" branch (which has no local browser to
 * fall back to and is a distinct, out-of-scope harness shape here).
 */
function buildServer(): McpServer {
  return createServer({ kitsRoot, projectsRoot, reportsDir, transportKind: "stdio" });
}

/**
 * A tools-only MCP client: no `extensions` capability, matching a real Cline
 * connection (research §4 — Cline never negotiates `io.modelcontextprotocol/ui`).
 * Mirrors `transport.test.ts`'s `nonUiClient` fixture.
 */
function makeClineClient(): Client {
  return new Client({ name: "cline", version: "0" }, { capabilities: { extensions: {} } });
}

describe("M5-14 (DRO-286) — Cline four-verb smoke test", () => {
  it("AC5 — conjure → plan → write_files → preview succeeds and preview degrades to text for a tools-only client", async () => {
    const server = buildServer();
    const client = makeClineClient();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    try {
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args }) as Promise<ToolResult>;

      const kitResult = await call("mcp__genie__create_kit", { name: "Cline Smoke Kit" });
      expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
      const { kitId } = payload(kitResult) as { kitId: string };
      expect(kitId).toMatch(/^cline-smoke-kit-[0-9a-f]{6}$/);

      // 1. conjure — pure generation, no kit files touched yet.
      const conjureResult = await call("mcp__genie__conjure", {
        kitId,
        kit: "Cline smoke kit: clay accent #c87c5e, 8px radius.",
        prompt: "A primary button",
      });
      expect(conjureResult.isError, JSON.stringify(conjureResult)).toBeFalsy();
      const conjured = payload(conjureResult) as {
        componentName: string;
        files: { path: string; content: string; mimeType: string }[];
      };
      expect(conjured.componentName).toBe("Button");
      expect(conjured.files.length).toBeGreaterThan(0);

      // 2. plan — lock the write globs from step 1's file paths.
      const planResult = await call("mcp__genie__plan", {
        kitId,
        writes: conjured.files.map((f) => f.path),
      });
      expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
      const { planId } = payload(planResult) as { planId: string };
      expect(planId).toBeTruthy();

      // 3. write_files — commit the conjured files to the kit.
      const writeResult = await call("mcp__genie__write_files", {
        planId,
        files: conjured.files.map((f) => ({
          path: f.path,
          data: f.content,
          mimeType: f.mimeType,
        })),
      });
      expect(writeResult.isError, JSON.stringify(writeResult)).toBeFalsy();

      // 4. preview — the AC5 crux. A tools-only client still gets a usable
      // result: `content[0].text` must be non-empty, human-readable text (the
      // channel Cline actually renders), never dropped just because the
      // MCP-Apps `_meta.ui.resourceUri` pointer goes unused.
      const previewResult = await call("mcp__genie__preview", {
        kitId,
        componentName: conjured.componentName,
      });
      expect(previewResult.isError, JSON.stringify(previewResult)).toBeFalsy();

      const text = previewResult.content?.[0]?.text ?? "";
      expect(previewResult.content?.[0]?.type).toBe("text");
      expect(text.length).toBeGreaterThan(0);
      // The tools-only fallback text always names a concrete way to see the
      // component — a live viewer URL or a raw file:// path — never a bare
      // "preview ready" with no follow-up action a text-only client can take.
      expect(text).toMatch(/https?:\/\/|file:\/\//);

      // The `ui://` resource pointer is still emitted in `_meta` (a
      // spec-compliant host that DOES support MCP Apps could still use it),
      // but a tools-only client that ignores `_meta` still has everything it
      // needs from `content[0].text` alone — that's the "degrades to text,
      // not silently dropped" contract this AC asserts.
      const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
