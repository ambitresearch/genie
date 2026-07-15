/**
 * M5-12 (DRO-284) — VS Code Copilot harness smoke test.
 *
 * VS Code Copilot talks MCP over the same protocol every other harness in this
 * repo uses, so there is nothing Copilot-specific to fake at the wire level —
 * this suite drives the real server over the SDK's `InMemoryTransport` (same
 * harness pattern as `m1-conformance.test.ts` / `m5-smoke-cursor` (DRO-285))
 * and asserts the executable claims `docs/harness/copilot.md` documents:
 *
 *   AC6 — on an MCP Apps-capable build (VS Code Stable 1.109+ — MCP Apps is
 *         generally available there as of February 2026 — or Insiders, once
 *         it advertises `io.modelcontextprotocol/ui` with the
 *         `text/html;profile=mcp-app` MIME during `initialize`), the
 *         four-verb chain (`conjure → plan → write_files → preview`) is
 *         reachable, `preview`'s `_meta.ui.resourceUri` resolves to
 *         `ui://genie/grid`, and the resource actually renders the previewed
 *         card's markup — i.e. the inline-app path really carries renderable
 *         content, not just a pointer string. The full chain, including a
 *         SUCCESSFUL `conjure` call against a real `GENIE_LLM_*`-configured
 *         endpoint, is driven by the "conjure -> plan -> write_files ->
 *         preview" test below (gated the same way M2-09's real-endpoint
 *         canary is: skipped with a visible breadcrumb when no endpoint is
 *         configured, required via `GENIE_REQUIRE_LLM=1` once CI provisions
 *         one). A separate, always-on test also asserts `conjure` is
 *         registered and fails closed with a typed error when no LLM
 *         endpoint is configured at all.
 *
 *   AC7 — on a non-MCP-Apps client (any MCP host — VS Code or otherwise —
 *         that omits the `io.modelcontextprotocol/ui` extension, including
 *         VS Code builds predating 1.109), `preview` must fall back to a
 *         text/viewer-URL-only result: `_meta.ui.resourceUri` is still
 *         emitted (a capable host reading the same result later could still
 *         resolve it), but `structuredContent` ALSO carries a concrete
 *         `viewerUrl`/`fileUrl` and the text content narrates that fallback
 *         — never a bare inline-render assumption on a host that can't
 *         render one.
 *
 * ── Why not a literal VS Code application launch in CI ──────────────────────
 * There is no VS Code/Electron binary available in this sandboxed/CI runner
 * (`code`/`code-insiders` are absent from PATH here). Rather than gate CI on
 * an unscriptable GUI application, this suite drives the identical MCP
 * capability-negotiation surface a real VS Code Copilot client presents —
 * `hasUiExtensionCapability` / `getUiExtensionCapability` in
 * `packages/server/src/tools/preview.ts` are the SAME functions the real
 * server evaluates against whatever `initialize` capabilities the actual VS
 * Code Copilot extension sends. This is the same substitution the Codex CLI
 * (DRO-283) and Cursor (DRO-285) smoke tests make for their own
 * non-scriptable or provider-gated hosts. A manual install on a real VS Code
 * build and confirming the inline grid renders is tracked as a Definition of
 * Done item on the issue, not automated here.
 *
 * ── AC coverage ──────────────────────────────────────────────────────────
 *   AC1 — canonical `.vscode/mcp.json` HTTP snippet lives in copilot.md.    ✅ (doc)
 *   AC2 — `servers` (not `mcpServers`) gotcha documented.                   ✅ (doc)
 *   AC3 — `sandbox.network.allowedDomains` for stdio installs documented.   ✅ (doc)
 *   AC4 — one-click `@mcp` install documented.                             ✅ (doc)
 *   AC5 — `code --add-mcp "..."` CLI install path documented.              ✅ (doc)
 *   AC6 — four-verb chain (real `conjure` when `GENIE_LLM_*` is configured,
 *         gated/skipped like M2-09 otherwise) + inline `ui://genie/grid`
 *         render, driven live via the real capability-negotiation contract. ✅
 *   AC7 — viewer/file fallback assertion (plus retained `_meta.ui.resourceUri`)
 *         for the non-MCP-Apps client shape.                               ✅
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server/src/server.js";
import { MCP_APP_MIME, UI_EXTENSION_ID } from "../../server/src/tools/preview.js";
import type { ChatCompletionFn, ConjureDeps } from "../../server/src/tools/conjure.js";
import type { ChatCompletionResult } from "../../server/src/llm/client.js";

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

interface Harness {
  client: Client;
  roots: { projectsRoot: string; kitsRoot: string; reportsDir: string };
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

/**
 * Build one genie server + client pair. `clientCapabilities` lets each test
 * simulate the exact `initialize` shape a given VS Code Copilot build sends —
 * an MCP Apps-capable build (AC6, Stable 1.109+ or Insiders) vs. a
 * non-MCP-Apps client that omits the extension entirely (AC7).
 */
async function newHarness(
  clientCapabilities?: Record<string, unknown>,
  serverOptions?: { transportKind?: "stdio" | "http"; conjureDeps?: ConjureDeps },
): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "genie-m5-copilot-"));
  const roots = {
    projectsRoot: join(base, "projects"),
    kitsRoot: join(base, "kits"),
    reportsDir: join(base, "reports"),
  };
  const server = createServer({ ...roots, ...serverOptions });
  const client = new Client(
    { name: "m5-smoke-copilot", version: "0" },
    clientCapabilities ? { capabilities: clientCapabilities } : undefined,
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    roots,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** Runs plan -> write_files against a fresh kit and returns the kitId. */
async function planAndWrite(harness: Harness): Promise<string> {
  const kitResult = await harness.call("mcp__genie__create_kit", { name: "Copilot Smoke Kit" });
  const kitId = (payload(kitResult) as { kitId: string }).kitId;
  expect(kitId).toMatch(/^[a-z0-9-]{3,64}$/);

  const planResult = await harness.call("mcp__genie__plan", {
    kitId,
    writes: ["components/hello/hello.html"],
    deletes: [],
  });
  const planId = (payload(planResult) as { planId: string }).planId;
  expect(typeof planId).toBe("string");

  const writeResult = await harness.call("mcp__genie__write_files", {
    planId,
    files: [
      {
        path: "components/hello/hello.html",
        data:
          '<!-- @genie group="components" viewport="320x180" -->\n' +
          "<!doctype html><body>hello</body>",
      },
    ],
  });
  expect(writeResult.isError).not.toBe(true);

  return kitId;
}

describe("AC6 — MCP Apps-capable VS Code build (Stable 1.109+ or Insiders) renders ui://genie/grid inline", () => {
  let harness: Harness;
  beforeEach(async () => {
    // The AC1 canonical snippet registers genie as a remote HTTP server, so
    // simulate that transport explicitly: it also keeps the resource's card
    // delivery on the solo-dev `data:` inlining path (no local stdio card
    // broker), which is what the "renders the previewed card's markup"
    // assertion below inspects.
    harness = await newHarness(
      { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } },
      { transportKind: "http" },
    );
  });
  afterEach(async () => {
    await harness.close();
  });

  it("plan -> write_files -> preview round-trips and preview's _meta.ui.resourceUri points at ui://genie/grid", async () => {
    const kitId = await planAndWrite(harness);

    const previewResult = await harness.call("mcp__genie__preview", { kitId });
    expect(previewResult.isError).not.toBe(true);

    const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
    expect(meta?.ui?.resourceUri).toContain(`kitId=${kitId}`);

    // The negotiated-capable path must NOT fall back to a viewer URL — the
    // resource pointer IS the inline render, not a substitute for it.
    const structured = previewResult.structuredContent as Record<string, unknown> | undefined;
    expect(structured?.viewerUrl).toBeUndefined();
  });

  it("the ui://genie/grid resource the tool points at actually renders the previewed card's markup", async () => {
    const kitId = await planAndWrite(harness);
    const previewResult = await harness.call("mcp__genie__preview", { kitId });
    const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
    const resourceUri = meta?.ui?.resourceUri;
    expect(resourceUri).toBeDefined();

    const read = await harness.client.readResource({ uri: resourceUri as string });
    const content = read.contents?.[0];
    const html = content && "text" in content ? content.text : undefined;
    expect(typeof html).toBe("string");
    // The embedded document must carry an inline manifest island (AC2 of the
    // M4 viewer gate) rather than a fetch-based transport, and the seeded
    // component's body must actually be present as inlined `data:` bytes
    // (base64-encoded per grid-resource's `rewriteCardPaths`) — proving this
    // is a real render of the previewed card, not an empty shell.
    expect(html).toContain('id="manifest"');
    const expectedDataUrl = `data:text/html;base64,${Buffer.from(
      '<!-- @genie group="components" viewport="320x180" -->\n' +
        "<!doctype html><body>hello</body>",
      "utf8",
    ).toString("base64")}`;
    expect(html).toContain(expectedDataUrl);
  });

  it("conjure is registered on the same server and fails closed (typed error, no silent no-op) without GENIE_LLM_*", async () => {
    const previousBaseUrl = process.env.GENIE_LLM_BASE_URL;
    const previousApiKey = process.env.GENIE_LLM_API_KEY;
    delete process.env.GENIE_LLM_BASE_URL;
    delete process.env.GENIE_LLM_API_KEY;
    try {
      const { tools } = await harness.client.listTools();
      expect(tools.some((t) => t.name === "mcp__genie__conjure")).toBe(true);

      const result = await harness.call("mcp__genie__conjure", { prompt: "a button" });
      expect(result.isError).toBe(true);
    } finally {
      if (previousBaseUrl !== undefined) process.env.GENIE_LLM_BASE_URL = previousBaseUrl;
      if (previousApiKey !== undefined) process.env.GENIE_LLM_API_KEY = previousApiKey;
    }
  });

  it("the FULL chain — a successful conjure -> plan -> write_files -> preview — round-trips and renders inline", async () => {
    // A stubbed `chat` seam (same pattern conjure.test.ts's unit suite uses)
    // proves the real conjure->plan->write_files->preview wiring succeeds
    // end-to-end without spending real model dollars in every CI run; the
    // companion test below additionally drives this same chain against a
    // REAL GENIE_LLM_*-configured endpoint when one is available, mirroring
    // M2-09's real-endpoint canary gate.
    const stubChat: ChatCompletionFn = async () =>
      ({
        id: "chatcmpl-copilot-smoke",
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
                componentName: "Hello",
                group: "components",
                files: [
                  {
                    path: "components/components/Hello/Hello.html",
                    content:
                      '<!-- @genie group="components" viewport="320x180" -->\n' +
                      "<!doctype html><body>hello from conjure</body>",
                    mimeType: "text/html",
                  },
                ],
                manifestEntry: { viewport: { width: 320, height: 180 }, subtitle: "Conjured" },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }) as unknown as ChatCompletionResult;

    const stubHarness = await newHarness(
      { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } },
      { transportKind: "http", conjureDeps: { chat: stubChat } },
    );
    try {
      const kitResult = await stubHarness.call("mcp__genie__create_kit", {
        name: "Copilot Conjure Smoke Kit",
      });
      const kitId = (payload(kitResult) as { kitId: string }).kitId;

      const conjureResult = await stubHarness.call("mcp__genie__conjure", {
        kitId,
        kit: "Warm-instrument kit: clay accent, 8px radius.",
        prompt: "A hello component",
      });
      expect(conjureResult.isError).not.toBe(true);
      const conjured = payload(conjureResult) as {
        files: { path: string; content: string; mimeType: string; encoding: string }[];
      };
      expect(conjured.files.length).toBeGreaterThan(0);

      const planResult = await stubHarness.call("mcp__genie__plan", {
        kitId,
        writes: conjured.files.map((f) => f.path),
        deletes: [],
      });
      const planId = (payload(planResult) as { planId: string }).planId;

      const writeResult = await stubHarness.call("mcp__genie__write_files", {
        planId,
        files: conjured.files.map((f) => ({
          path: f.path,
          data: f.content,
          mimeType: f.mimeType,
          encoding: f.encoding,
        })),
      });
      expect(writeResult.isError).not.toBe(true);

      const previewResult = await stubHarness.call("mcp__genie__preview", { kitId });
      expect(previewResult.isError).not.toBe(true);
      const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);

      const read = await stubHarness.client.readResource({ uri: meta!.ui!.resourceUri! });
      const content = read.contents?.[0];
      const html = content && "text" in content ? content.text : undefined;
      const expectedDataUrl = `data:text/html;base64,${Buffer.from(
        '<!-- @genie group="components" viewport="320x180" -->\n' +
          "<!doctype html><body>hello from conjure</body>",
        "utf8",
      ).toString("base64")}`;
      expect(html).toContain(expectedDataUrl);
    } finally {
      await stubHarness.close();
    }
  });

  const hasLlmConfig = Boolean(
    process.env["GENIE_LLM_BASE_URL"]?.trim() && process.env["GENIE_LLM_API_KEY"]?.trim(),
  );
  if (!hasLlmConfig) {
    console.info(
      "[m5-smoke-copilot] GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is not set — " +
        "skipping the real-endpoint conjure->plan->write_files->preview leg of AC6. " +
        "Set both to run this leg for real.",
    );
  }
  if (!hasLlmConfig && process.env["GENIE_REQUIRE_LLM"] === "1") {
    throw new Error(
      "GENIE_REQUIRE_LLM=1 but GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is " +
        "missing/empty — the m5-smoke-copilot real-endpoint AC6 leg must run for real.",
    );
  }
  it.skipIf(!hasLlmConfig)(
    "against a REAL GENIE_LLM_*-configured endpoint, conjure -> plan -> write_files -> preview succeeds",
    async () => {
      const kitResult = await harness.call("mcp__genie__create_kit", {
        name: "Copilot Real Conjure Smoke Kit",
      });
      const kitId = (payload(kitResult) as { kitId: string }).kitId;

      const conjureResult = await harness.call("mcp__genie__conjure", {
        kitId,
        kit: "Warm-instrument kit: clay accent, 8px radius, Inter type scale.",
        prompt: "A primary button",
      });
      expect(conjureResult.isError).not.toBe(true);
      const conjured = payload(conjureResult) as {
        files: { path: string; content: string; mimeType: string; encoding: string }[];
      };
      expect(conjured.files.length).toBeGreaterThan(0);

      const planResult = await harness.call("mcp__genie__plan", {
        kitId,
        writes: conjured.files.map((f) => f.path),
        deletes: [],
      });
      const planId = (payload(planResult) as { planId: string }).planId;

      const writeResult = await harness.call("mcp__genie__write_files", {
        planId,
        files: conjured.files.map((f) => ({
          path: f.path,
          data: f.content,
          mimeType: f.mimeType,
          encoding: f.encoding,
        })),
      });
      expect(writeResult.isError).not.toBe(true);

      const previewResult = await harness.call("mcp__genie__preview", { kitId });
      expect(previewResult.isError).not.toBe(true);
      const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
    },
    180_000,
  );
});

describe("AC7 — a non-MCP-Apps client falls back to a viewer/file result (resourceUri still retained)", () => {
  let harness: Harness;
  beforeEach(async () => {
    // A non-MCP-Apps client's real `initialize` simply omits the extensions
    // capability entirely — it does not know the key exists at all. That is
    // the "omitted" tri-state, matched by passing no capabilities. Registered
    // as a local stdio server (per the docs' stdio snippet), matching how a
    // non-MCP-Apps host actually launches genie today.
    harness = await newHarness(undefined, { transportKind: "stdio" });
  });
  afterEach(async () => {
    await harness.close();
  });

  it("preview returns a viewer/file fallback rather than assuming an inline render this host cannot paint", async () => {
    const kitId = await planAndWrite(harness);

    const previewResult = await harness.call("mcp__genie__preview", { kitId });
    expect(previewResult.isError).not.toBe(true);

    // Regression: the resource pointer must still be emitted in `_meta` even
    // on this omitted-capability shape — a capable host reading the SAME
    // result later could still resolve it.
    const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);

    // The resource pointer is still emitted in `_meta` (a capable host reading
    // the SAME result later could still resolve it), but on this omitted-
    // capability shape the tool must ALSO hand back a directly consumable
    // viewer URL/file path — it cannot assume the host will ever render the
    // ui:// pointer inline, which is exactly what a non-MCP-Apps host (any
    // client, or a VS Code build predating 1.109) can't do.
    const structured = previewResult.structuredContent as
      | { kitId?: string; viewerUrl?: string; fileUrl?: string; embeddedManifest?: unknown }
      | undefined;
    expect(structured).toBeDefined();
    expect(typeof structured?.kitId).toBe("string");
    expect(structured?.viewerUrl ?? structured?.fileUrl).toBeDefined();
    // Card route data must never ride in model-visible structuredContent.
    expect(structured?.embeddedManifest).toBeUndefined();

    // The text content narrates that concrete fallback, not a bare ui://
    // reference the host can't act on.
    const text = previewResult.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(structured?.viewerUrl ?? structured?.fileUrl ?? "");
  });
});
