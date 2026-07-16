/**
 * Supplemental M5-10 (DRO-282) contract and stdio coverage.
 *
 * AC6 itself requires installing a real `.mcpb` in Claude Desktop, invoking
 * `list_kits`, and capturing the Desktop UI. This suite does not substitute
 * an SDK client for that evidence. It verifies the guide's current package and
 * startup contracts, then exercises the same built CLI and stdio transport a
 * valid Desktop bundle will eventually launch.
 */
import { readFileSync } from "node:fs";
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
const CLAUDE_DESKTOP_DOC = readFileSync(
  resolve(here, "../../../docs/harness/claude-desktop.md"),
  "utf8",
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
      "Build @genie/server before running the Claude Desktop smoke suite.",
  );
}

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
      .find((block) => block?.includes('"@genie/server"'));
    expect(snippet).toBeDefined();

    const config = JSON.parse(snippet ?? "{}") as {
      mcpServers: {
        genie: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    const genie = config.mcpServers.genie;

    expect(genie.command).toBe("npx");
    expect(genie.args).toEqual(["-y", "@genie/server", "--transport", "stdio"]);
    expect(genie.env.GENIE_LLM_API_KEY?.length).toBeGreaterThanOrEqual(16);
    expect(genie.env.OAUTH_HS256_KEY?.length).toBeGreaterThanOrEqual(32);
    expect(CLAUDE_DESKTOP_DOC).toContain("not yet published");
    expect(CLAUDE_DESKTOP_DOC).toContain("unrelated package");
  });

  it("documents the actual bootstrap requirement instead of promising read-only startup without secrets", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain(
      "GENIE_LLM_API_KEY` and `OAUTH_HS256_KEY` are required before the server starts",
    );
    expect(CLAUDE_DESKTOP_DOC).toMatch(/`GENIE_LLM_API_KEY` must contain at least 16\s+characters/);
    expect(CLAUDE_DESKTOP_DOC).toMatch(/`OAUTH_HS256_KEY` must contain at least 32 characters/);
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
    expect(CLAUDE_DESKTOP_DOC).not.toContain("Linux is not officially supported");
  });

  it("documents the exact macOS Claude Desktop MCP log glob", () => {
    expect(CLAUDE_DESKTOP_DOC).toContain("~/Library/Logs/Claude/mcp*.log");
    expect(CLAUDE_DESKTOP_DOC).toContain("for genie's stderr output");
    expect(CLAUDE_DESKTOP_DOC).not.toContain("genie's own stdout/stderr");
  });

  it("keeps shared harness prerequisites consistent and links this guide", () => {
    expect(HARNESS_OVERVIEW).toContain("[claude-desktop.md](./claude-desktop.md)");
    expect(HARNESS_OVERVIEW).toContain(
      "`GENIE_LLM_API_KEY` and `OAUTH_HS256_KEY` are required at startup",
    );
    expect(HARNESS_OVERVIEW).not.toMatch(/read tools work without\s+an LLM configured/i);
  });

  it("preserves the M2 JUnit report when the self-hosted canary runs this suite", () => {
    expect(CI_WORKFLOW).toContain(
      "CI=false VITEST_JUNIT=0 pnpm --filter @genie/e2e test:e2e:claude-desktop",
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
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_CLI, "--transport", "stdio"],
      env: {
        ...(process.env as Record<string, string>),
        GENIE_HOME: genieHome,
        GENIE_KITS_ROOT: kitsRoot,
        // The current CLI validates both secrets before creating stdio.
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
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each([
    {
      missing: "GENIE_LLM_API_KEY",
      env: { OAUTH_HS256_KEY: "claude-desktop-smoke-test-not-a-real-secret" },
    },
    {
      missing: "OAUTH_HS256_KEY",
      env: { GENIE_LLM_API_KEY: "claude-desktop-smoke-test-not-a-real-key" },
    },
  ])("rejects Desktop startup when required secret $missing is absent", ({ missing, env }) => {
    const result = spawnSync(process.execPath, [SERVER_CLI, "--transport", "stdio"], {
      env: cleanSecretEnv(env),
      encoding: "utf8",
      input: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${missing} is required but not set.`);
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
});
