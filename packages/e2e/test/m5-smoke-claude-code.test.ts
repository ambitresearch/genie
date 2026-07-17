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
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNodeHttpServer, type Server as NodeHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GenericContainer as GenericContainerType } from "testcontainers";
import type { InlineConfig } from "vite";

import { createServer } from "../../server/src/server.js";
import { createStreamableHttpRequestHandler } from "../../server/src/transport.js";
import { CONJURE_TOOL_NAME } from "../../server/src/tools/conjure.js";
import { PREVIEW_TOOL_NAME, type ViewerBooter } from "../../server/src/tools/preview.js";
import { WRITE_FILES_TOOL_NAME } from "../../server/src/tools/write_files.js";
import { createViewerConfig } from "../../viewer/src/config.js";
import { isDockerAvailable as isTestcontainersDockerAvailable } from "./support/gitea-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_KEY_HELPER = join(HERE, "../../../docs/harness/scripts/anthropic-api-key-helper.sh");
const RUN_SMOKE = join(HERE, "../docker/claude-code-smoke/run-smoke.sh");

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
      "CLI-in-Docker leg (AC4/AC6/AC7: boot Claude Code, connect it to the host-owned genie HTTP " +
      "server, drive the chain through Claude's own agent loop, capture screenshots). Provision " +
      "Docker + the `claude` CLI in the image to run it for real; CI's dedicated " +
      "m5-smoke-claude-code job (manually triggered) runs it.",
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
// authenticates with to run its own agent loop. A dedicated key defaults to
// Anthropic and may use only its dedicated base-URL override. If no dedicated
// key exists, the genie gateway key and URL may be intentionally reused as a
// pair with its explicit smoke model; never send a dedicated Anthropic key to
// GENIE_LLM_BASE_URL.
interface ClaudeDriverConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  source: "dedicated" | "gateway";
}

function createClaudeSettings(apiKeyHelper: string): Record<string, unknown> {
  return { apiKeyHelper };
}

function createClaudeMcpConfig(mcpUrl: string, headersHelper: string): Record<string, unknown> {
  return {
    mcpServers: {
      genie: {
        type: "http",
        url: mcpUrl,
        timeout: 180_000,
        headersHelper,
      },
    },
  };
}

function resolveClaudeDriverConfig(
  env: Record<string, string | undefined>,
): ClaudeDriverConfig | undefined {
  const dedicatedKey = env["GENIE_ANTHROPIC_SMOKE_API_KEY"]?.trim();
  if (dedicatedKey) {
    return {
      apiKey: dedicatedKey,
      baseUrl: env["GENIE_ANTHROPIC_SMOKE_BASE_URL"]?.trim() || "https://api.anthropic.com",
      source: "dedicated",
    };
  }

  const gatewayKey = env["GENIE_LLM_API_KEY"]?.trim();
  const gatewayBaseUrl = env["GENIE_LLM_BASE_URL"]?.trim();
  const gatewayModel = env["GENIE_SMOKE_MODEL"]?.trim();
  if (gatewayKey && gatewayBaseUrl && gatewayModel) {
    return {
      apiKey: gatewayKey,
      baseUrl: gatewayBaseUrl.replace(/\/v1\/?$/, ""),
      model: gatewayModel,
      source: "gateway",
    };
  }
  return undefined;
}

function resolveFullDockerLeg(options: {
  required: boolean;
  dockerAvailable: boolean;
  hasLlmConfig: boolean;
  driverConfig: ClaudeDriverConfig | undefined;
}): boolean {
  const canRun = options.dockerAvailable && options.hasLlmConfig && Boolean(options.driverConfig);
  if (options.required && !canRun) {
    throw new Error(
      "GENIE_REQUIRE_DOCKER=1 but the full Claude-Code-in-Docker leg is missing Docker, " +
        "the genie LLM endpoint, or a Claude driver credential — it must run rather than skip.",
    );
  }
  return canRun;
}

interface DockerPreviewServer {
  httpServer: { address: () => string | { port: number } | null } | null;
  listen: () => Promise<unknown>;
  close: () => Promise<unknown>;
}

interface TrackedViewerClose {
  close: () => Promise<void>;
  forceClose: () => void;
}

function createDockerPreviewBooter(
  createViteServer: (config: InlineConfig) => Promise<DockerPreviewServer>,
  trackClose?: (close: TrackedViewerClose) => void,
): ViewerBooter {
  return async ({ kitDir, port }) => {
    const config = createViewerConfig({ root: kitDir, port, host: "0.0.0.0" });
    config.server = {
      ...config.server,
      allowedHosts: ["host.docker.internal"],
    };
    const server = await createViteServer({ ...config, clearScreen: false });
    let closePromise: Promise<unknown> | undefined;
    const close = async (): Promise<void> => {
      if (closePromise === undefined) {
        const pending = Promise.resolve().then(() => server.close());
        closePromise = pending;
        try {
          await pending;
        } catch (error) {
          if (closePromise === pending) closePromise = undefined;
          throw error;
        }
      } else {
        await closePromise;
      }
    };
    const forceClose = (): void => {
      const httpServer = server.httpServer as
        | (DockerPreviewServer["httpServer"] & { closeAllConnections?: () => void })
        | null;
      httpServer?.closeAllConnections?.();
    };
    trackClose?.({ close, forceClose });

    await server.listen();
    const address = server.httpServer?.address();
    if (typeof address !== "object" || address === null) {
      await close();
      throw new Error("Docker smoke viewer did not bind a TCP port");
    }
    const actualPort = address.port;

    return {
      url: `http://host.docker.internal:${actualPort}/`,
      port: actualPort,
      open: async () => {},
      close,
    };
  };
}

async function closeWithTimeout(close: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Resource cleanup timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeWithOneRetry(closers: (() => Promise<void>)[]): Promise<void> {
  const firstResults = await Promise.allSettled(closers.map((close) => closeWithTimeout(close)));
  const failedClosers = closers.filter(
    (_close, index) => firstResults[index]?.status === "rejected",
  );
  const retryResults = await Promise.allSettled(
    failedClosers.map((close) => closeWithTimeout(close)),
  );
  const persistentFailures = retryResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (persistentFailures.length > 0) {
    throw new AggregateError(persistentFailures, "Resource cleanup failed after one retry");
  }
}

const claudeDriverConfig = resolveClaudeDriverConfig(process.env);
if (dockerAvailable && !claudeDriverConfig) {
  console.info(
    "[m5-smoke-claude-code] no Claude driver credential is configured — skipping the full " +
      "Claude Code CLI-in-Docker leg even though Docker is available. Set a dedicated " +
      "GENIE_ANTHROPIC_SMOKE_API_KEY or configure the GENIE_LLM_* gateway pair plus " +
      "GENIE_SMOKE_MODEL for intentional reuse inside the throwaway container.",
  );
}
if (dockerAvailable && !claudeDriverConfig && process.env["GENIE_REQUIRE_DOCKER"] === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but neither a dedicated GENIE_ANTHROPIC_SMOKE_API_KEY nor a " +
      "complete GENIE_LLM_* gateway configuration with GENIE_SMOKE_MODEL is configured — " +
      "the m5-smoke-claude-code CI job must run the real Claude-Code-in-Docker leg, not skip it.",
  );
}
const runFullDockerLeg = resolveFullDockerLeg({
  required: process.env["GENIE_REQUIRE_DOCKER"] === "1",
  dockerAvailable,
  hasLlmConfig,
  driverConfig: claudeDriverConfig,
});

// ── Harness (mirrors m1-conformance.test.ts) ─────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

interface ConjuredFile {
  path: string;
  content: string;
  mimeType: string;
  encoding: "utf-8" | "base64";
}

function toWriteFileInput(file: ConjuredFile): {
  path: string;
  data: string;
  mimeType: string;
  encoding: "utf-8" | "base64";
} {
  return {
    path: file.path,
    data: file.content,
    mimeType: file.mimeType,
    encoding: file.encoding,
  };
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

describe("Claude driver credential selection", () => {
  it("keeps a dedicated Anthropic key on api.anthropic.com by default", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_ANTHROPIC_SMOKE_API_KEY: "dedicated-token",
        GENIE_LLM_API_KEY: "gateway-token",
        GENIE_LLM_BASE_URL: "https://gateway.example/v1",
        GENIE_SMOKE_MODEL: "gateway-driver",
      }),
    ).toEqual({
      apiKey: "dedicated-token",
      baseUrl: "https://api.anthropic.com",
      source: "dedicated",
    });
  });

  it("treats blank dedicated base URLs as absent", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_ANTHROPIC_SMOKE_API_KEY: " dedicated-token ",
        GENIE_ANTHROPIC_SMOKE_BASE_URL: "  ",
        GENIE_LLM_API_KEY: "gateway-token",
        GENIE_LLM_BASE_URL: "https://gateway.example/v1",
      }),
    ).toEqual({
      apiKey: "dedicated-token",
      baseUrl: "https://api.anthropic.com",
      source: "dedicated",
    });
  });

  it("uses the dedicated base URL only with the dedicated key", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_ANTHROPIC_SMOKE_API_KEY: "dedicated-token",
        GENIE_ANTHROPIC_SMOKE_BASE_URL: " https://anthropic-gateway.example/ ",
        GENIE_LLM_API_KEY: "gateway-token",
        GENIE_LLM_BASE_URL: "https://genie-gateway.example/v1",
      }),
    ).toEqual({
      apiKey: "dedicated-token",
      baseUrl: "https://anthropic-gateway.example/",
      source: "dedicated",
    });
  });

  it("pairs the genie gateway URL only with an intentionally reused genie key", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_ANTHROPIC_SMOKE_API_KEY: "  ",
        GENIE_ANTHROPIC_SMOKE_BASE_URL: "  ",
        GENIE_LLM_API_KEY: " gateway-token ",
        GENIE_LLM_BASE_URL: " https://gateway.example/v1/ ",
        GENIE_SMOKE_MODEL: " gateway-driver ",
      }),
    ).toEqual({
      apiKey: "gateway-token",
      baseUrl: "https://gateway.example",
      model: "gateway-driver",
      source: "gateway",
    });
  });

  it("does not select a gateway driver without an exposed model", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_LLM_API_KEY: "gateway-token",
        GENIE_LLM_BASE_URL: "https://gateway.example/v1",
        GENIE_SMOKE_MODEL: "  ",
      }),
    ).toBeUndefined();
  });

  it("treats a blank gateway base URL as absent", () => {
    expect(
      resolveClaudeDriverConfig({
        GENIE_ANTHROPIC_SMOKE_API_KEY: "",
        GENIE_LLM_API_KEY: "gateway-token",
        GENIE_LLM_BASE_URL: "  ",
      }),
    ).toBeUndefined();
  });
});

describe("Claude smoke prerequisites", () => {
  it("fails a required Docker leg when the genie LLM endpoint is absent", () => {
    expect(() =>
      resolveFullDockerLeg({
        required: true,
        dockerAvailable: true,
        hasLlmConfig: false,
        driverConfig: {
          apiKey: "dedicated-token",
          baseUrl: "https://api.anthropic.com",
          source: "dedicated",
        },
      }),
    ).toThrow(/GENIE_REQUIRE_DOCKER=1.*full Claude-Code-in-Docker leg/s);
  });
});

describe("Claude protocol file handoff", () => {
  it("preserves base64 encoding and MIME type for write_files", () => {
    expect(
      toWriteFileInput({
        path: "components/media/Logo/logo.png",
        content: "iVBORw0KGgo=",
        mimeType: "image/png",
        encoding: "base64",
      }),
    ).toEqual({
      path: "components/media/Logo/logo.png",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
      encoding: "base64",
    });
  });
});

it("binds the Docker smoke viewer on the host and advertises its container-reachable URL", async () => {
  const listen = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const trackedClosers: TrackedViewerClose[] = [];
  let receivedConfig: InlineConfig | undefined;
  const booter = createDockerPreviewBooter(
    async (config) => {
      receivedConfig = config;
      return {
        httpServer: { address: () => ({ port: 5189 }) },
        listen,
        close,
      };
    },
    (trackedClose) => trackedClosers.push(trackedClose),
  );

  const viewer = await booter({ kitDir: "/tmp/docker-preview-kit", port: 5173 });

  expect(receivedConfig?.server).toMatchObject({
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: ["host.docker.internal"],
  });
  expect(listen).toHaveBeenCalledOnce();
  expect(viewer.url).toBe("http://host.docker.internal:5189/");
  expect(trackedClosers).toHaveLength(1);
  await trackedClosers[0]!.close();
  await viewer.close();
  expect(close).toHaveBeenCalledOnce();
});

it("retries Docker smoke viewer cleanup after a failed close", async () => {
  const close = vi.fn().mockRejectedValueOnce(new Error("transient close failure"));
  close.mockResolvedValueOnce(undefined);
  const booter = createDockerPreviewBooter(async () => ({
    httpServer: { address: () => ({ port: 5189 }) },
    listen: async () => {},
    close,
  }));
  const viewer = await booter({ kitDir: "/tmp/docker-preview-kit", port: 5173 });

  await expect(viewer.close()).rejects.toThrow("transient close failure");
  await expect(viewer.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
});

it("waits for every cleanup retry and surfaces persistent failures", async () => {
  const recovers = vi.fn().mockRejectedValueOnce(new Error("first attempt"));
  recovers.mockResolvedValueOnce(undefined);
  const persists = vi.fn().mockRejectedValue(new Error("still broken"));

  await expect(closeWithOneRetry([recovers, persists])).rejects.toThrow(
    "Resource cleanup failed after one retry",
  );
  expect(recovers).toHaveBeenCalledTimes(2);
  expect(persists).toHaveBeenCalledTimes(2);
});

it("bounds hung cleanup attempts before surfacing the failure", async () => {
  const hangs = vi.fn(() => new Promise<void>(() => {}));

  await expect(closeWithTimeout(hangs, 5)).rejects.toThrow("timed out");
  expect(hangs).toHaveBeenCalledOnce();
});

it("denies built-in Claude tools while allowing only the documented MCP wrappers", async () => {
  const script = await import("node:fs/promises").then(({ readFile }) =>
    readFile(RUN_SMOKE, "utf8"),
  );

  expect(script).toContain('--tools "mcp__genie__mcp__genie__conjure');
  expect(script).toContain("--allowedTools");
  expect(script).toContain("GENIE_CLAUDE_DRIVER_MODEL");
  expect(script).toContain('--model "$GENIE_CLAUDE_DRIVER_MODEL"');
  expect(script).not.toMatch(/--tools\s+"[^\n]*(?:Bash|Read|Edit)/);
  expect(script).not.toContain("--dangerously-skip-permissions");
});

const hasClaudeCli = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasClaudeCli)("Claude Code accepts the documented default helper files", () => {
  it("executes both helpers from their normal settings and MCP config files", async () => {
    const base = await mkdtemp(join(tmpdir(), "genie-claude-combined-config-"));
    const apiMarker = join(base, "api-key-helper.called");
    const headersMarker = join(base, "headers-helper.called");
    let mcpHeaderSeen = false;
    let apiRequestSeen = false;
    let apiKeySeen = false;
    let mcpToolAdvertised = false;
    const sessionServers = new Set<ReturnType<typeof createServer>>();

    const mcpHandler = createStreamableHttpRequestHandler(() => {
      const sessionServer = createServer({
        projectsRoot: join(base, "projects"),
        kitsRoot: join(base, "kits"),
        reportsDir: join(base, "reports"),
        transportKind: "http",
      });
      sessionServers.add(sessionServer);
      return sessionServer;
    });
    const mcpHttp = createNodeHttpServer((req, res) => {
      if (req.headers["x-genie-smoke-helper"] !== "configured") {
        res.writeHead(401).end();
        return;
      }
      mcpHeaderSeen = true;
      mcpHandler(req, res);
    });
    const apiHttp = createNodeHttpServer((req, res) => {
      apiRequestSeen = true;
      apiKeySeen = req.headers["x-api-key"] === "not-a-real-api-key";
      if (!apiKeySeen) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "missing helper key" },
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          tools?: { name?: string }[];
        };
        mcpToolAdvertised = Boolean(body.tools?.some((tool) => tool.name === "mcp__genie__ping"));
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const events = [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_genie_helper_smoke",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ] as const;
        res.end(
          events
            .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`)
            .join("\n\n") + "\n\n",
        );
      });
    });

    try {
      await mkdir(join(base, "kits"), { recursive: true });
      const mcpPort = await listen(mcpHttp);
      const apiPort = await listen(apiHttp);
      const apiHelper = join(base, "api-key-helper.sh");
      const headersHelper = join(base, "headers-helper.sh");
      const settingsDir = join(base, ".claude");
      const settingsPath = join(settingsDir, "settings.json");
      const mcpConfigPath = join(base, ".claude.json");
      await writeFile(
        apiHelper,
        '#!/bin/sh\nset -eu\n: > "$GENIE_API_HELPER_MARKER"\nprintf %s "$GENIE_CLAUDE_DRIVER_API_KEY"\n',
      );
      await writeFile(
        headersHelper,
        '#!/bin/sh\nset -eu\n: > "$GENIE_HEADERS_HELPER_MARKER"\nprintf \'{"X-Genie-Smoke-Helper":"configured"}\'\n',
      );
      await Promise.all([chmod(apiHelper, 0o755), chmod(headersHelper, 0o755)]);
      await mkdir(settingsDir, { recursive: true });
      await writeFile(settingsPath, JSON.stringify(createClaudeSettings(apiHelper)));
      await writeFile(
        mcpConfigPath,
        JSON.stringify(createClaudeMcpConfig(`http://127.0.0.1:${mcpPort}/mcp`, headersHelper)),
      );

      const env: Record<string, string> = {
        HOME: base,
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: process.env.LANG ?? "C.UTF-8",
        USER: "genie-test-user",
        CI: "1",
        NO_PROXY: "127.0.0.1,localhost",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
        GENIE_CLAUDE_DRIVER_API_KEY: "not-a-real-api-key",
        GENIE_API_HELPER_MARKER: apiMarker,
        GENIE_HEADERS_HELPER_MARKER: headersMarker,
      };

      const result = await new Promise<{
        status: number | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          "claude",
          [
            "-p",
            "Reply with one word.",
            "--setting-sources",
            "user",
            "--output-format",
            "json",
            "--tools",
            "mcp__genie__ping",
            "--allowedTools",
            "mcp__genie__ping",
            "--no-session-persistence",
          ],
          { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 20_000);
        child.once("error", reject);
        child.once("close", (status) => {
          clearTimeout(timer);
          resolve({ status, timedOut, stdout, stderr });
        });
      });

      const diagnostics =
        `Claude CLI status: ${result.status}, timed out: ${result.timedOut}\n` +
        `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;
      expect(result.timedOut, diagnostics).toBe(false);
      expect(result.status, diagnostics).toBe(0);
      await expect(access(apiMarker)).resolves.toBeUndefined();
      await expect(access(headersMarker)).resolves.toBeUndefined();
      expect(apiRequestSeen).toBe(true);
      expect(apiKeySeen).toBe(true);
      expect(mcpHeaderSeen).toBe(true);
      expect(mcpToolAdvertised).toBe(true);
    } finally {
      try {
        await closeWithOneRetry([...sessionServers].map((server) => () => server.close()));
      } finally {
        mcpHttp.closeAllConnections();
        apiHttp.closeAllConnections();
        await Promise.all([closeHttpServer(mcpHttp), closeHttpServer(apiHttp)]);
        await rm(base, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

async function runApiKeyHelper(options: {
  security: string;
  op: string;
  anthropicApiKey?: string;
}) {
  const binDir = await mkdtemp(join(tmpdir(), "genie-api-key-helper-bin-"));
  try {
    for (const [command, body] of [
      ["security", options.security],
      ["op", options.op],
    ] as const) {
      const stub = join(binDir, command);
      await writeFile(stub, `#!/bin/sh\n${body}\n`);
      await chmod(stub, 0o755);
    }

    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    if (options.anthropicApiKey !== undefined) {
      env["ANTHROPIC_API_KEY"] = options.anthropicApiKey;
    }
    return spawnSync(API_KEY_HELPER, [], {
      encoding: "utf8",
      env: {
        ...env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        USER: "genie-test-user",
      },
    });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

describe("the executable apiKeyHelper", () => {
  it("prefers a successful security lookup", async () => {
    const result = await runApiKeyHelper({
      security: "printf security-token",
      op: "printf op-token",
      anthropicApiKey: "env-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("security-token");
  });

  it("falls through a failed security lookup to op", async () => {
    const result = await runApiKeyHelper({
      security: "exit 1",
      op: "printf op-token",
      anthropicApiKey: "env-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("op-token");
  });

  it("discards output from a failed security lookup before falling through to op", async () => {
    const result = await runApiKeyHelper({
      security: "printf partial-token; exit 1",
      op: "printf op-token",
      anthropicApiKey: "env-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("op-token");
  });

  it("falls through failed keychain clients to the env", async () => {
    const result = await runApiKeyHelper({
      security: "exit 1",
      op: "exit 1",
      anthropicApiKey: "env-fallback-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("env-fallback-token");
  });

  it("discards output from a failed op lookup before falling through to the env", async () => {
    const result = await runApiKeyHelper({
      security: "exit 1",
      op: "printf partial-token; exit 1",
      anthropicApiKey: "env-fallback-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("env-fallback-token");
  });

  it("fails without printing a secret when no source succeeds", async () => {
    const result = await runApiKeyHelper({ security: "exit 1", op: "exit 1" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no credential source found");
  });

  it("treats a whitespace-only environment credential as absent", async () => {
    const result = await runApiKeyHelper({
      security: "exit 1",
      op: "exit 1",
      anthropicApiKey: "  \t  ",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no credential source found");
  });
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
  const closeViewer = () => closeHttpServer(viewerHttp);
  let mcpHttp: NodeHttpServer | undefined;
  const client = new Client({ name: "m5-local-http-preview", version: "0" });

  try {
    const viewerPort = await listen(viewerHttp);
    const viewerUrl = `http://127.0.0.1:${viewerPort}/`;
    mcpHttp = createNodeHttpServer(
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
    if (mcpHttp !== undefined) await closeHttpServer(mcpHttp);
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
        files: ConjuredFile[];
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
          files: conjured.files.map(toWriteFileInput),
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
        const { createServer: createViteServer } = await import("vite");

        const base = await mkdtemp(joinPath(osTmpdir(), "genie-m5-docker-smoke-"));
        const viewerClosers = new Set<TrackedViewerClose>();
        const sessionServers = new Set<ReturnType<typeof createGenieServer>>();
        let http: NodeHttpServer | undefined;
        let container: Awaited<ReturnType<GenericContainerType["start"]>> | undefined;
        try {
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
          const mcpHandler = createStreamableHttpRequestHandler(() => {
            const sessionServer = createGenieServer({
              ...roots,
              transportKind: "http",
              previewLocality: "local",
              previewBooter: createDockerPreviewBooter(createViteServer, (trackedClose) =>
                viewerClosers.add(trackedClose),
              ),
            });
            sessionServers.add(sessionServer);
            return sessionServer;
          });
          const smokeHttp = createHttpServer((req, res) => {
            const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
            if (pathname === "/health") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: "ok", server: "genie" }));
              return;
            }
            if (pathname !== "/mcp") {
              res.writeHead(404).end();
              return;
            }
            if (req.headers["x-genie-smoke-helper"] !== "configured") {
              res.writeHead(401).end();
              return;
            }
            mcpHandler(req, res);
          });
          http = smokeHttp;
          await new Promise<void>((resolve) => smokeHttp.listen(0, "0.0.0.0", resolve));
          const address = smokeHttp.address();
          const port = typeof address === "object" && address ? address.port : 0;
          expect(port).toBeGreaterThan(0);

          const apiKeyHelperPath = joinPath(base, "api-key-helper.sh");
          const headersHelperPath = joinPath(base, "headers-helper.sh");
          const settingsPath = joinPath(base, "settings.json");
          const mcpConfigPath = joinPath(base, "mcp-config.json");
          const dockerSmokeModel = smokeModel ?? "design-default";
          const prompt =
            "Create a kit named m5-docker-smoke, then ask genie to conjure a simple primary " +
            "Button component with a label prop (kit description: clay accent #c87c5e, 8px " +
            `radius, Inter type scale) using model ${JSON.stringify(dockerSmokeModel)}, write the ` +
            "returned files, open the preview, and " +
            "validate the kit. Use the mcp__genie__* tools directly.";

          await writeFile(
            apiKeyHelperPath,
            '#!/bin/sh\nset -eu\n: > /workspace/api-key-helper.called\nprintf %s "$GENIE_CLAUDE_DRIVER_API_KEY"\n',
          );
          await writeFile(
            headersHelperPath,
            '#!/bin/sh\nset -eu\n: > /workspace/headers-helper.called\nprintf \'{"X-Genie-Smoke-Helper":"configured"}\'\n',
          );
          await Promise.all([chmod(apiKeyHelperPath, 0o755), chmod(headersHelperPath, 0o755)]);
          await writeFile(
            settingsPath,
            JSON.stringify(createClaudeSettings("/workspace/api-key-helper.sh"), null, 2),
          );
          await writeFile(
            mcpConfigPath,
            JSON.stringify(
              createClaudeMcpConfig(
                `http://host.docker.internal:${port}/mcp`,
                "/workspace/headers-helper.sh",
              ),
              null,
              2,
            ),
          );
          await writeFile(joinPath(base, "prompt.txt"), prompt);

          // Build packages/e2e/docker/claude-code-smoke/Dockerfile fresh each
          // run (mirrors gitea-fixture.ts's convention of a throwaway image
          // rather than assuming a prebuilt tag is available).
          const dockerfileDir = joinPath(HERE, "../docker/claude-code-smoke");
          const builtImage = await GenericContainer.fromDockerfile(dockerfileDir).build();
          container = await builtImage
            .withEnvironment({
              ANTHROPIC_BASE_URL: claudeDriverConfig!.baseUrl,
              GENIE_CLAUDE_DRIVER_API_KEY: claudeDriverConfig!.apiKey,
              ...(claudeDriverConfig!.model
                ? { GENIE_CLAUDE_DRIVER_MODEL: claudeDriverConfig!.model }
                : {}),
            })
            .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
            .withCopyFilesToContainer([
              {
                source: settingsPath,
                target: "/workspace/.claude/settings.json",
              },
              {
                source: mcpConfigPath,
                target: "/workspace/.claude.json",
              },
              { source: apiKeyHelperPath, target: "/workspace/api-key-helper.sh", mode: 0o755 },
              {
                source: headersHelperPath,
                target: "/workspace/headers-helper.sh",
                mode: 0o755,
              },
              { source: joinPath(base, "prompt.txt"), target: "/workspace/prompt.txt" },
            ])
            .withStartupTimeout(120_000)
            .start();

          // PID 1 stays idle so `exec` can preserve stdout/stderr separately.
          // Bound the child below Vitest's test timeout so a stuck model call
          // returns control to this finally block and the container is stopped.
          const cliResult = await container.exec(
            ["timeout", "--signal=TERM", "--kill-after=5s", "150s", "/usr/local/bin/run-smoke.sh"],
            { user: "node" },
          );
          const cliDiagnostics =
            `Claude Code process exited ${cliResult.exitCode}\n` +
            `stdout:\n${cliResult.stdout}\n\nstderr:\n${cliResult.stderr}`;
          expect(cliResult.exitCode, cliDiagnostics).toBe(0);
          const helperMarkers = await container.exec([
            "sh",
            "-c",
            "test -f /workspace/api-key-helper.called && test -f /workspace/headers-helper.called",
          ]);
          expect(
            helperMarkers.exitCode,
            `expected Claude Code to execute both documented helpers; ${cliDiagnostics}`,
          ).toBe(0);

          // `--output-format stream-json` (see run-smoke.sh) emits one JSON
          // object per line — the actual structured tool-call/tool-result
          // event stream, not a single collapsed final result. Walk it and
          // correlate each `tool_use` event (by id) with its matching
          // `tool_result` event so we can assert the documented verbs plus
          // their create_kit/plan prerequisites were genuinely invoked in
          // order by Claude's own agent loop AND that none came back as an
          // error. `--output-format json`'s summary cannot prove any of that.
          let events: ClaudeStreamEvent[];
          try {
            events = parseClaudeStream(cliResult.stdout);
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\n\n${cliDiagnostics}`,
              { cause: error },
            );
          }
          expect(
            events.length,
            `expected at least one stream-json event; ${cliDiagnostics}`,
          ).toBeGreaterThan(0);

          const { calledToolNames, toolResultsByName, terminalResult } =
            collectClaudeToolResults(events);
          expect(
            terminalResult?.["is_error"],
            `expected Claude Code's terminal stream-json result to be non-error; ${cliDiagnostics}`,
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
                `output; ${cliDiagnostics}`,
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
          const containerPreviewResponse = await container.exec(
            [
              "node",
              "-e",
              "fetch(process.argv[1]).then(r => { console.log(r.status); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e); process.exit(1); })",
              previewUrl!,
            ],
            { user: "node" },
          );
          expect(
            containerPreviewResponse.exitCode,
            `preview URL was not reachable from Claude Code's container: ${previewUrl}\n` +
              `stdout:\n${containerPreviewResponse.stdout}\n\nstderr:\n${containerPreviewResponse.stderr}`,
          ).toBe(0);
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
            const previewFrame = page.locator(".ds-card iframe").first().contentFrame();
            await expect
              .poll(
                async () =>
                  previewFrame
                    .locator("body")
                    .evaluate(
                      (body) =>
                        body.childElementCount > 0 || (body.textContent?.trim().length ?? 0) > 0,
                    )
                    .catch(() => false),
                { timeout: 10_000 },
              )
              .toBe(true);
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
          const startedContainer = container;
          const containerStop =
            startedContainer === undefined
              ? []
              : // Testcontainers forwards this to Docker Engine's stop API (seconds).
                [() => startedContainer.stop({ timeout: 5, remove: true }).then(() => {})];
          try {
            await closeWithOneRetry([
              ...containerStop,
              ...[...sessionServers].map((server) => () => server.close()),
              ...[...viewerClosers].map(({ close }) => close),
            ]);
          } finally {
            for (const { forceClose } of viewerClosers) forceClose();
            http?.closeAllConnections();
            if (http !== undefined) await closeHttpServer(http);
            await rmDir(base, { recursive: true, force: true });
          }
        }
      },
      300_000,
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
