/**
 * M5-09 (DRO-281) — Claude Code harness smoke test.
 *
 * Drives the documented four-verb chain (`conjure → write_files → preview →
 * validate`) exactly as `docs/harness/claude-code.md` tells a Claude Code user
 * to invoke genie's tools — `mcp__genie__<verb>` names, real MCP `tools/call`
 * request shape — and asserts every call returns non-error (AC5).
 *
 * NOTE on ordering: the issue and harness doc now specify `write_files` BEFORE
 * `preview`. `preview` compiles the grid manifest from whatever the kit
 * directory holds on disk right now (`ensureManifest`/`compileManifest` in
 * `packages/server/src/manifest/`), so calling it before the conjured
 * component is persisted would serve a stale/empty grid — the smoke test
 * would "pass" without ever proving the new component is visible. This
 * matches the doc's own stated workflow ("`conjure → plan → write_files →
 * preview`", see `docs/harness/claude-code.md`'s "What you get here"
 * section).
 *
 * ── What this file can and cannot prove in this environment ─────────────────
 * AC4/AC6/AC7 call for booting an actual Claude Code CLI inside a Docker
 * sandbox, connecting it to a real host-owned genie HTTP server, and driving
 * the chain through Claude's own agent loop with screenshots. That requires a
 * container runtime
 * (`docker`/`testcontainers`, the same gate `m1-conformance.test.ts`'s AC5 leg
 * and `gitea-conformance.test.ts` already use) and an authenticated `claude`
 * CLI baked into the image. Following the pattern this repo already uses for
 * Docker-gated suites, the full-harness leg below is
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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer as createNodeHttpServer, type Server as NodeHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GenericContainer as GenericContainerType } from "testcontainers";

import { createServer } from "../../server/src/server.js";
import { createStreamableHttpRequestHandler } from "../../server/src/transport.js";
import { CONJURE_TOOL_NAME } from "../../server/src/tools/conjure.js";
import { PREVIEW_TOOL_NAME } from "../../server/src/tools/preview.js";
import { WRITE_FILES_TOOL_NAME } from "../../server/src/tools/write_files.js";
import { isDockerAvailable as isTestcontainersDockerAvailable } from "./support/gitea-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_KEY_HELPER = join(HERE, "../../../docs/harness/scripts/anthropic-api-key-helper.sh");

const VALIDATE_TOOL_NAME = "mcp__genie__validate";
const CREATE_KIT_TOOL_NAME = "mcp__genie__create_kit";

// Claude Code namespaces every MCP tool with its configured server name. Genie
// already uses the protocol-level mcp__genie__<verb> names, so a server named
// `genie` exposes them to Claude's agent loop with one additional prefix.
function claudeCodeToolName(protocolToolName: string): string {
  return `mcp__genie__${protocolToolName}`;
}

async function listen(server: NodeHttpServer, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return address.port;
}

async function closeHttpServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// ── Gate 1: real LLM endpoint (conjure needs it) ─────────────────────────────
// Same env vars, same skip-not-throw contract as m2-generation.test.ts (AC2
// there). Re-declared as literals rather than imported so this file has no
// import-time dependency on the server's LLM client module construction.
const hasLlmConfig = Boolean(
  process.env["GENIE_LLM_BASE_URL"]?.trim() && process.env["GENIE_LLM_API_KEY"]?.trim(),
);
const smokeModel = process.env["GENIE_SMOKE_MODEL"]?.trim();
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
if (hasLlmConfig && !smokeModel && process.env["GENIE_REQUIRE_LLM"] === "1") {
  throw new Error(
    "GENIE_REQUIRE_LLM=1 but GENIE_SMOKE_MODEL is missing/empty — the manual harness smoke " +
      "must name a structured-output model exposed by its configured endpoint.",
  );
}

// ── Gate 2: container runtime (full Claude-Code-CLI-in-Docker leg, AC4/6/7) ──
// Statically skipped in this authoring sandbox and any bare CI runner without
// Docker. `GENIE_REQUIRE_DOCKER=1` (set only by the dedicated, manually
// triggered CI job once it has confirmed a daemon is reachable — AC7) turns a
// regression into a hard failure instead of a silent, vacuous skip.
//
// Uses the exact same testcontainers runtime resolver as
// `gitea-conformance.test.ts` (via `support/gitea-fixture.ts`'s
// `isDockerAvailable`), rather than a hand-rolled `docker info` shellout, so
// this leg's Docker-presence check matches the one testcontainers itself
// will use to actually boot the container.
const dockerAvailable = await isTestcontainersDockerAvailable();
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

// ── Gate 3: a model credential for the Claude Code CLI itself ───────────────
// Distinct from GENIE_LLM_API_KEY (gate 1): that key is genie's *own*
// OpenAI-compatible generation endpoint used by `conjure`; this key
// (`GENIE_ANTHROPIC_SMOKE_API_KEY`) is what the containerized `claude` CLI
// authenticates with to run its own agent loop. By default it calls Anthropic;
// GENIE_ANTHROPIC_SMOKE_BASE_URL may point it at a compatible gateway. Without
// the key the CLI cannot make any model calls, so this leg must also skip
// (loudly) rather than fail with a confusing auth error.
const hasAnthropicSmokeKey = Boolean(process.env["GENIE_ANTHROPIC_SMOKE_API_KEY"]?.trim());
if (dockerAvailable && !hasAnthropicSmokeKey) {
  console.info(
    "[m5-smoke-claude-code] GENIE_ANTHROPIC_SMOKE_API_KEY is not set — skipping the full " +
      "Claude Code CLI-in-Docker leg even though Docker is available. Set it to a model " +
      "credential (used only inside the throwaway container) to run this leg for real.",
  );
}
if (dockerAvailable && !hasAnthropicSmokeKey && process.env["GENIE_REQUIRE_DOCKER"] === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but GENIE_ANTHROPIC_SMOKE_API_KEY is missing/empty — the " +
      "m5-smoke-claude-code CI job must run the real Claude-Code-in-Docker leg, not skip it.",
  );
}
const runFullDockerLeg = dockerAvailable && hasAnthropicSmokeKey && hasLlmConfig;

// ── Harness (mirrors m1-conformance.test.ts) ─────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

interface ClaudeStreamEvent {
  type?: string;
  message?: { content?: unknown[] };
  [key: string]: unknown;
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function payload(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

function parseClaudeStream(stdout: string): ClaudeStreamEvent[] {
  const events: ClaudeStreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ClaudeStreamEvent);
    } catch {
      throw new Error(
        `Claude Code container emitted a non-JSON line on stdout (expected NDJSON from ` +
          `--output-format stream-json); offending line:\n${trimmed}\n\nfull output:\n${stdout}`,
      );
    }
  }
  return events;
}

function collectClaudeToolResults(events: ClaudeStreamEvent[]): {
  calledToolNames: string[];
  toolResultsByName: Map<string, ClaudeContentBlock[]>;
  terminalResult?: Record<string, unknown>;
} {
  const toolUseIdToName = new Map<string, string>();
  const calledToolNames: string[] = [];
  const toolResultsByName = new Map<string, ClaudeContentBlock[]>();
  let terminalResult: Record<string, unknown> | undefined;

  for (const event of events) {
    if (event.type === "result") terminalResult = event;
    const blocks = (event.message?.content ?? []) as ClaudeContentBlock[];
    for (const block of blocks) {
      if (block.type === "tool_use" && block.id && block.name) {
        toolUseIdToName.set(block.id, block.name);
        calledToolNames.push(block.name);
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const name = toolUseIdToName.get(block.tool_use_id);
        if (name) {
          const list = toolResultsByName.get(name) ?? [];
          list.push(block);
          toolResultsByName.set(name, list);
        }
      }
    }
  }
  return { calledToolNames, toolResultsByName, terminalResult };
}

function extractPreviewUrl(result: ClaudeContentBlock | undefined): string | undefined {
  if (!result) return undefined;
  const contentBlocks = Array.isArray(result.content)
    ? result.content
    : typeof result.content === "string"
      ? [{ type: "text", text: result.content }]
      : [];
  for (const content of contentBlocks as { type?: string; text?: string }[]) {
    if (content.type === "text" && content.text) {
      try {
        const parsed = JSON.parse(content.text) as { url?: string; viewerUrl?: string };
        if (parsed.url) return parsed.url;
        if (parsed.viewerUrl) return parsed.viewerUrl;
      } catch {
        const match = content.text.match(/https?:\/\/\S+/);
        if (match) return match[0];
      }
    }
  }
  return undefined;
}

describe("Claude Code stream-json transcript parsing", () => {
  it("correlates Claude's namespaced wrapper with genie's protocol-level tool name", () => {
    const name = claudeCodeToolName(PREVIEW_TOOL_NAME);
    const events = parseClaudeStream(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-1", name, input: {} }] },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  { type: "text", text: JSON.stringify({ viewerUrl: "http://127.0.0.1" }) },
                ],
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const { calledToolNames, toolResultsByName } = collectClaudeToolResults(events);
    expect(calledToolNames).toEqual(["mcp__genie__mcp__genie__preview"]);
    expect(extractPreviewUrl(toolResultsByName.get(name)?.[0])).toBe("http://127.0.0.1");
  });

  it("extracts viewerUrl from Claude Code's string-valued MCP tool result", () => {
    expect(
      extractPreviewUrl({
        type: "tool_result",
        content: JSON.stringify({ viewerUrl: "http://127.0.0.1:5173/" }),
      }),
    ).toBe("http://127.0.0.1:5173/");
  });

  it("preserves tool-use order while correlating results", () => {
    const names = [CONJURE_TOOL_NAME, WRITE_FILES_TOOL_NAME, PREVIEW_TOOL_NAME].map(
      claudeCodeToolName,
    );
    const events = parseClaudeStream(
      names
        .flatMap((name, index) => [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: `tool-${index}`, name }] },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: "{}" }],
            },
          }),
        ])
        .join("\n"),
    );

    expect(collectClaudeToolResults(events).calledToolNames).toEqual(names);
  });

  it("rejects non-JSON stdout instead of treating a CLI error as a transcript", () => {
    expect(() => parseClaudeStream("claude: authentication failed\n")).toThrow(
      /non-JSON line.*authentication failed/s,
    );
  });
});

it("the executable apiKeyHelper falls through failed keychain clients to the env", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "genie-api-key-helper-bin-"));
  try {
    for (const command of ["security", "op"]) {
      const stub = join(binDir, command);
      await writeFile(stub, "#!/bin/sh\nexit 1\n");
      await chmod(stub, 0o755);
    }

    const result = spawnSync(API_KEY_HELPER, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "env-fallback-token",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("env-fallback-token");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

it("returns a reachable viewer URL for explicit local preview over HTTP", async () => {
  const base = await mkdtemp(join(tmpdir(), "genie-m5-local-http-preview-"));
  const kitsRoot = join(base, "kits");
  const kitId = "m5-local-preview";
  const componentDir = join(kitsRoot, kitId, "components", "actions", "Button");
  await mkdir(componentDir, { recursive: true });
  await writeFile(
    join(componentDir, "Button.html"),
    '<!-- @genie group="actions" viewport="320x180" name="Button" -->\n' +
      "<!doctype html><html><body><button>Preview works</button></body></html>\n",
  );

  const viewerHttp = createNodeHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>reachable viewer</title><p>Preview works</p>");
  });
  const viewerPort = await listen(viewerHttp);
  const viewerUrl = `http://127.0.0.1:${viewerPort}/`;
  const closeViewer = () => closeHttpServer(viewerHttp);

  const mcpHttp = createNodeHttpServer(
    createStreamableHttpRequestHandler(() =>
      createServer({
        projectsRoot: join(base, "projects"),
        kitsRoot,
        reportsDir: join(base, "reports"),
        transportKind: "http",
        previewLocality: "local",
        previewBooter: async () => ({
          url: viewerUrl,
          port: viewerPort,
          open: async () => {},
          close: closeViewer,
        }),
      }),
    ),
  );
  const mcpPort = await listen(mcpHttp);
  const client = new Client({ name: "m5-local-http-preview", version: "0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)),
    );
    const result = (await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId },
    })) as ToolResult;
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      viewerUrl,
      transportKind: "http",
      locality: "local",
    });

    const response = await fetch(viewerUrl);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Preview works");
  } finally {
    await client.close().catch(() => {});
    await closeHttpServer(mcpHttp);
    await closeViewer();
    await rm(base, { recursive: true, force: true });
  }
});

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
      for (const verb of [
        CONJURE_TOOL_NAME,
        PREVIEW_TOOL_NAME,
        WRITE_FILES_TOOL_NAME,
        VALIDATE_TOOL_NAME,
      ]) {
        expect(names, `expected ${verb} to be registered`).toContain(verb);
      }
    });

    it("runs conjure → write_files → preview → validate and every call returns non-error (AC5)", async () => {
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
      const conjureResult = await client.callTool({
        name: CONJURE_TOOL_NAME,
        arguments: {
          kitId,
          kit: "Acme kit: clay accent #c87c5e, 8px radius, Inter type scale.",
          prompt: "A simple primary Button component with a label prop.",
          ...(smokeModel ? { model: smokeModel } : {}),
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
    }, 120_000);
  },
);

// ── Full Claude-Code-in-Docker leg (AC4, AC6, AC7) ───────────────────────────
// Boots the real `claude` CLI (packages/e2e/docker/claude-code-smoke/Dockerfile)
// against a genie HTTP server started in this process, drives the documented
// four-verb chain through Claude's own agent loop (not the MCP SDK client
// above), and captures a screenshot of the rendered preview grid. Gated on
// `runFullDockerLeg` (Gate 2 + Gate 3 above: Docker reachable, a real model
// credential for the containerized `claude` CLI, and a real genie LLM endpoint
// for `conjure`).
const anthropicSmokeKey = process.env["GENIE_ANTHROPIC_SMOKE_API_KEY"]?.trim();

describe("AC4/AC6/AC7 — Claude Code CLI in Docker", () => {
  if (runFullDockerLeg) {
    it(
      "boots Claude Code CLI in Docker, drives conjure->write_files->preview->validate through " +
        "its own agent loop, and captures a preview screenshot (AC4/AC6)",
      async () => {
        const { mkdtemp, rm: rmDir, writeFile, mkdir: mkdirp } = await import("node:fs/promises");
        const { tmpdir: osTmpdir } = await import("node:os");
        const { join: joinPath } = await import("node:path");
        const { GenericContainer } = await import("testcontainers");
        const { createServer: createGenieServer } = await import("../../server/src/server.js");
        const { createServer: createHttpServer } = await import("node:http");

        const base = await mkdtemp(joinPath(osTmpdir(), "genie-m5-docker-smoke-"));
        const roots = {
          projectsRoot: joinPath(base, "projects"),
          kitsRoot: joinPath(base, "kits"),
          reportsDir: joinPath(base, "reports"),
        };
        await mkdirp(roots.kitsRoot, { recursive: true });

        // Start a real genie HTTP server this process owns; the container
        // reaches it via the Docker host gateway (host.docker.internal, which
        // testcontainers' extra-host option makes resolvable from inside
        // Linux containers too, not just Docker Desktop). `previewLocality:
        // "local"` overrides the transport-derived default (http ->
        // "remote") so `preview` still boots the Vite viewer and returns a
        // screenshot-able `viewerUrl` — the HTTP transport only controls
        // whether the server auto-opens a browser on its OWN machine
        // (it must not), not whether a viewer URL is produced at all. This
        // process and the container both reach the *same* physical host, so
        // "local" is the right locality even though `preview` is invoked
        // through streamable HTTP.
        const http = createHttpServer(
          createStreamableHttpRequestHandler(() =>
            createGenieServer({ ...roots, transportKind: "http", previewLocality: "local" }),
          ),
        );
        await new Promise<void>((resolve) => http.listen(0, "0.0.0.0", resolve));
        const address = http.address();
        const port = typeof address === "object" && address ? address.port : 0;
        expect(port).toBeGreaterThan(0);

        const mcpConfig = {
          mcpServers: {
            genie: {
              type: "http",
              url: `http://host.docker.internal:${port}/mcp`,
              timeout: 180_000,
            },
          },
        };
        const dockerSmokeModel = smokeModel ?? "design-default";
        const prompt =
          "Create a kit named m5-docker-smoke, then ask genie to conjure a simple primary " +
          "Button component with a label prop (kit description: clay accent #c87c5e, 8px " +
          `radius, Inter type scale) using model ${JSON.stringify(dockerSmokeModel)}, write the ` +
          "returned files, open the preview, and " +
          "validate the kit. Use the mcp__genie__* tools directly.";

        await writeFile(joinPath(base, "mcp-config.json"), JSON.stringify(mcpConfig, null, 2));
        await writeFile(joinPath(base, "prompt.txt"), prompt);

        let container: Awaited<ReturnType<GenericContainerType["start"]>> | undefined;
        try {
          // Build packages/e2e/docker/claude-code-smoke/Dockerfile fresh each
          // run (mirrors gitea-fixture.ts's convention of a throwaway image
          // rather than assuming a prebuilt tag is available).
          const dockerfileDir = joinPath(HERE, "../docker/claude-code-smoke");
          const builtImage = await GenericContainer.fromDockerfile(dockerfileDir).build();
          container = await builtImage
            .withEnvironment({
              ANTHROPIC_BASE_URL:
                process.env["GENIE_ANTHROPIC_SMOKE_BASE_URL"]?.trim() ??
                process.env["GENIE_LLM_BASE_URL"]?.trim().replace(/\/v1\/?$/, "") ??
                "https://api.anthropic.com",
              ANTHROPIC_API_KEY: anthropicSmokeKey!,
            })
            .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
            .withCopyFilesToContainer([
              { source: joinPath(base, "mcp-config.json"), target: "/workspace/mcp-config.json" },
              { source: joinPath(base, "prompt.txt"), target: "/workspace/prompt.txt" },
            ])
            .withStartupTimeout(120_000)
            .start();

          const stream = await container.logs();
          let stdout = "";
          await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            });
            stream.on("end", resolve);
            stream.on("error", reject);
          });

          // `--output-format stream-json` (see run-smoke.sh) emits one JSON
          // object per line — the actual structured tool-call/tool-result
          // event stream, not a single collapsed final result. Walk it and
          // correlate each `tool_use` event (by id) with its matching
          // `tool_result` event so we can assert the documented verbs plus
          // their create_kit/plan prerequisites were genuinely invoked in
          // order by Claude's own agent loop AND that none came back as an
          // error. `--output-format json`'s summary cannot prove any of that.
          const events = parseClaudeStream(stdout);
          expect(
            events.length,
            `expected at least one stream-json event; raw output:\n${stdout}`,
          ).toBeGreaterThan(0);

          const { calledToolNames, toolResultsByName, terminalResult } =
            collectClaudeToolResults(events);
          expect(
            terminalResult?.["is_error"],
            `expected Claude Code's terminal stream-json result to be non-error; raw output:\n${stdout}`,
          ).toBe(false);
          const previewToolResult = toolResultsByName.get(
            claudeCodeToolName(PREVIEW_TOOL_NAME),
          )?.[0];

          const protocolVerbs = [
            CREATE_KIT_TOOL_NAME,
            CONJURE_TOOL_NAME,
            "mcp__genie__plan",
            WRITE_FILES_TOOL_NAME,
            PREVIEW_TOOL_NAME,
            VALIDATE_TOOL_NAME,
          ];
          const claudeCodeVerbs = protocolVerbs.map(claudeCodeToolName);
          for (const [index, verb] of claudeCodeVerbs.entries()) {
            const results = toolResultsByName.get(verb);
            expect(
              results && results.length > 0,
              `expected Claude Code's ${verb} wrapper for ${protocolVerbs[index]} to have a ` +
                `tool_use/tool_result pair in the stream-json ` +
                `output; raw output:\n${stdout}`,
            ).toBe(true);
            for (const result of results ?? []) {
              expect(
                result.is_error,
                `expected ${verb}'s tool_result to be non-error; got: ${JSON.stringify(result)}`,
              ).not.toBe(true);
            }
          }
          const firstCallIndexes = claudeCodeVerbs.map((verb) => calledToolNames.indexOf(verb));
          expect(
            firstCallIndexes.every(
              (callIndex, index) => index === 0 || callIndex > firstCallIndexes[index - 1]!,
            ),
            `expected the documented chain and prerequisites in order; calls were ${calledToolNames.join(", ")}`,
          ).toBe(true);

          // Screenshot AC6: capture the actual generated preview surface —
          // the URL the `preview` tool call itself returned — not an
          // unrelated health-check endpoint. The preview tool's payload
          // carries either a `url` (HTTP viewer) or a `viewerUrl` field
          // depending on transport; fall back to the raw text content if
          // structured content isn't present.
          const previewUrl = extractPreviewUrl(previewToolResult);
          expect(
            previewUrl,
            `expected the preview tool_result to contain a viewer URL to screenshot; got: ` +
              `${JSON.stringify(previewToolResult)}`,
          ).toBeTruthy();
          // The container reaches the host server via host.docker.internal,
          // but this test process (and its Playwright browser) runs on the
          // host, so rewrite that hostname to 127.0.0.1 for the screenshot.
          const hostPreviewUrl = previewUrl!.replace("host.docker.internal", "127.0.0.1");

          const { chromium } = await import("playwright");
          const browser = await chromium.launch();
          try {
            const page = await browser.newPage();
            const response = await page.goto(hostPreviewUrl, { waitUntil: "load" });
            expect(response?.ok(), `preview URL was not reachable: ${hostPreviewUrl}`).toBe(true);
            await page.waitForSelector(".ds-card", { state: "attached", timeout: 10_000 });
            const screenshotDir = joinPath(process.cwd(), "docs/harness/screenshots/claude-code");
            await mkdirp(screenshotDir, { recursive: true });
            const screenshotPath = joinPath(screenshotDir, "m5-09-docker-smoke.png");
            const screenshot = await page.screenshot({
              path: screenshotPath,
              fullPage: true,
            });
            expect(screenshot.byteLength).toBeGreaterThan(0);
          } finally {
            await browser.close();
          }
        } finally {
          await container?.stop().catch(() => {});
          await new Promise<void>((resolve) => http.close(() => resolve()));
          await rmDir(base, { recursive: true, force: true });
        }
      },
      180_000,
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
        "connect to the host-owned genie HTTP server, drive the four-verb chain through " +
        "Claude's own agent " +
        "loop, capture screenshots to docs/harness/screenshots/claude-code/) did NOT run. " +
        "Set GENIE_REQUIRE_DOCKER=1 once Docker + the `claude` CLI are provisioned to turn " +
        "this into a hard failure instead of a skip.";
      console.warn(message);
      (ctx.task.meta as Record<string, unknown>)["acStatus"] =
        "AC4/AC6 unverified — skipped (no Docker)";
      ctx.skip();
    });
  }
});
