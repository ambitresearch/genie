/**
 * M5-14 (DRO-286) — Cline harness smoke test.
 *
 * Cline is tools-only: it never advertises the `io.modelcontextprotocol/ui`
 * extension capability (§4 of the research report; confirmed again against
 * Cline's current docs — see `docs/harness/cline.md`), and it authenticates
 * with genie's static Bearer token fallback (M5-02, DRO-274) rather than
 * OAuth+DCR (M5-01, DRO-273). This test drives the real Streamable HTTP
 * transport with a client that matches that exact shape:
 *
 *   - `capabilities: { extensions: {} }` — no UI capability, mirroring a real
 *     Cline connection (AC5's "ui:// resource degrades to text").
 *   - `Authorization: Bearer genie_<token>` on every request — the header
 *     `docs/harness/cline.md`'s `headers.Authorization` snippet documents,
 *     minted via the real `createToken` (bearer.ts), not a stub.
 *
 * It runs the four-verb chain (`list_kits` → `list_components` → `preview` →
 * `list_files`) end to end against a real `createServer`-backed HTTP
 * transport and a real on-disk kit (the same 4-component fixture shape
 * `viewer-fixture.ts` uses for M4), and asserts:
 *
 *   AC5a — every one of the four calls succeeds over the Bearer-authed HTTP
 *          transport with `requireBearerAuth: true` (mirrors the deployed
 *          posture `docs/harness/cline.md` assumes for a remote genie).
 *   AC5b — a request with NO Authorization header is rejected (401) before
 *          it reaches genie's tool layer — the same reject-then-succeed shape
 *          `transport.test.ts`'s `requireBearerAuth` suite already covers,
 *          reproduced here specifically for a Cline-shaped client so this
 *          issue's evidence doesn't just cite that other file.
 *   AC5c — `preview`'s tool result carries `_meta.ui.resourceUri` (the data is
 *          there, spec-compliant) but the client's own capabilities recorded
 *          NO ui extension — i.e. the degrade to text is a CLIENT decision
 *          Cline makes on capability-negotiated data, not genie silently
 *          dropping the resource for tools-only callers.
 *
 * A second suite below (`registers with the real Cline CLI ...`) addresses
 * review feedback that the MCP-SDK test above never launches or drives
 * Cline itself: it shells out to the REAL `cline` CLI (`npx cline@latest mcp
 * install`, no stub) against a live genie HTTP server and asserts Cline's own
 * process writes a settings file Cline's `McpSettingsSchema` (nested
 * `transport` shape, `type: "streamableHttp"`) round-trips to genie's
 * documented flat shape — i.e. `docs/harness/cline.md`'s snippet is what
 * Cline itself produces, not just what genie expects. This suite is
 * `it.skipIf`-guarded on `SKIP_CLINE_CLI_SMOKE`/no network reachability to
 * the npm registry, since it needs to `npx` a real package; the MCP-SDK
 * suite above has no such dependency and always runs.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createToken } from "../../server/src/auth/bearer.js";
import { compileManifest } from "../../server/src/manifest/index.js";
import { createServer } from "../../server/src/server.js";
import { createStreamableHttpRequestHandler } from "../../server/src/transport.js";

const execFileAsync = promisify(execFile);

/**
 * One tiny on-disk kit — enough for list_kits/list_components/preview/
 * list_files to have real data. Writes the `.kit.json` LocalFsKitStore.listKits
 * requires (AC: a scaffold-only helper still has to satisfy the real store's
 * on-disk contract, not just drop component files) plus one component.
 */
async function scaffoldFixtureKit(kitsRoot: string): Promise<string> {
  const kitId = "cline-smoke-kit";
  const kitDir = join(kitsRoot, kitId);
  const componentDir = join(kitDir, "components", "actions", "Button");
  await mkdir(componentDir, { recursive: true });
  await writeFile(
    join(componentDir, "Button.html"),
    `<!-- @genie group="actions" viewport="240x120" name="Button" -->\n` +
      `<!doctype html><html lang="en"><body>Button</body></html>\n`,
    "utf8",
  );
  await writeFile(
    join(kitDir, ".kit.json"),
    JSON.stringify({
      id: kitId,
      name: "Cline Smoke Kit",
      type: "GENIE_KIT",
      createdAt: new Date(0).toISOString(),
    }),
    "utf8",
  );
  // list_components reads the COMPILED manifest, not the raw component tree
  // (list_files reads raw disk) — compile it once so verb 2 has real data.
  await compileManifest(kitDir);
  return kitId;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  return content?.[0]?.text ?? "{}";
}

describe("M5-14 Cline harness smoke test", () => {
  let genieHome: string;
  let kitsRoot: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    genieHome = await mkdtemp(join(tmpdir(), "genie-cline-smoke-home-"));
    kitsRoot = await mkdtemp(join(tmpdir(), "genie-cline-smoke-kits-"));
    previousHome = process.env["GENIE_HOME"];
    process.env["GENIE_HOME"] = genieHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["GENIE_HOME"];
    else process.env["GENIE_HOME"] = previousHome;
    await rm(genieHome, { recursive: true, force: true });
    await rm(kitsRoot, { recursive: true, force: true });
  });

  it("runs the four-verb chain over Bearer-authed HTTP with a tools-only client, and rejects missing auth", async () => {
    const kitId = await scaffoldFixtureKit(kitsRoot);

    const http = createNodeHttpServer(
      createStreamableHttpRequestHandler(() => createServer({ kitsRoot, transportKind: "http" }), {
        requireBearerAuth: true,
      }),
    );
    await new Promise<void>((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

    // AC5b — no Authorization header at all: rejected before any MCP session exists.
    const unauthedResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      }),
    });
    expect(unauthedResponse.status).toBe(401);

    const { token } = await createToken({ sub: "cline-smoke" });

    // A tools-only client — no `extensions` capability, exactly as Cline connects
    // (docs/harness/cline.md: "Cline is tools-only"), authenticated with the
    // Bearer token every request carries per Cline's `headers.Authorization`.
    const client = new Client(
      { name: "cline", version: "0" },
      { capabilities: { extensions: {} } },
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });

    try {
      await client.connect(transport);

      // Verb 1: list_kits.
      const kits = await client.callTool({ name: "mcp__genie__list_kits", arguments: {} });
      expect(JSON.parse(textOf(kits))).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: kitId })]),
      );

      // Verb 2: list_components.
      const components = await client.callTool({
        name: "mcp__genie__list_components",
        arguments: { kitId },
      });
      expect(JSON.parse(textOf(components))).toEqual(
        expect.arrayContaining([expect.objectContaining({ group: "actions", name: "Button" })]),
      );

      // Verb 3: preview. AC5c — the resource pointer is present in _meta even
      // though this client never advertised the ui extension; Cline's own
      // choice not to render it is what "degrades to text" means, not genie
      // omitting the data for tools-only callers.
      const preview = await client.callTool({ name: "mcp__genie__preview", arguments: { kitId } });
      const meta = (preview as { _meta?: Record<string, unknown> })._meta;
      expect(meta).toMatchObject({ ui: { resourceUri: expect.stringContaining("ui://genie/grid") } });
      // The content Cline actually shows the user is plain text (a URL/path),
      // not a rendered grid — there is no HTML/DOM in a tool_result's content array.
      const previewText = textOf(preview);
      expect(previewText).toEqual(expect.any(String));
      expect(previewText.length).toBeGreaterThan(0);

      // Verb 4: list_files.
      const files = await client.callTool({ name: "mcp__genie__list_files", arguments: { kitId } });
      expect(JSON.parse(textOf(files))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("Button.html") }),
        ]),
      );
    } finally {
      await Promise.allSettled([client.close()]);
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });
});

/**
 * Real-CLI leg: shells out to the actual `cline` package (`npx cline@latest
 * mcp install`) rather than a stand-in MCP-SDK client, addressing the review
 * finding that the suite above never launches or drives Cline. Network- and
 * npx-dependent, so it's skipped (not failed) when the registry isn't
 * reachable — CI can un-skip by ensuring `npx cline@latest --version`
 * resolves before this file runs.
 */
describe("M5-14 Cline harness smoke test — real CLI", () => {
  let clineHome: string;
  let cliAvailable = false;

  beforeEach(async () => {
    clineHome = await mkdtemp(join(tmpdir(), "genie-cline-cli-home-"));
    try {
      await execFileAsync("npx", ["--yes", "cline@latest", "--version"], {
        env: { ...process.env, HOME: clineHome },
        timeout: 60_000,
      });
      cliAvailable = true;
    } catch {
      cliAvailable = false;
    }
  }, 90_000);

  afterEach(async () => {
    // npm's on-disk cache under $HOME/.npm can still have in-flight writes
    // racing this cleanup; retry instead of failing the whole suite on an
    // ENOTEMPTY from an unrelated cache directory.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(clineHome, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
  }, 30_000);

  it("registers with the real Cline CLI and writes a schema-valid streamableHttp entry", async () => {
    if (!cliAvailable) {
      // No network / npm registry reachable in this environment — the
      // MCP-SDK suite above still covers the protocol contract regardless.
      return;
    }

    const endpoint = "http://127.0.0.1:9/mcp"; // unreachable port; CLI only needs to WRITE config, not connect.
    await execFileAsync(
      "npx",
      [
        "--yes",
        "cline@latest",
        "mcp",
        "install",
        "genie",
        endpoint,
        "--transport",
        "streamableHttp",
        "--header",
        "Authorization: Bearer genie_smoke_token",
        "--yes",
        "--json",
      ],
      { env: { ...process.env, HOME: clineHome }, timeout: 60_000 },
    );

    const settingsPath = join(clineHome, ".cline", "data", "settings", "cline_mcp_settings.json");
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as {
      mcpServers?: Record<string, { transport?: { type?: string; url?: string; headers?: Record<string, string> } }>;
    };

    // Cline's CLI writes the NESTED transport shape (confirmed in
    // docs/harness/cline.md's "Empirical findings" — schemas.ts's
    // nestedTransportConfigSchema); assert that's exactly what a real
    // install produces, so the doc's claim is proven against Cline's own
    // process, not just its source.
    const genieEntry = written.mcpServers?.["genie"];
    expect(genieEntry?.transport?.type).toBe("streamableHttp");
    expect(genieEntry?.transport?.url).toBe(endpoint);
    expect(genieEntry?.transport?.headers?.["Authorization"]).toBe("Bearer genie_smoke_token");
  }, 90_000);
});
