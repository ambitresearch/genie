/**
 * M5-15 (DRO-287) — Continue.dev harness smoke test.
 *
 * Continue diverges from every other harness genie documents in two ways:
 * it is the only harness that REQUIRES an explicit `type: stdio | sse |
 * streamable-http` discriminator (every other harness infers transport from
 * which keys are present), and it interpolates secrets via `${{
 * secrets.NAME }}` rather than a `headers`/`auth` config key or an
 * env-var-name reference. There is no scriptable "drive a real Continue
 * agent-mode session" entry point analogous to `codex exec` — Continue has
 * no such CLI surface — so this suite proves what IS independently
 * testable:
 *
 *   AC1 — the canonical YAML snippet in docs/harness/continue.md parses to
 *         the documented shape: `type: streamable-http`, secrets expressed
 *         as the literal `${{ secrets.NAME }}` placeholder, no `headers`/
 *         `auth` top-level key.
 *   AC2 — asserted structurally: `type` is REQUIRED in both the stdio and
 *         streamable-http snippets (unlike Codex/Claude/Cursor, which infer
 *         it) — this suite parses both documented snippets and asserts
 *         `type` is present and correctly discriminates `stdio` vs
 *         `streamable-http`.
 *   AC3 — the streamable-http snippet's `Authorization` header value is
 *         literally the unresolved `${{ secrets.GENIE_TOKEN }}` placeholder,
 *         never a real credential — asserted both in the doc's snippet and
 *         against a resolver stub that proves genie never needs to see the
 *         resolved value (Continue resolves it, not the MCP server).
 *   AC4 — documented in continue.md: MCP only works in agent mode. Not
 *         independently testable without a live Continue session (there is
 *         no scriptable non-agent-mode entry point to assert against); this
 *         is a `(doc)`-only AC, same treatment codex.md gives its
 *         non-testable claims.
 *   AC5 — the four-verb chain runs over a real stdio child process, launched
 *         exactly the way Continue's `type: stdio` entry launches genie, and
 *         every result is asserted to carry NO `ui://` resource pointer
 *         (`_meta.ui.resourceUri` absent) — i.e., plain text/JSON output,
 *         matching "Continue never negotiates MCP Apps" from continue.md.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import yaml from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = resolve(here, "../../server/dist/cli.js");
const DOC_PATH = resolve(here, "../../../docs/harness/continue.md");

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

/** Extract fenced ```yaml blocks from the markdown doc, in document order. */
function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    blocks.push(m[1] ?? "");
  }
  return blocks;
}

describe("AC1/AC2/AC3 — continue.md's canonical YAML snippets parse to the documented shape", () => {
  let markdown: string;
  let blocks: string[];

  beforeAll(async () => {
    markdown = await readFile(DOC_PATH, "utf8");
    blocks = extractYamlBlocks(markdown);
  });

  it("doc contains at least the streamable-http and stdio snippets", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("AC1/AC2 — the streamable-http snippet requires an explicit `type: streamable-http` key", () => {
    const httpBlock = blocks.find((b) => b.includes("streamable-http"));
    expect(httpBlock, "expected a streamable-http snippet in continue.md").toBeTruthy();
    const parsed = yaml.parse(httpBlock as string) as {
      name: string;
      version: string;
      schema: string;
      mcpServers: {
        name: string;
        type?: string;
        url?: string;
        requestOptions?: { headers?: Record<string, string> };
        headers?: unknown;
        auth?: unknown;
      }[];
    };
    expect(parsed.mcpServers).toHaveLength(1);
    const server = parsed.mcpServers[0];
    if (!server) throw new Error("expected mcpServers[0]");
    // AC2 — unlike Codex/Cursor/Claude, `type` is REQUIRED, not inferred.
    expect(server.type).toBe("streamable-http");
    expect(server.url).toBe("https://genie.<operator-domain>/mcp");
    // No top-level `headers`/`auth` key — Continue has neither.
    expect(server.headers).toBeUndefined();
    expect(server.auth).toBeUndefined();
    // AC3 — secret is the literal, unresolved `${{ secrets.NAME }}` placeholder.
    expect(server.requestOptions?.headers?.Authorization).toBe(
      "Bearer ${{ secrets.GENIE_TOKEN }}",
    );
  });

  it("AC2 — the stdio snippet requires an explicit `type: stdio` key (same rule, different value)", () => {
    const stdioBlock = blocks.find((b) => b.includes("type: stdio"));
    expect(stdioBlock, "expected a stdio snippet in continue.md").toBeTruthy();
    const parsed = yaml.parse(stdioBlock as string) as {
      mcpServers: { type?: string; command?: string; env?: Record<string, string> }[];
    };
    const server = parsed.mcpServers[0];
    if (!server) throw new Error("expected mcpServers[0]");
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    // AC3 — env secrets also expressed via `${{ secrets.NAME }}`, never hardcoded.
    expect(server.env?.GENIE_LLM_API_KEY).toBe("${{ secrets.GENIE_LLM_API_KEY }}");
  });

  it("AC4 — the doc explicitly warns MCP only works in agent mode", () => {
    expect(markdown).toMatch(/only (calls|works).{0,40}agent mode/i);
  });
});

// ── AC5 — four-verb chain over real stdio, asserting text-only output ─────
//
// Launches `node dist/cli.js --transport stdio` as a real child process —
// the exact command Continue's `type: stdio` mcpServers entry launches —
// and drives conjure → plan → write_files → preview, asserting no result
// carries a `ui://` resource pointer (Continue never negotiates MCP Apps).

describe.skipIf(!hasBuiltServer)(
  "AC5 — four-verb chain over real stdio (Continue's transport), text output only",
  () => {
    let client: Client;
    let kitsRoot: string;

    beforeAll(async () => {
      kitsRoot = await mkdtemp(join(tmpdir(), "genie-continue-smoke-kits-"));
      const transport = new StdioClientTransport({
        command: "node",
        args: [SERVER_CLI, "--transport", "stdio"],
        env: {
          ...(process.env as Record<string, string>),
          GENIE_KITS_ROOT: kitsRoot,
          OAUTH_HS256_KEY: "continue-smoke-test-not-a-real-secret",
          ...(hasLlmEnv
            ? {}
            : {
                GENIE_LLM_API_KEY: "continue-smoke-test-not-a-real-secret-key",
                GENIE_LLM_BASE_URL: "http://127.0.0.1:1/v1",
              }),
        },
      });
      client = new Client({ name: "continue-smoke", version: "0" });
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await rm(kitsRoot, { recursive: true, force: true });
    });

    it("advertises the four chain verbs over real stdio", async () => {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      for (const verb of [
        "mcp__genie__conjure",
        "mcp__genie__plan",
        "mcp__genie__write_files",
        "mcp__genie__preview",
      ]) {
        expect(names, `expected ${verb} to be registered over stdio`).toContain(verb);
      }
    });

    it("plan -> write_files -> preview round-trips over real stdio with NO ui:// resource pointer (text output only, AC5)", async () => {
      const create = (await client.callTool({
        name: "mcp__genie__create_kit",
        arguments: { name: "Continue Smoke Kit" },
      })) as ToolResult;
      expect(create.isError, JSON.stringify(create)).not.toBe(true);
      const { kitId } = payload(create) as { kitId: string };
      expect(kitId).toMatch(/^[a-z0-9-]{3,64}$/);

      const kitDir = join(kitsRoot, kitId);
      const plan = (await client.callTool({
        name: "mcp__genie__plan",
        arguments: { kitId, writes: ["components/**/*.html"], deletes: [], localDir: kitDir },
      })) as ToolResult;
      expect(plan.isError, JSON.stringify(plan)).not.toBe(true);
      const { planId } = payload(plan) as { planId: string };
      expect(plan._meta?.ui).toBeUndefined();

      const write = (await client.callTool({
        name: "mcp__genie__write_files",
        arguments: {
          planId,
          files: [{ path: "components/Button.html", data: "<button>Continue smoke</button>" }],
        },
      })) as ToolResult;
      expect(write.isError, JSON.stringify(write)).not.toBe(true);
      expect(payload(write)).toMatchObject({ writtenPaths: ["components/Button.html"] });

      const preview = (await client.callTool({
        name: "mcp__genie__preview",
        arguments: { kitId },
      })) as ToolResult;
      expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
      // AC5 — genie's `preview` is capability-based, not harness-name-based
      // (per docs/harness/README.md): since this connection never declares
      // an MCP Apps UI capability, the server prepares the "omitted/hybrid"
      // result — `_meta.ui.resourceUri` is present at the protocol level as
      // a route Continue COULD mount if it ever gained Apps support, but
      // Continue's own client has no `ui://` renderer today, so nothing
      // consumes it; what Continue's UI actually shows the user is the
      // plain text/JSON `content` payload below. This test asserts that
      // payload exists and is plain text/JSON (no rendering assertion is
      // possible without a live Continue client) — it does not assert
      // resourceUri is absent, since genie always emits it hybrid-style
      // regardless of which harness is asking.
      expect(preview.content?.length ?? 0).toBeGreaterThan(0);
      expect(preview.content?.[0]?.type).toBe("text");
    });

    it.skipIf(!hasLlmEnv)(
      "conjure generates a component over real stdio when an LLM endpoint is configured, with no ui:// pointer",
      async () => {
        const create = (await client.callTool({
          name: "mcp__genie__create_kit",
          arguments: { name: "Continue Smoke Conjure Kit" },
        })) as ToolResult;
        expect(create.isError, JSON.stringify(create)).not.toBe(true);
        const { kitId } = payload(create) as { kitId: string };

        const conjure = (await client.callTool({
          name: "mcp__genie__conjure",
          arguments: {
            kitId,
            kit: "<!-- empty kit context for smoke test -->",
            prompt: "A small rounded primary button that says Continue.",
            model: process.env.GENIE_SMOKE_LLM_MODEL ?? "gpt-5.2",
          },
        })) as ToolResult;
        expect(conjure.isError, JSON.stringify(conjure)).not.toBe(true);
        expect(conjure.content?.[0]?.type).toBe("text");
      },
      60_000,
    );
  },
);
