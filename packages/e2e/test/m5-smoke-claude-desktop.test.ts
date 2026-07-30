/**
 * Supplemental M5-10 (DRO-282) contract and stdio coverage.
 *
 * AC6 itself requires installing a real `.mcpb` in Claude Desktop, invoking
 * `list_kits`, and capturing the Desktop UI. This suite does not substitute
 * an SDK client for that evidence. It verifies the guide's current package and
 * startup contracts, then exercises the same built CLI and stdio transport the
 * validated Desktop bundle launches.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = resolve(here, "../../server/dist/cli.js");
const CLAUDE_DESKTOP_DOC = readFileSync(
  resolve(here, "../../../docs/harness/claude-desktop.md"),
  "utf8",
);
const ROOT_README = readFileSync(resolve(here, "../../../README.md"), "utf8");
const CLAUDE_DESKTOP_SCREENSHOT = resolve(
  here,
  "../../../docs/harness/screenshots/claude-desktop/m5-10-list-kits.png",
);
const HARNESS_OVERVIEW = readFileSync(resolve(here, "../../../docs/harness/README.md"), "utf8");
const CI_WORKFLOW = readFileSync(resolve(here, "../../../.github/workflows/ci.yml"), "utf8");

const hasBuiltServer =
  spawnSync(process.execPath, [
    "-e",
    `require("node:fs").accessSync(${JSON.stringify(SERVER_CLI)})`,
  ]).status === 0;
const requireBuiltServer = process.env.GENIE_REQUIRE_CLAUDE_DESKTOP_SMOKE === "1";

if (requireBuiltServer && !hasBuiltServer) {
  throw new Error(
    "GENIE_REQUIRE_CLAUDE_DESKTOP_SMOKE=1 but packages/server/dist/cli.js is missing. " +
      "Build @ambitresearch/genie before running the Claude Desktop smoke suite.",
  );
}

const hasLlmEnv = Boolean(
  process.env.GENIE_LLM_BASE_URL?.trim() && process.env.GENIE_LLM_API_KEY?.trim(),
);

// DRO-1255 — `preview`'s local path lazily imports @ambitresearch/genie-viewer's
// COMPILED entrypoint. A clean checkout has no packages/viewer/dist, so the boot
// throws, `preview.fallback`/`viewer-boot-failed` is logged, and the tool degrades
// to the file:// vehicle — gracefully, silently, and green. That is exactly how the
// self-hosted canary went two milestones without ever exercising the real viewer
// boot. `test:e2e:claude-desktop` now builds the viewer first; this constant lets
// the assertion below demand the NON-fallback path whenever dist/ is present, so a
// future viewer-boot regression fails loudly instead of degrading quietly.
const VIEWER_DIST_ENTRY = resolve(here, "../../viewer/dist/index.js");
const hasBuiltViewer = existsSync(VIEWER_DIST_ENTRY);

if (requireBuiltServer && !hasBuiltViewer) {
  throw new Error(
    "GENIE_REQUIRE_CLAUDE_DESKTOP_SMOKE=1 but packages/viewer/dist/index.js is missing. " +
      "Build @ambitresearch/genie-viewer so `preview` exercises the real viewer boot (DRO-1255).",
  );
}

// A single live `conjure` against the real endpoint has been measured at ~101s,
// ~114s, and as high as ~125s — see `m2-generation.test.ts:128-156`, which
// raised its own ceiling to 360s after concluding that this class of failure
// "was a test-infra timeout, not a generation failure".
//
// `client.callTool(params, resultSchema, options)` takes its request budget as
// the THIRD argument. Omitting `options` silently applies the SDK's
// `DEFAULT_REQUEST_TIMEOUT_MSEC` (60_000) no matter what the surrounding
// `it(...)` declares — which is exactly how this test turned `main` red at
// 60032ms with `McpError -32001: Request timed out` (#301).
//
// So there are two independent budgets and both have to be set:
//   LIVE_CONJURE_TIMEOUT_MS    — the wire budget (~1.9x the observed worst case)
//   LIVE_CHAIN_TEST_TIMEOUT_MS — the vitest budget, deliberately LARGER, so a
//                                hang surfaces as a clean MCP error instead of
//                                being killed by the runner first.
// Both stay well inside this job's `timeout-minutes: 25` in `ci.yml`.
// Enforced by `m5-live-llm-timeouts.test.ts`.
const LIVE_CONJURE_TIMEOUT_MS = 240_000;
const LIVE_CHAIN_TEST_TIMEOUT_MS = 300_000;

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

function cleanSecretEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GENIE_LLM_BASE_URL;
  delete env.GENIE_LLM_API_KEY;
  delete env.OAUTH_HS256_KEY;
  return { ...env, ...overrides };
}

describe("Claude Desktop guide contracts", () => {
  it("uses the planned scoped package and supplies valid-length placeholders for every required startup secret", () => {
    const snippet = [...CLAUDE_DESKTOP_DOC.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((block) => block?.includes('"@ambitresearch/genie"'));
    expect(snippet).toBeDefined();

    const config = JSON.parse(snippet ?? "{}") as {
      mcpServers: {
        genie: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    const genie = config.mcpServers.genie;

    expect(genie.command).toBe("npx");
    expect(genie.args).toEqual(["-y", "@ambitresearch/genie", "--transport", "stdio"]);
    expect(genie.env.GENIE_LLM_API_KEY?.length).toBeGreaterThanOrEqual(16);
    expect(genie.env.OAUTH_HS256_KEY).toBeUndefined();
    expect(genie.env.GENIE_HOME).toBe("/absolute/path/to/.genie");
    expect(genie.env.GENIE_KITS_ROOT).toBe("/absolute/path/to/.genie/kits");
    expect(genie.env.GENIE_PROJECTS_ROOT).toBe("/absolute/path/to/.genie/projects");
    expect(CLAUDE_DESKTOP_DOC).toContain("verified M5-05 bundle landed");
    expect(CLAUDE_DESKTOP_DOC).toContain("bare `genie` npm package");
    expect(CLAUDE_DESKTOP_DOC).toContain("`@genie` scope are owned by unrelated npm users");
  });

  it("documents the actual bootstrap and optional OAuth requirements", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain(
      "`GENIE_LLM_API_KEY` is required before the server starts",
    );
    expect(CLAUDE_DESKTOP_DOC).toMatch(/`GENIE_LLM_API_KEY` must contain at least 16\s+characters/);
    expect(CLAUDE_DESKTOP_DOC).toMatch(/`OAUTH_HS256_KEY` is optional and HTTP-only/);
    expect(CLAUDE_DESKTOP_DOC).not.toMatch(/read tools work without an LLM configured/i);
  });

  it("prefers Claude's native remote connector and keeps mcp-remote as a local-network fallback", () => {
    const nativeConnector = CLAUDE_DESKTOP_DOC.search(/Add\s+custom connector/);
    const bridge = CLAUDE_DESKTOP_DOC.indexOf("mcp-remote");
    expect(nativeConnector).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(nativeConnector);
    expect(CLAUDE_DESKTOP_DOC).toMatch(/`mcp-remote`[^\n]*fallback/i);
  });

  it("does not promise that the current bundle installs the Agent Skill", () => {
    expect(CLAUDE_DESKTOP_DOC).toMatch(/does not\s+currently include the Agent Skill/);
    expect(CLAUDE_DESKTOP_DOC).not.toContain("bundles it automatically");
  });

  it("documents current Linux beta support", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain("Linux beta");
    expect(CLAUDE_DESKTOP_DOC).toContain("Ubuntu 22.04 LTS+");
    expect(CLAUDE_DESKTOP_DOC).toContain("Debian 12+");
    expect(CLAUDE_DESKTOP_DOC).toContain("~/.config/Claude/claude_desktop_config.json");
    expect(CLAUDE_DESKTOP_DOC).toContain("M5-05 v1 bundle is");
    expect(CLAUDE_DESKTOP_DOC).toContain("macOS-only; Windows and Linux users");
    expect(CLAUDE_DESKTOP_DOC).toMatch(/Linux users must use the manual JSON configuration/);
    expect(CLAUDE_DESKTOP_DOC).not.toContain("Linux is not officially supported");
  });

  it("provides writable absolute persistence-root examples for every supported platform", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain("/Users/you/.genie/kits");
    expect(CLAUDE_DESKTOP_DOC).toContain("C:\\\\Users\\\\you\\\\.genie\\\\kits");
    expect(CLAUDE_DESKTOP_DOC).toContain("/home/you/.genie/kits");
    expect(CLAUDE_DESKTOP_DOC).toContain('"GENIE_KITS_ROOT": "/absolute/path/to/.genie/kits"');
    expect(CLAUDE_DESKTOP_DOC).toContain(
      '"GENIE_PROJECTS_ROOT": "/absolute/path/to/.genie/projects"',
    );
  });

  it("documents the exact macOS Claude Desktop MCP log glob", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain("~/Library/Logs/Claude/mcp*.log");
    expect(CLAUDE_DESKTOP_DOC).toContain("for genie's stderr output");
    expect(CLAUDE_DESKTOP_DOC).not.toContain("genie's own stdout/stderr");
  });

  it("links the non-secret AC6 Claude Desktop evidence", () => {
    expect(existsSync(CLAUDE_DESKTOP_SCREENSHOT)).toBe(true);
    expect(CLAUDE_DESKTOP_DOC).toContain(
      "[`screenshots/claude-desktop/m5-10-list-kits.png`](./screenshots/claude-desktop/m5-10-list-kits.png)",
    );
    expect(CLAUDE_DESKTOP_DOC).toContain('`{"kits":[]}` result');
    expect(CLAUDE_DESKTOP_DOC).not.toContain("remaining AC6 evidence");
  });

  it("links the completed guide from the top-level Claude Desktop entry point", () => {
    expect(ROOT_README).toContain(
      "[Claude Desktop guide](https://ambitresearch.github.io/genie/harness/claude-desktop/)",
    );
    expect(ROOT_README).not.toContain("debugging guide will land separately in M5-10");
  });

  it("keeps shared harness prerequisites consistent and links this guide", () => {
    expect(HARNESS_OVERVIEW).toContain("[claude-desktop.md](./claude-desktop.md)");
    expect(HARNESS_OVERVIEW).toContain("`GENIE_LLM_API_KEY` is required at startup");
    expect(HARNESS_OVERVIEW).toContain("`OAUTH_HS256_KEY` is optional and HTTP-only");
    expect(HARNESS_OVERVIEW).toMatch(
      /`GENIE_LLM_BASE_URL` is required only for\s+`conjure` and `refine`/,
    );
    expect(HARNESS_OVERVIEW).toMatch(
      /the current `conjure_screen` implementation is an\s+offline deterministic scaffold/,
    );
    expect(HARNESS_OVERVIEW).not.toMatch(/read tools work without\s+an LLM configured/i);
  });

  it("preserves the M2 JUnit report when the self-hosted canary runs this suite", () => {
    expect(CI_WORKFLOW).toContain(
      "CI=false VITEST_JUNIT=0 pnpm --filter @ambitresearch/genie-e2e test:e2e:claude-desktop",
    );
  });
});

describe.skipIf(!hasBuiltServer)("Desktop stdio coverage (not AC6 evidence)", () => {
  let client: Client;
  let genieHome = "";
  let kitsRoot = "";
  const tempDirs: string[] = [];

  beforeAll(async () => {
    genieHome = await mkdtemp(join(tmpdir(), "genie-m5-claude-desktop-home-"));
    tempDirs.push(genieHome);
    kitsRoot = await mkdtemp(join(tmpdir(), "genie-m5-claude-desktop-kits-"));
    tempDirs.push(kitsRoot);
    const stdioEnv = cleanSecretEnv(
      hasLlmEnv
        ? {
            GENIE_LLM_API_KEY: process.env.GENIE_LLM_API_KEY,
            GENIE_LLM_BASE_URL: process.env.GENIE_LLM_BASE_URL,
          }
        : {
            GENIE_LLM_API_KEY: "claude-desktop-smoke-test-not-a-real-secret-key",
            GENIE_LLM_BASE_URL: "http://127.0.0.1:1/v1",
          },
    );
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_CLI, "--transport", "stdio"],
      env: {
        ...(stdioEnv as Record<string, string>),
        GENIE_HOME: genieHome,
        GENIE_KITS_ROOT: kitsRoot,
      },
    });
    client = new Client({ name: "m5-smoke-claude-desktop", version: "0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each([
    {
      missing: "GENIE_LLM_API_KEY",
      env: {},
    },
  ])(
    "rejects Desktop startup when required secret $missing is absent",
    ({ missing, env }) => {
      const result = spawnSync(process.execPath, [SERVER_CLI, "--transport", "stdio"], {
        env: cleanSecretEnv(env),
        encoding: "utf8",
        input: "",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${missing} is required but not set.`);
    },
    30_000,
  );

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

    // DRO-1255 — the SDK client declares no `ui` capability, so `preview` prepares
    // BOTH deliveries and the local viewer really has to boot. When the viewer is
    // built (CI always, since `test:e2e:claude-desktop` builds it first), require a
    // live `viewerUrl` rather than accepting the file:// degradation.
    const preview = payload(previewResult) as {
      viewerUrl?: string;
      fileUrl?: string;
      embeddedError?: string;
      viewerError?: string;
      locality?: string;
    };
    expect(preview.locality).toBe("local");
    expect(preview.fileUrl).toMatch(/^file:\/\//);
    if (hasBuiltViewer) {
      expect(
        preview.viewerUrl,
        `preview took the fallback path with the viewer built: ${JSON.stringify(preview)}`,
      ).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\//);
      // #311 — viewer failures now land on `viewerError`, never on the inline
      // path's `embeddedError`. This assertion used to substring-match
      // `embeddedError`, which after the split can no longer carry a viewer
      // diagnosis at all: it would pass vacuously forever. Assert the viewer's
      // own channel is clean instead.
      expect(preview.viewerError ?? "").toBe("");
      const response = await fetch(preview.viewerUrl ?? "");
      expect(response.ok, `viewer URL ${preview.viewerUrl} did not serve`).toBe(true);
    }
  }, 60_000);

  it("list_kits is reachable over real stdio and reflects a kit created earlier in this chain", async () => {
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

  it.skipIf(!hasLlmEnv)(
    "conjure -> plan -> write_files -> preview is one contiguous chain over real stdio when an LLM endpoint is configured",
    async () => {
      const kitResult = (await client.callTool({
        name: "mcp__genie__create_kit",
        arguments: { name: "Claude Desktop Smoke Conjure Kit" },
      })) as ToolResult;
      expect(kitResult.isError, JSON.stringify(kitResult)).not.toBe(true);
      const kitId = (payload(kitResult) as { kitId: string }).kitId;

      const conjureResult = (await client.callTool(
        {
          name: "mcp__genie__conjure",
          arguments: {
            kitId,
            kit: "A minimal UI kit. Uses semantic HTML and plain CSS.",
            prompt: "a small button component",
          },
        },
        CallToolResultSchema,
        { timeout: LIVE_CONJURE_TIMEOUT_MS },
      )) as ToolResult;
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
    LIVE_CHAIN_TEST_TIMEOUT_MS,
  );
});
