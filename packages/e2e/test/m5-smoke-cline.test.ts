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
 * It runs the ACTUAL documented four-verb workflow
 * (`conjure → plan → write_files → preview`, per `docs/harness/cline.md`'s
 * "Using it" section and the Skill's own workflow name) end to end against a
 * real `createServer`-backed HTTP transport and a real on-disk kit, calling
 * the server's REAL default `conjure` wiring (`defaultChatCompletion` via
 * `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` against a local HTTP stub standing
 * in for the OpenAI-compatible endpoint — the same pattern
 * `conjure.test.ts`'s "production wiring" suite uses), not a stand-in
 * in-process call to `conjure()` with an injected `deps.chat` the real server
 * never wires up. This addresses the review finding that a prior version of
 * this file exercised `list_kits → list_components → preview → list_files`
 * instead of the workflow the PR and docs actually claim.
 *
 * Registers the server with `previewLocality: "local"` (`--preview-locality
 * local` / `GENIE_PREVIEW_LOCALITY=local`), matching a Cline session on the
 * same machine as the server — the scenario `docs/harness/cline.md` documents
 * as producing a concrete, clickable viewer/`file://` result — and asserts on
 * `structuredContent.viewerUrl`/`fileUrl` directly (not a truthy/non-empty
 * `content[0].text`, which a `"Remote preview unavailable: …"` string or the
 * `textOf` helper's `"{}"` placeholder would also satisfy).
 *
 * Assertions:
 *
 *   AC5a — the full documented chain succeeds over the Bearer-authed HTTP
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
 *          dropping the resource for tools-only callers — AND the concrete
 *          `viewerUrl`/`fileUrl` a local-locality Cline session actually sees
 *          is present in `structuredContent`, matching `docs/harness/cline.md`.
 *
 * A second suite below addresses the gap an MCP-SDK client cannot cover. It
 * runs pinned Cline 3.0.42 itself against a local OpenAI-compatible model stub
 * and the real Bearer-protected genie HTTP server. The model stub directs
 * Cline through conjure -> plan -> write_files -> preview; Cline's JSON event
 * transcript must contain those real tool calls in order, non-error results,
 * and the remote preview fallback text. Platform binaries are pinned optional
 * dependencies, so CI never reaches the registry during the test and never
 * silently skips the harness leg.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNodeHttpServer, type Server as NodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createToken } from "../../server/src/auth/bearer.js";
import type { ChatCompletionResult } from "../../server/src/llm/client.js";
import { compileManifest } from "../../server/src/manifest/index.js";
import { createServer } from "../../server/src/server.js";
import type { ChatCompletionFn } from "../../server/src/tools/conjure.js";
import { DEFAULT_VIEWER_PORT, type ViewerBooter } from "../../server/src/tools/preview.js";
import { createStreamableHttpRequestHandler } from "../../server/src/transport.js";
import { bootViewer } from "../../viewer/src/index.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLINE_VERSION = "3.0.42";
const CLINE_PLATFORM = process.platform === "win32" ? "windows" : process.platform;
const requireFromHere = createRequire(import.meta.url);
const clinePackageDir = dirname(
  requireFromHere.resolve(`@cline/cli-${CLINE_PLATFORM}-${process.arch}/package.json`),
);
const CLINE_BIN = join(
  clinePackageDir,
  "bin",
  process.platform === "win32" ? "cline.exe" : "cline",
);
const CLINE_DOC = join(HERE, "../../../docs/harness/cline.md");
const READ_ONLY_AUTO_APPROVE = [
  "mcp__genie__list_components",
  "mcp__genie__preview",
  "mcp__genie__list_files",
];

async function documentedClineConfig(options: {
  url: string;
  token: string;
}): Promise<Record<string, unknown>> {
  const markdown = await readFile(CLINE_DOC, "utf8");
  const section = markdown.match(/## Register the server[^]*?```json\n([^]*?)\n```/)?.[1];
  if (!section) throw new Error("docs/harness/cline.md has no registration JSON block");
  return JSON.parse(
    section
      .replace("https://genie.<operator-domain>/mcp", options.url)
      .replace("<paste-token-here>", options.token),
  ) as Record<string, unknown>;
}

function createSourceViewerBooter(): { booter: ViewerBooter; closeAll: () => Promise<void> } {
  const closeViewers = new Set<() => Promise<void>>();
  const booter: ViewerBooter = async ({ kitDir, port, open }) => {
    const handle = await bootViewer(
      { root: kitDir, port: port ?? DEFAULT_VIEWER_PORT, open: open ?? false },
      {
        stdout: (chunk) => process.stderr.write(chunk),
        stderr: (chunk) => process.stderr.write(chunk),
      },
    );
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= handle.close().finally(() => closeViewers.delete(close));
      return closing;
    };
    closeViewers.add(close);
    return { ...handle, close };
  };
  return {
    booter,
    closeAll: () => Promise.all([...closeViewers].map((close) => close())).then(() => undefined),
  };
}

/**
 * One tiny on-disk kit — enough for conjure/plan/write_files/preview to have
 * real data. Writes the `.kit.json` LocalFsKitStore.listKits requires (AC: a
 * scaffold-only helper still has to satisfy the real store's on-disk
 * contract, not just drop component files) plus one component, so `preview`
 * (the last of the four verbs) has a real kit directory to serve.
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
  // @genie/viewer's multi-page Vite config always includes the kit root's
  // `index.html` as the `main` Rollup entry (config.ts:227), independent of
  // how many component previews exist. Without this file present, Vite's
  // dependency-scan step fails to resolve that entry — the dev server still
  // starts and this test's `viewerUrl`/`fileUrl` assertions still pass, but
  // only because they check the URL shape, not that the page actually
  // renders. Write a minimal root page so `preview`'s viewer fallback boots
  // a real, functioning viewer response, matching a genuine kit dir instead
  // of exercising a silently degraded dep-scan path.
  await writeFile(
    join(kitDir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<title>cline smoke kit</title></head><body><main id="grid">` +
      `cline smoke fixture</main></body></html>\n`,
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
  await compileManifest(kitDir);
  return kitId;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  return content?.[0]?.text ?? "{}";
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  return (result as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent;
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

it("preserves generated base64 metadata when handing files to write_files", () => {
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

/**
 * A minimal OpenAI-compatible chat-completions stub for `conjure`'s REAL
 * default seam (`defaultChatCompletion`, driven by `GENIE_LLM_BASE_URL` /
 * `GENIE_LLM_API_KEY` — see `conjure.test.ts`'s "production wiring" suite,
 * which this mirrors). This suite deliberately leaves `createServer`'s
 * `conjureDeps` seam unset; the real-CLI suite below injects it separately.
 */
function startLlmStub(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const componentBody = {
    componentName: "Button",
    group: "actions",
    files: [
      {
        path: "components/actions/Button/Button.html",
        content:
          '<!-- @genie group="actions" viewport="240x120" name="Button" -->\n<button>Click me</button>',
        mimeType: "text/html",
      },
    ],
    manifestEntry: { viewport: { width: 240, height: 120 }, subtitle: "Primary button" },
  };
  const server: NodeHttpServer = createNodeHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-cline-smoke",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "design-default",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(componentBody) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveListen({
        baseURL: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
          }),
      });
    });
  });
}

describe("M5-14 Cline harness smoke test", () => {
  let genieHome: string;
  let kitsRoot: string;
  let previousHome: string | undefined;
  let previousLlmBaseUrl: string | undefined;
  let previousLlmApiKey: string | undefined;

  beforeEach(async () => {
    genieHome = await mkdtemp(join(tmpdir(), "genie-cline-smoke-home-"));
    kitsRoot = await mkdtemp(join(tmpdir(), "genie-cline-smoke-kits-"));
    previousHome = process.env["GENIE_HOME"];
    previousLlmBaseUrl = process.env["GENIE_LLM_BASE_URL"];
    previousLlmApiKey = process.env["GENIE_LLM_API_KEY"];
    process.env["GENIE_HOME"] = genieHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["GENIE_HOME"];
    else process.env["GENIE_HOME"] = previousHome;
    if (previousLlmBaseUrl === undefined) delete process.env["GENIE_LLM_BASE_URL"];
    else process.env["GENIE_LLM_BASE_URL"] = previousLlmBaseUrl;
    if (previousLlmApiKey === undefined) delete process.env["GENIE_LLM_API_KEY"];
    else process.env["GENIE_LLM_API_KEY"] = previousLlmApiKey;
    await rm(genieHome, { recursive: true, force: true });
    await rm(kitsRoot, { recursive: true, force: true });
  });

  it("runs the documented conjure -> plan -> write_files -> preview chain over Bearer-authed HTTP with a tools-only client, and rejects missing auth", async () => {
    const kitId = await scaffoldFixtureKit(kitsRoot);
    const llmStub = await startLlmStub();
    process.env["GENIE_LLM_BASE_URL"] = llmStub.baseURL;
    process.env["GENIE_LLM_API_KEY"] = "genie-smoke-llm-key";
    const sourceViewer = createSourceViewerBooter();

    const http = createNodeHttpServer(
      createStreamableHttpRequestHandler(
        () =>
          createServer({
            kitsRoot,
            transportKind: "http",
            // A genuinely same-machine HTTP client, per docs/harness/cline.md's
            // "--preview-locality local / GENIE_PREVIEW_LOCALITY=local" note —
            // this is the scenario the doc promises a concrete viewerUrl for.
            previewLocality: "local",
            // Test the real viewer without relying on ignored build output.
            // A clean test job has viewer source + dependencies but no dist/;
            // createServer's supported booter seam keeps that build order from
            // changing preview's truthful production fallback behavior.
            previewBooter: sourceViewer.booter,
          }),
        { requireBearerAuth: true },
      ),
    );
    await new Promise<void>((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

    try {
      // AC5b — no Authorization header at all: rejected before any MCP session exists.
      const unauthedResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "x", version: "0" },
          },
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

        // Verb 1: conjure — real LLM component generation against the
        // production `defaultChatCompletion` seam (no deps.chat stub).
        const conjured = await client.callTool({
          name: "mcp__genie__conjure",
          arguments: {
            kitId,
            kit: "A minimal warm-neutral UI kit. Buttons use rounded corners.",
            prompt: "a simple primary button labeled Click me",
          },
        });
        expect(conjured.isError).not.toBe(true);
        const conjureResult = JSON.parse(textOf(conjured)) as {
          files: ConjuredFile[];
        };
        expect(conjureResult.files.length).toBeGreaterThan(0);

        // Verb 2: plan — locks the write glob for the files conjure returned.
        const planned = await client.callTool({
          name: "mcp__genie__plan",
          arguments: {
            kitId,
            writes: conjureResult.files.map((f) => f.path),
            localDir: kitsRoot,
          },
        });
        expect(planned.isError).not.toBe(true);
        const { planId } = JSON.parse(textOf(planned)) as { planId: string };
        expect(planId).toEqual(expect.any(String));

        // Verb 3: write_files — commits conjure's output into the kit under
        // the plan's write grant.
        const written = await client.callTool({
          name: "mcp__genie__write_files",
          arguments: {
            planId,
            files: conjureResult.files.map(toWriteFileInput),
          },
        });
        expect(written.isError).not.toBe(true);
        expect(JSON.parse(textOf(written))).toEqual(
          expect.objectContaining({
            writtenPaths: expect.arrayContaining(conjureResult.files.map((f) => f.path)),
          }),
        );

        // Verb 4: preview. AC5c — the resource pointer is present in _meta even
        // though this client never advertised the ui extension; Cline's own
        // choice not to render it is what "degrades to text" means, not genie
        // omitting the data for tools-only callers. With local preview
        // locality (matching docs/harness/cline.md's browsable-viewer path),
        // structuredContent carries a CONCRETE viewerUrl/fileUrl — not just a
        // non-empty text string, which a "Remote preview unavailable" message
        // would also satisfy.
        const preview = await client.callTool({
          name: "mcp__genie__preview",
          arguments: { kitId },
        });
        expect(preview.isError).not.toBe(true);
        const meta = (preview as { _meta?: Record<string, unknown> })._meta;
        expect(meta).toMatchObject({
          ui: { resourceUri: expect.stringContaining("ui://genie/grid") },
        });
        const previewStructured = structuredOf(preview);
        expect(previewStructured?.["viewerUrl"]).toEqual(expect.stringMatching(/^https?:\/\//));
        expect(previewStructured?.["fileUrl"]).toEqual(expect.stringMatching(/^file:\/\//));
        // The content Cline actually shows the user is plain text quoting that
        // same concrete URL — there is no HTML/DOM in a tool_result's content array.
        const previewText = textOf(preview);
        expect(previewText).toContain(previewStructured?.["viewerUrl"] as string);
        // Prove the viewer is a genuinely functioning response, not just a
        // well-shaped URL string — fetch it and confirm the booted Vite dev
        // server actually serves the fixture kit's root page.
        const viewerResponse = await fetch(previewStructured?.["viewerUrl"] as string);
        expect(viewerResponse.status).toBe(200);
        const viewerBody = await viewerResponse.text();
        expect(viewerBody).toContain("cline smoke fixture");
      } finally {
        // Explicitly terminate the MCP session (HTTP DELETE) BEFORE closing
        // the client transport. `client.close()` alone only aborts the local
        // fetch/SSE plumbing — it never notifies the server, so the
        // server-side session (and this suite's `previewRegistry`, which
        // booted a real Vite dev server for `kitsRoot`) would otherwise only
        // get torn down on the session's idle timeout, long after this test
        // (and its `afterEach`) has already deleted `kitsRoot`. That race is
        // exactly what produced the reviewer-reported `ENOENT` from Vite's
        // dependency scan still running against a since-deleted kit dir.
        // `terminateSession` drives the server's DELETE handler and starts the
        // `disposeSession` -> `previewRegistry.closeAll()` chain. The outer
        // finally explicitly awaits the same idempotent viewer close because
        // the transport does not await asynchronous server disposers.
        await transport.terminateSession().catch(() => undefined);
        await Promise.allSettled([client.close()]);
      }
    } finally {
      // HTTP session disposal starts asynchronously after DELETE. Await the
      // same idempotent close promise here before afterEach removes kitsRoot.
      await sourceViewer.closeAll();
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
      await llmStub.close();
    }
  });
});

interface ClineJsonEvent {
  type?: string;
  event?: {
    type?: string;
    contentType?: string;
    toolName?: string;
    output?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  finishReason?: string;
  text?: string;
}

function parseClineJson(stdout: string): ClineJsonEvent[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as ClineJsonEvent);
}

function requireCompleteClineToolCalls(events: ClineJsonEvent[]): ClineJsonEvent[] {
  const toolEvents = events.filter(
    (event) => event.type === "agent_event" && event.event?.contentType === "tool",
  );
  const starts = toolEvents
    .filter((event) => event.event?.type === "content_start")
    .map((event) => event.event?.toolName);
  const completions = toolEvents
    .filter((event) => event.event?.type === "content_end")
    .map((event) => event.event?.toolName);
  if (
    starts.length !== completions.length ||
    starts.some((name, index) => completions[index] !== name)
  ) {
    throw new Error(
      `Cline tool transcript mismatch: started ${starts.join(", ")}; completed ${completions.join(", ")}`,
    );
  }
  return toolEvents;
}

function isolatedClineEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const normalizedName = name.toUpperCase();
    if (
      value === undefined ||
      normalizedName.startsWith("CLINE_") ||
      normalizedName === "GENIE_PREVIEWS_BASE_URL"
    ) {
      continue;
    }
    childEnv[name] = value;
  }
  Object.assign(childEnv, {
    CLINE_TELEMETRY_DISABLED: "1",
    CLINE_NO_AUTO_UPDATE: "1",
    CLINE_DISABLE_CLINE_PASS_NOTICE: "1",
    NO_UPDATE_NOTIFIER: "1",
  });
  return childEnv;
}

it("removes preview-origin and Cline overrides from the real-CLI child", () => {
  const isolated = isolatedClineEnv({
    PATH: "/bin",
    Cline_Data_Dir: "/real/cline",
    Cline_Mcp_Settings_Path: "/real/cline/settings.json",
    genie_previews_base_url: "https://previews.example.test",
  });

  expect(isolated).toMatchObject({ PATH: "/bin", CLINE_TELEMETRY_DISABLED: "1" });
  expect(isolated).not.toHaveProperty("Cline_Data_Dir");
  expect(isolated).not.toHaveProperty("Cline_Mcp_Settings_Path");
  expect(isolated).not.toHaveProperty("genie_previews_base_url");
});

it("rejects a Cline transcript with a started tool call that never completes", () => {
  expect(() =>
    requireCompleteClineToolCalls([
      { type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "a" } },
      { type: "agent_event", event: { type: "content_end", contentType: "tool", toolName: "a" } },
      { type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "b" } },
    ]),
  ).toThrow(/started.*a, b.*completed.*a/s);
});

it("keeps the canonical extension auto-approval list aligned with registered read tools", async () => {
  const config = await documentedClineConfig({
    url: "https://example.invalid/mcp",
    token: "genie_test_token",
  });
  const autoApprove = (config as { mcpServers?: { genie?: { autoApprove?: string[] } } }).mcpServers
    ?.genie?.autoApprove;

  const server = createServer();
  const client = new Client({ name: "cline-config-contract", version: "0" });
  const [clientTransport, serverTransport] =
    await import("@modelcontextprotocol/sdk/inMemory.js").then(({ InMemoryTransport }) =>
      InMemoryTransport.createLinkedPair(),
    );
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const registeredNames = new Set(tools.map((tool) => tool.name));

    expect(autoApprove).toEqual(READ_ONLY_AUTO_APPROVE);
    expect(autoApprove?.every((name) => registeredNames.has(name))).toBe(true);
    expect(autoApprove).not.toContain("mcp__genie__conjure");
    expect(autoApprove).not.toContain("mcp__genie__write_files");
  } finally {
    await client.close();
    await server.close();
  }
});

describe("M5-14 Cline harness smoke test — real CLI", () => {
  it("drives the four-verb chain through pinned Cline and surfaces preview text", async () => {
    const base = await mkdtemp(join(tmpdir(), "genie-cline-cli-smoke-"));
    const clineConfig = join(base, ".cline", "data", "settings");
    const kitsRoot = join(base, "kits");
    const previousHome = process.env["GENIE_HOME"];
    const previousPreviewsBaseUrl = process.env["GENIE_PREVIEWS_BASE_URL"];
    process.env["GENIE_HOME"] = join(base, "genie-home");
    delete process.env["GENIE_PREVIEWS_BASE_URL"];
    let mcp: NodeHttpServer | undefined;
    let model: NodeHttpServer | undefined;
    try {
      const kitId = await scaffoldFixtureKit(kitsRoot);
      const { token } = await createToken({ sub: "cline-cli-smoke" });
      const stubChat: ChatCompletionFn = async () =>
        ({
          id: "chatcmpl-cline-smoke",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "stub-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                refusal: null,
                content: JSON.stringify({
                  componentName: "Button",
                  group: "actions",
                  files: [
                    {
                      path: "components/actions/Button/Button.html",
                      content:
                        '<!-- @genie group="actions" viewport="240x120" name="Button" -->\n' +
                        "<button>Click me</button>",
                      mimeType: "text/html",
                    },
                  ],
                  manifestEntry: { viewport: { width: 240, height: 120 } },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) as unknown as ChatCompletionResult;

      const mcpHandler = createStreamableHttpRequestHandler(
        () =>
          createServer({
            kitsRoot,
            transportKind: "http",
            previewLocality: "remote",
            conjureDeps: { chat: stubChat },
          }),
        { requireBearerAuth: true },
      );
      mcp = createNodeHttpServer((req, res) => mcpHandler(req, res));
      await new Promise<void>((resolveListen) => mcp!.listen(0, "127.0.0.1", resolveListen));
      const mcpPort = (mcp.address() as AddressInfo).port;

      let turn = 0;
      const suffixes = ["conjure", "plan", "write_files", "preview"];
      model = createNodeHttpServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            tools?: Array<{ function?: { name?: string } }>;
            messages?: unknown[];
          };
          const names =
            body.tools?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ?? [];
          const suffix = suffixes[turn];
          const toolName = suffix && names.find((name) => name.endsWith(suffix));
          let args: Record<string, unknown> | undefined;
          if (suffix === "conjure") args = { kitId, kit: "minimal", prompt: "button" };
          if (suffix === "plan") {
            args = {
              kitId,
              writes: ["components/actions/Button/Button.html"],
              localDir: kitsRoot,
            };
          }
          if (suffix === "write_files") {
            const history = JSON.stringify(body.messages ?? []);
            const planId = history.match(/\\?"planId\\?"\s*:\s*\\?"([^"\\]+)/)?.[1];
            args = {
              planId,
              files: [
                {
                  path: "components/actions/Button/Button.html",
                  data:
                    '<!-- @genie group="actions" viewport="240x120" name="Button" -->\n' +
                    "<button>Click me</button>",
                },
              ],
            };
          }
          if (suffix === "preview") args = { kitId };

          res.writeHead(200, { "content-type": "text/event-stream" });
          const common = {
            id: `chatcmpl-cline-${turn}`,
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: "cline-smoke",
          };
          if (toolName && args) {
            res.write(
              `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
            );
            turn += 1;
          } else {
            const messages = (body.messages ?? []) as Array<{
              role?: string;
              content?: unknown;
            }>;
            const lastToolMessage = [...messages]
              .reverse()
              .find((message) => message.role === "tool");
            const toolResult =
              typeof lastToolMessage?.content === "string"
                ? (JSON.parse(lastToolMessage.content) as {
                    content?: Array<{ text?: string }>;
                  })
                : undefined;
            const previewText = toolResult?.content?.[0]?.text ?? "preview text missing";
            const text = `Cline surfaced preview text: ${previewText}`;
            res.write(
              `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
            );
          }
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolveListen) => model!.listen(0, "127.0.0.1", resolveListen));
      const modelPort = (model.address() as AddressInfo).port;

      const env = isolatedClineEnv(process.env);
      Object.assign(env, {
        HOME: base,
        USERPROFILE: base,
      });
      const version = await execFileAsync(CLINE_BIN, ["--version"], { env });
      expect(version.stdout.trim()).toBe(CLINE_VERSION);
      await execFileAsync(
        CLINE_BIN,
        [
          "auth",
          "--provider",
          "openai-compatible",
          "--apikey",
          "not-a-real-key",
          "--modelid",
          "cline-smoke",
          "--baseurl",
          `http://127.0.0.1:${modelPort}/v1`,
        ],
        { env },
      );
      await execFileAsync(
        CLINE_BIN,
        [
          "mcp",
          "install",
          "genie",
          `http://127.0.0.1:${mcpPort}/mcp`,
          "--transport",
          "streamableHttp",
          "--header",
          `Authorization: Bearer ${token}`,
          "--yes",
          "--json",
        ],
        { env },
      );
      const settingsPath = join(clineConfig, "cline_mcp_settings.json");
      const canonicalConfig = await documentedClineConfig({
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        token,
      });
      await writeFile(settingsPath, `${JSON.stringify(canonicalConfig, null, 2)}\n`);

      const result = await execFileAsync(
        CLINE_BIN,
        [
          "--json",
          "--timeout",
          "60",
          "--auto-approve",
          "true",
          "--system",
          "Use the requested genie MCP tools in order and finish only after preview.",
          "Run conjure, plan, write_files, and preview.",
        ],
        { cwd: base, env, timeout: 90_000, maxBuffer: 10_000_000 },
      );
      const events = parseClineJson(result.stdout);
      const toolEvents = requireCompleteClineToolCalls(events);
      const starts = toolEvents
        .filter((event) => event.event?.type === "content_start")
        .map((event) => event.event?.toolName);
      expect(starts).toEqual(
        suffixes.map((suffix) => expect.stringMatching(new RegExp(`${suffix}$`))),
      );
      for (const event of toolEvents.filter((entry) => entry.event?.type === "content_end")) {
        expect(event.event?.output, JSON.stringify(event)).toBeDefined();
        expect(event.event?.output?.isError, JSON.stringify(event)).not.toBe(true);
      }
      const previewResult = toolEvents.find(
        (event) => event.event?.type === "content_end" && event.event.toolName?.endsWith("preview"),
      );
      expect(previewResult?.event?.output?.content?.[0]?.text).toContain(
        "Remote preview unavailable",
      );
      expect(events.at(-1)).toMatchObject({
        type: "run_result",
        finishReason: "completed",
        text: expect.stringContaining("Remote preview unavailable"),
      });

      const written = JSON.parse(await readFile(settingsPath, "utf8")) as {
        mcpServers?: Record<
          string,
          {
            transport?: { type?: string; url?: string; headers?: Record<string, string> };
            disabled?: boolean;
            autoApprove?: string[];
          }
        >;
      };
      expect(written.mcpServers?.["genie"]).toEqual({
        transport: {
          type: "streamableHttp",
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
        disabled: false,
        autoApprove: READ_ONLY_AUTO_APPROVE,
      });
    } finally {
      if (previousHome === undefined) delete process.env["GENIE_HOME"];
      else process.env["GENIE_HOME"] = previousHome;
      if (previousPreviewsBaseUrl === undefined) delete process.env["GENIE_PREVIEWS_BASE_URL"];
      else process.env["GENIE_PREVIEWS_BASE_URL"] = previousPreviewsBaseUrl;
      mcp?.closeAllConnections();
      model?.closeAllConnections();
      await Promise.allSettled([
        new Promise<void>((resolveClose) => mcp?.close(() => resolveClose()) ?? resolveClose()),
        new Promise<void>((resolveClose) => model?.close(() => resolveClose()) ?? resolveClose()),
      ]);
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
