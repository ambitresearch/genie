/**
 * Tests for the `preview` MCP tool (M4-05 / DRO-267).
 *
 * The tool returns human-readable URLs as `content` plus a
 * `_meta.ui.resourceUri` pointing at the `ui://genie/grid` MCP-Apps resource
 * (whose handler M4-06 registers). It boots the Vite viewer on demand and
 * reuses it across calls, falling back to a `file://` URL when the viewer
 * cannot start.
 *
 * The viewer boot is behind an injectable `ViewerBooter` seam so these tests
 * drive every branch (boot ok / boot fails / reuse / reboot) WITHOUT binding a
 * port or importing Vite — mirroring how `refine.test.ts` fakes the Playwright
 * cropper and `write_files.test.ts` fakes the store.
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../server.js";
import type { Manifest } from "../manifest/index.js";
import {
  PREVIEW_TOOL_NAME,
  DEFAULT_VIEWER_PORT,
  InvalidKitIdError,
  KitNotFoundError,
  ViewerRegistry,
  autoOpenDisabledByEnv,
  buildResourceUri,
  clientSupportsUi,
  getUiExtensionCapability,
  hasUiExtensionCapability,
  MCP_APP_MIME,
  UI_EXTENSION_ID,
  resolveKitDir,
  runPreview,
  registerPreviewTool,
  shouldAutoOpen,
  type BootRequest,
  type BootedViewer,
  type ViewerBooter,
} from "./preview.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A booter that always succeeds, returning a canned URL and counting calls. */
function okBooter(url = "http://127.0.0.1:5173/"): ViewerBooter & { calls: BootRequest[] } {
  const calls: BootRequest[] = [];
  const fn = (req: BootRequest): Promise<BootedViewer> => {
    calls.push(req);
    return Promise.resolve({
      url,
      port: 5173,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
  };
  return Object.assign(fn, { calls });
}

/** A booter that always fails (simulates EADDRINUSE / Vite unavailable). */
function failBooter(message = "port in use"): ViewerBooter & { calls: BootRequest[] } {
  const calls: BootRequest[] = [];
  const fn = (req: BootRequest): Promise<BootedViewer> => {
    calls.push(req);
    return Promise.reject(new Error(message));
  };
  return Object.assign(fn, { calls });
}

/** A deferred so a test can hold a boot pending to probe concurrent dedupe. */
function deferredBooter(): {
  booter: ViewerBooter & { calls: BootRequest[] };
  resolve: (v: BootedViewer) => void;
} {
  const calls: BootRequest[] = [];
  let resolveFn!: (v: BootedViewer) => void;
  const fn = (req: BootRequest): Promise<BootedViewer> => {
    calls.push(req);
    return new Promise<BootedViewer>((res) => {
      resolveFn = res;
    });
  };
  return { booter: Object.assign(fn, { calls }), resolve: (v) => resolveFn(v) };
}

async function makeKitsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "genie-preview-kits-"));
  await mkdir(join(root, "acme-abc123"), { recursive: true });
  return root;
}

/**
 * Create a kit dir under `kitsRoot` holding one valid `@genie`-marked component,
 * so `ensureManifest` (piece A) has something real to compile. Returns the
 * kitId. The marker's `name="Get Started"` is deliberately different from the
 * filename stem so a later assertion can prove the manifest was actually
 * compiled from this file (not a leftover seed).
 */
async function seedKitWithComponent(kitsRoot: string, kitId: string): Promise<void> {
  const compDir = join(kitsRoot, kitId, "components", "actions", "Button");
  await mkdir(compDir, { recursive: true });
  await writeFile(
    join(compDir, "preview.html"),
    '<!-- @genie group="actions" viewport="480x240" name="Get Started" -->\n' +
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /></head>' +
      "<body><button>Get Started</button></body></html>\n",
    "utf-8",
  );
}

// ─── AC4: buildResourceUri ───────────────────────────────────────────────────

describe("buildResourceUri (AC3/AC4)", () => {
  it("always targets ui://genie/grid and carries kitId", () => {
    expect(buildResourceUri({ kitId: "acme-abc123" })).toBe("ui://genie/grid?kitId=acme-abc123");
  });

  it("appends group when present", () => {
    expect(buildResourceUri({ kitId: "acme-abc123", group: "actions" })).toBe(
      "ui://genie/grid?kitId=acme-abc123&group=actions",
    );
  });

  it("appends componentName when present", () => {
    expect(buildResourceUri({ kitId: "acme-abc123", componentName: "Button" })).toBe(
      "ui://genie/grid?kitId=acme-abc123&componentName=Button",
    );
  });

  it("carries kitId, componentName, and group in a stable order", () => {
    expect(
      buildResourceUri({ kitId: "acme-abc123", componentName: "Button", group: "actions" }),
    ).toBe("ui://genie/grid?kitId=acme-abc123&componentName=Button&group=actions");
  });

  it("url-encodes filter values with spaces / special chars", () => {
    const uri = buildResourceUri({ kitId: "acme-abc123", group: "form controls" });
    // URLSearchParams encodes the space (as + or %20); either way it round-trips.
    const qs = new URLSearchParams(uri.split("?")[1]);
    expect(qs.get("group")).toBe("form controls");
    expect(qs.get("kitId")).toBe("acme-abc123");
  });
});

// ─── AC7: clientSupportsUi ───────────────────────────────────────────────────

describe("clientSupportsUi (AC7)", () => {
  it.each([
    "claude",
    "Claude Code",
    "claude-ai",
    "vscode",
    "Visual Studio Code",
    "ChatGPT",
    "openai-chatgpt",
    "cursor",
    "Cursor",
    "goose",
    "Postman",
    "MCPJam",
  ])("recognizes %s as a ui:// host", (name) => {
    expect(clientSupportsUi(name)).toBe(true);
  });

  it.each(["codex", "cline", "continue", "some-random-cli", ""])(
    "treats %s as a non-ui:// host",
    (name) => {
      expect(clientSupportsUi(name)).toBe(false);
    },
  );

  it("returns false when the client name is unknown/undefined", () => {
    expect(clientSupportsUi(undefined)).toBe(false);
  });
});

// ─── hasUiExtensionCapability (MCP Apps capability negotiation) ──────────────

describe("hasUiExtensionCapability", () => {
  it("recognizes the spec-shaped extension capability", () => {
    expect(
      hasUiExtensionCapability({
        extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } },
      }),
    ).toBe(true);
  });

  it("accepts extra mime types alongside the app profile", () => {
    expect(
      hasUiExtensionCapability({
        extensions: { [UI_EXTENSION_ID]: { mimeTypes: ["text/plain", MCP_APP_MIME] } },
      }),
    ).toBe(true);
  });

  it.each([
    ["undefined caps", undefined],
    ["null caps", null],
    ["empty caps", {}],
    ["no extensions", { tools: {} }],
    ["extensions not an object", { extensions: "yes" }],
    ["extension absent", { extensions: { "io.example/other": {} } }],
    ["extension not an object", { extensions: { [UI_EXTENSION_ID]: true } }],
    ["mimeTypes missing", { extensions: { [UI_EXTENSION_ID]: {} } }],
    ["mimeTypes not an array", { extensions: { [UI_EXTENSION_ID]: { mimeTypes: MCP_APP_MIME } } }],
    [
      "app profile not offered",
      { extensions: { [UI_EXTENSION_ID]: { mimeTypes: ["text/html"] } } },
    ],
  ])("returns false for %s", (_label, caps) => {
    expect(hasUiExtensionCapability(caps)).toBe(false);
  });
});

// ─── resolveKitDir (path-safety) ─────────────────────────────────────────────

describe("resolveKitDir", () => {
  it("joins kitsRoot with a valid kitId", () => {
    expect(resolveKitDir("/kits", "acme-abc123")).toBe(join("/kits", "acme-abc123"));
  });

  it.each(["../escape", "a/b", "..", "UPPER", "x", "with space"])(
    "rejects an unsafe / malformed kitId %s",
    (kitId) => {
      expect(() => resolveKitDir("/kits", kitId)).toThrow(InvalidKitIdError);
    },
  );
});

describe("getUiExtensionCapability", () => {
  it.each([
    ["undefined caps", undefined],
    ["empty caps", {}],
    ["no extensions", { tools: {} }],
  ])("returns undefined when extension negotiation is unavailable: %s", (_label, caps) => {
    expect(getUiExtensionCapability(caps)).toBeUndefined();
  });

  it.each([
    ["empty extensions", { extensions: {} }],
    ["different extension", { extensions: { "io.example/other": {} } }],
    ["missing app MIME", { extensions: { [UI_EXTENSION_ID]: { mimeTypes: ["text/html"] } } }],
  ])("returns false for a negotiated negative: %s", (_label, caps) => {
    expect(getUiExtensionCapability(caps)).toBe(false);
  });

  it("returns true when the app MIME is negotiated", () => {
    expect(
      getUiExtensionCapability({
        extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } },
      }),
    ).toBe(true);
  });
});

// ─── AC5: ViewerRegistry boot-once + reuse + reboot ──────────────────────────

describe("ViewerRegistry (AC5)", () => {
  it("boots once and reuses the same viewer across calls for one kit", async () => {
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    const a = await registry.ensure("/kits/k1");
    const b = await registry.ensure("/kits/k1");

    expect(booter.calls).toHaveLength(1); // reuse, not re-boot
    expect(a).toBe(b);
  });

  it("boots a separate viewer per distinct kit dir", async () => {
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await registry.ensure("/kits/k1");
    await registry.ensure("/kits/k2");

    expect(booter.calls.map((c) => c.kitDir)).toEqual(["/kits/k1", "/kits/k2"]);
  });

  it("re-boots after a failed boot (does not cache a dead viewer)", async () => {
    let attempt = 0;
    const calls: BootRequest[] = [];
    const flaky: ViewerBooter = (req) => {
      calls.push(req);
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({
            url: "http://127.0.0.1:5173/",
            port: 5173,
            open: () => Promise.resolve(),
            close: () => Promise.resolve(),
          });
    };
    const registry = new ViewerRegistry(flaky);

    await expect(registry.ensure("/kits/k1")).rejects.toThrow("boom");
    const ok = await registry.ensure("/kits/k1"); // must retry, not return the dead promise

    expect(calls).toHaveLength(2);
    expect(ok.url).toContain("5173");
  });

  it("dedupes concurrent boots for the same kit into a single call", async () => {
    const { booter, resolve } = deferredBooter();
    const registry = new ViewerRegistry(booter);

    const p1 = registry.ensure("/kits/k1");
    const p2 = registry.ensure("/kits/k1");
    resolve({
      url: "http://127.0.0.1:5173/",
      port: 5173,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });

    const [a, b] = await Promise.all([p1, p2]);
    expect(booter.calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("opens an already-cached viewer once when a later local caller needs browser fallback", async () => {
    const open = vi.fn(async () => {});
    const booter: ViewerBooter = async () => ({
      url: "http://127.0.0.1:5173/",
      port: 5173,
      open,
      close: async () => {},
    });
    const registry = new ViewerRegistry(booter);

    await registry.ensure("/kits/k1", DEFAULT_VIEWER_PORT, false);
    await registry.ensure("/kits/k1", DEFAULT_VIEWER_PORT, true);
    await registry.ensure("/kits/k1", DEFAULT_VIEWER_PORT, true);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps a cached viewer usable and closes it when its browser opener rejects", async () => {
    const close = vi.fn(async () => {});
    const booter: ViewerBooter = async () => ({
      url: "http://127.0.0.1:5173/",
      port: 5173,
      open: async () => {
        throw new Error("no display");
      },
      close,
    });
    const registry = new ViewerRegistry(booter);

    await registry.ensure("/kits/k1", DEFAULT_VIEWER_PORT, false);
    await expect(registry.ensure("/kits/k1", DEFAULT_VIEWER_PORT, true)).resolves.toMatchObject({
      port: 5173,
    });
    await registry.closeAll();

    expect(close).toHaveBeenCalledOnce();
  });
});

// ─── AC3/AC6: runPreview core ────────────────────────────────────────────────

describe("runPreview (AC3, AC6)", () => {
  it("happy path: reports the live viewer URL + a file:// fallback and emits _meta.ui.resourceUri", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter("http://127.0.0.1:5173/"));

    const result = await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("http://127.0.0.1:5173/");
    expect(result.content[0]?.text.toLowerCase()).toContain("running");
    // The file:// vehicle is always present (RFC G-5).
    const fileUrl = pathToFileURL(join(kitsRoot, "acme-abc123", "index.html")).href;
    expect(result.content[0]?.text).toContain(fileUrl);
    expect(result._meta.ui.resourceUri).toBe("ui://genie/grid?kitId=acme-abc123");
    // M4-06 AC6 — the same resourceUri is ALSO exposed under the ChatGPT Apps
    // SDK key so that ecosystem links the result to the ui://genie/grid widget.
    expect(result._meta["openai/outputTemplate"]).toBe("ui://genie/grid?kitId=acme-abc123");
  });

  it("AC6: falls back to file://<kitDir>/index.html when the viewer cannot boot, still emitting _meta", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(failBooter("EADDRINUSE"));

    const result = await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, {});

    const fileUrl = pathToFileURL(join(kitsRoot, "acme-abc123", "index.html")).href;
    expect(result.content[0]?.text).toContain(fileUrl);
    expect(result.content[0]?.text).not.toContain("Preview running at");
    // _meta is emitted regardless of viewer availability (progressive enhancement).
    expect(result._meta.ui.resourceUri).toBe("ui://genie/grid?kitId=acme-abc123");
  });

  it("AC4: threads componentName + group into the resource URI", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter());

    const result = await runPreview(
      { kitsRoot, registry },
      { kitId: "acme-abc123", componentName: "Button", group: "actions" },
      {},
    );

    expect(result._meta.ui.resourceUri).toBe(
      "ui://genie/grid?kitId=acme-abc123&componentName=Button&group=actions",
    );
  });

  it("returns structuredContent with kitId, filters, viewerUrl and fileUrl (spec §Tool Result)", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter("http://127.0.0.1:5173/"));

    const result = await runPreview(
      { kitsRoot, registry },
      { kitId: "acme-abc123", componentName: "Button", group: "actions" },
      {},
    );

    expect(result.structuredContent).toEqual({
      kitId: "acme-abc123",
      componentName: "Button",
      group: "actions",
      viewerUrl: "http://127.0.0.1:5173/",
      fileUrl: pathToFileURL(join(kitsRoot, "acme-abc123", "index.html")).href,
    });
  });

  it("omits viewerUrl from structuredContent on the file:// fallback", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(failBooter("EADDRINUSE"));

    const result = await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, {});

    expect(result.structuredContent.viewerUrl).toBeUndefined();
    expect(result.structuredContent.kitId).toBe("acme-abc123");
    expect(result.structuredContent.fileUrl).toBe(
      pathToFileURL(join(kitsRoot, "acme-abc123", "index.html")).href,
    );
  });

  it("uiCapable: true marks the host ui-supported regardless of client name (no auto-open)", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);
    const lines = captureStderr();

    await runPreview(
      { kitsRoot, registry },
      { kitId: "acme-abc123" },
      { clientName: "totally-unknown-host", uiCapable: true },
    );

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.uiCapable).toBe(true);
    expect(req?.uiSupported).toBe(true);
    expect(req?.autoOpen).toBe(false);
    expect(booter.calls[0]?.open).toBe(false);
  });

  it("uiCapable: false overrides a known UI host name", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);
    const lines = captureStderr();

    await runPreview(
      { kitsRoot, registry, env: {} },
      { kitId: "acme-abc123" },
      { clientName: "cursor", uiCapable: false },
    );

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.uiCapable).toBe(false);
    expect(req?.uiSupported).toBe(false);
    expect(req?.autoOpen).toBe(true);
    expect(booter.calls[0]?.open).toBe(true);
  });

  it("rejects a malformed kitId before booting anything", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await expect(runPreview({ kitsRoot, registry }, { kitId: "../etc" }, {})).rejects.toThrow(
      InvalidKitIdError,
    );
    expect(booter.calls).toHaveLength(0);
  });

  it("rejects an unknown well-formed kitId without creating a phantom directory", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);
    const missingDir = join(kitsRoot, "missing-kit");

    await expect(runPreview({ kitsRoot, registry }, { kitId: "missing-kit" }, {})).rejects.toThrow(
      KitNotFoundError,
    );
    await expect(readFile(join(missingDir, ".genie", "manifest.json"))).rejects.toThrow();
    expect(booter.calls).toHaveLength(0);
  });

  it("rejects a valid-shaped kit path that is a file before compile or viewer boot", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-preview-kits-"));
    await writeFile(join(kitsRoot, "acme-abc123"), "not a directory", "utf8");
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);
    const compile = vi.fn(async () => ({ version: 1, groups: [], components: [] }) as Manifest);

    await expect(
      runPreview({ kitsRoot, registry, ensureManifest: compile }, { kitId: "acme-abc123" }, {}),
    ).rejects.toThrow(KitNotFoundError);
    expect(compile).not.toHaveBeenCalled();
    expect(booter.calls).toHaveLength(0);
  });

  it("AC7: logs a preview.request line recording the client + ui:// support", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter());
    const lines = captureStderr();

    await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, { clientName: "claude" });

    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req).toBeDefined();
    expect(req?.client).toBe("claude");
    expect(req?.uiSupported).toBe(true);
    lines.restore();
  });

  it("AC7: records uiSupported=false for a non-ui:// harness", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter());
    const lines = captureStderr();

    await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, { clientName: "codex" });

    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.client).toBe("codex");
    expect(req?.uiSupported).toBe(false);
    lines.restore();
  });
});

// ─── Piece A: preview compiles + persists the manifest ───────────────────────

describe("runPreview manifest compile (piece A)", () => {
  it("compiles + persists .genie/manifest.json from the kit's components", async () => {
    const kitsRoot = await makeKitsRoot();
    await seedKitWithComponent(kitsRoot, "acme-abc123");
    const registry = new ViewerRegistry(okBooter());

    await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, {});

    const manifestRaw = await readFile(
      join(kitsRoot, "acme-abc123", ".genie", "manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(manifestRaw) as {
      components: { group: string; path: string }[];
      groups: string[];
    };
    // The component we seeded is present — proving preview compiled it, not a
    // pre-existing empty seed (this kit dir had no manifest before the call).
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0]?.group).toBe("actions");
    expect(manifest.components[0]?.path).toBe("components/actions/Button/preview.html");
    expect(manifest.groups).toContain("actions");
  });

  it("does not sink the preview when the kit has no components (empty compile)", async () => {
    const kitsRoot = await makeKitsRoot();
    // A kit dir that exists but has no components/ tree.
    await mkdir(join(kitsRoot, "acme-abc123"), { recursive: true });
    const registry = new ViewerRegistry(okBooter("http://127.0.0.1:5173/"));

    const result = await runPreview({ kitsRoot, registry }, { kitId: "acme-abc123" }, {});

    // Still reports the viewer URL — a compile that yields an empty manifest is
    // a fine result, not an error.
    expect(result.content[0]?.text).toContain("http://127.0.0.1:5173/");
    expect(result._meta.ui.resourceUri).toBe("ui://genie/grid?kitId=acme-abc123");
  });

  it("propagates genuine manifest compilation failures and does not boot", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter("http://127.0.0.1:5173/");
    const registry = new ViewerRegistry(booter);

    await expect(
      runPreview(
        {
          kitsRoot,
          registry,
          ensureManifest: async () => {
            throw new Error("EACCES: manifest write denied");
          },
        },
        { kitId: "acme-abc123" },
        {},
      ),
    ).rejects.toThrow("EACCES: manifest write denied");
    expect(booter.calls).toHaveLength(0);
  });
});

// ─── Piece B: harness-aware server-side auto-open ────────────────────────────

describe("autoOpenDisabledByEnv (piece B opt-out)", () => {
  it.each(["1", "true", "TRUE", "yes", "on"])("treats %s as opted-out", (val) => {
    expect(autoOpenDisabledByEnv({ GENIE_PREVIEW_NO_OPEN: val })).toBe(true);
  });

  it.each(["0", "false", "FALSE", "", "  "])("treats %s as NOT opted-out", (val) => {
    expect(autoOpenDisabledByEnv({ GENIE_PREVIEW_NO_OPEN: val })).toBe(false);
  });

  it("is not opted-out when the var is absent (default = auto-open on)", () => {
    expect(autoOpenDisabledByEnv({})).toBe(false);
  });
});

describe("shouldAutoOpen (piece B decision)", () => {
  it("never opens for a ui://-capable host (inline grid renders in-panel)", () => {
    expect(shouldAutoOpen(true, {})).toBe(false);
    // Even without the opt-out set, a ui host never triggers a redundant tab.
    expect(shouldAutoOpen(true, { GENIE_PREVIEW_NO_OPEN: "0" })).toBe(false);
  });

  it("opens for a non-ui:// host by default (opt-out unset)", () => {
    expect(shouldAutoOpen(false, {})).toBe(true);
  });

  it("does NOT open for a non-ui:// host when opted out via env", () => {
    expect(shouldAutoOpen(false, { GENIE_PREVIEW_NO_OPEN: "1" })).toBe(false);
  });

  it("does NOT open on HTTP even for a non-ui client without the env opt-out", () => {
    expect(shouldAutoOpen(false, {}, "http")).toBe(false);
  });
});

describe("runPreview auto-open wiring (piece B)", () => {
  it("passes open:true to the booter for a non-ui:// host (default)", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await runPreview(
      { kitsRoot, registry, env: {} },
      { kitId: "acme-abc123" },
      { clientName: "codex" },
    );

    expect(booter.calls).toHaveLength(1);
    expect(booter.calls[0]?.open).toBe(true);
  });

  it("passes open:false to the booter for a ui://-capable host", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await runPreview(
      { kitsRoot, registry, env: {} },
      { kitId: "acme-abc123" },
      { clientName: "claude" },
    );

    expect(booter.calls[0]?.open).toBe(false);
  });

  it("passes open:false for a non-ui:// host when GENIE_PREVIEW_NO_OPEN is set", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await runPreview(
      { kitsRoot, registry, env: { GENIE_PREVIEW_NO_OPEN: "1" } },
      { kitId: "acme-abc123" },
      { clientName: "codex" },
    );

    expect(booter.calls[0]?.open).toBe(false);
  });

  it("passes open:false for a non-ui:// host over HTTP", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await runPreview(
      { kitsRoot, registry, env: {} },
      { kitId: "acme-abc123" },
      { clientName: "codex", transportKind: "http" },
    );

    expect(booter.calls[0]?.open).toBe(false);
  });

  it("only opens once across repeated previews (registry reuse)", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);
    const deps = { kitsRoot, registry, env: {} };

    await runPreview(deps, { kitId: "acme-abc123" }, { clientName: "codex" });
    await runPreview(deps, { kitId: "acme-abc123" }, { clientName: "codex" });

    // Second call reuses the cached viewer → booter (and thus the browser open)
    // fires exactly once.
    expect(booter.calls).toHaveLength(1);
    expect(booter.calls[0]?.open).toBe(true);
  });

  it("logs autoOpen in the preview.request line", async () => {
    const kitsRoot = await makeKitsRoot();
    const registry = new ViewerRegistry(okBooter());
    const lines = captureStderr();

    await runPreview(
      { kitsRoot, registry, env: {} },
      { kitId: "acme-abc123" },
      { clientName: "codex" },
    );

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.autoOpen).toBe(true);
  });
});

// ─── AC1/AC2/AC3: wired MCP tool ─────────────────────────────────────────────

let openClient: Client | null = null;
afterEach(async () => {
  if (openClient) {
    await openClient.close();
    openClient = null;
  }
});

async function connectPreview(kitsRoot: string, booter: ViewerBooter): Promise<Client> {
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerPreviewTool(server, { kitsRoot, booter });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  openClient = client;
  return client;
}

describe("mcp__genie__preview (wired)", () => {
  it("AC1: is registered under the canonical tool name", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(PREVIEW_TOOL_NAME);
    expect(PREVIEW_TOOL_NAME).toBe("mcp__genie__preview");
  });

  it("AC1: createServer registers preview in tools/list", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    openClient = client;
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp__genie__preview");
  });

  it("AC3: a call returns text content + _meta.ui.resourceUri", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter("http://127.0.0.1:5173/"));

    const result = (await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId: "acme-abc123" },
    })) as {
      content: { type: string; text: string }[];
      _meta?: { ui?: { resourceUri?: string } };
    };

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("http://127.0.0.1:5173/");
    expect(result._meta?.ui?.resourceUri).toBe("ui://genie/grid?kitId=acme-abc123");
  });

  it("keeps the UI pointer off tools/list because each result needs a query-bearing URI", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const { tools } = await client.listTools();
    const preview = tools.find((t) => t.name === PREVIEW_TOOL_NAME);
    expect((preview?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui).toBeUndefined();
  });

  it("describes browser fallback by negotiated capability rather than client brand", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const { tools } = await client.listTools();
    const preview = tools.find((t) => t.name === PREVIEW_TOOL_NAME);

    expect(preview?.description).toContain("do not negotiate UI support");
    expect(preview?.description).not.toContain("other hosts (Codex, Copilot)");
  });

  it("advertises an outputSchema matching structuredContent", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const { tools } = await client.listTools();
    const preview = tools.find((t) => t.name === PREVIEW_TOOL_NAME);

    expect(preview?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        kitId: { type: "string" },
        fileUrl: { type: "string" },
      },
      required: expect.arrayContaining(["kitId", "fileUrl"]),
    });
  });

  it("returns structuredContent over the wire", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter("http://127.0.0.1:5173/"));

    const result = (await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId: "acme-abc123" },
    })) as {
      structuredContent?: {
        kitId?: string;
        viewerUrl?: string;
      };
    };

    expect(result.structuredContent?.kitId).toBe("acme-abc123");
    expect(result.structuredContent?.viewerUrl).toBe("http://127.0.0.1:5173/");
  });

  it("falls back to the initialize handshake's clientInfo name when no per-request _meta is sent", async () => {
    const kitsRoot = await makeKitsRoot();
    const server = new McpServer({ name: "genie-test", version: "0" });
    registerPreviewTool(server, { kitsRoot, booter: okBooter() });
    // A real ui:// host name in clientInfo — the way production hosts identify.
    const client = new Client({ name: "cursor", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    openClient = client;
    const lines = captureStderr();

    await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: { kitId: "acme-abc123" } });

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.client).toBe("cursor");
    expect(req?.uiSupported).toBe(true);
    expect(req?.autoOpen).toBe(false);
  });

  it("honours the MCP Apps extension capability from initialize (unknown client name)", async () => {
    const kitsRoot = await makeKitsRoot();
    const server = new McpServer({ name: "genie-test", version: "0" });
    const booter = okBooter();
    registerPreviewTool(server, { kitsRoot, booter });
    // Unknown name, but the client ADVERTISES the ui extension — capability wins.
    const client = new Client(
      { name: "some-future-host", version: "1.0.0" },
      { capabilities: { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } } },
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    openClient = client;
    const lines = captureStderr();

    await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: { kitId: "acme-abc123" } });

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.uiCapable).toBe(true);
    expect(req?.uiSupported).toBe(true);
    expect(req?.autoOpen).toBe(false);
    expect(booter.calls[0]?.open).toBe(false);
  });

  it("honours an explicit negative capability instead of a known host name", async () => {
    const kitsRoot = await makeKitsRoot();
    const server = new McpServer({ name: "genie-test", version: "0" });
    const booter = okBooter();
    registerPreviewTool(server, { kitsRoot, booter });
    const client = new Client(
      { name: "cursor", version: "1.0.0" },
      { capabilities: { extensions: {} } },
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    openClient = client;
    const lines = captureStderr();

    await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: { kitId: "acme-abc123" } });

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.uiCapable).toBe(false);
    expect(req?.uiSupported).toBe(false);
    expect(req?.autoOpen).toBe(true);
    expect(booter.calls[0]?.open).toBe(true);
  });

  it("never auto-opens a browser when registered for HTTP transport", async () => {
    const kitsRoot = await makeKitsRoot();
    const server = new McpServer({ name: "genie-test", version: "0" });
    const booter = okBooter();
    registerPreviewTool(server, { kitsRoot, booter, transportKind: "http" });
    const client = new Client({ name: "codex", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    openClient = client;

    await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: { kitId: "acme-abc123" } });

    expect(booter.calls[0]?.open).toBe(false);
  });

  it("AC7: sniffs params._meta.client.name off the request", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const lines = captureStderr();

    await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId: "acme-abc123" },
      _meta: { client: { name: "claude" } },
    });

    lines.restore();
    const req = lines.parsed().find((l) => l.event === "preview.request");
    expect(req?.client).toBe("claude");
    expect(req?.uiSupported).toBe(true);
  });

  it("AC2: rejects a call with no kitId", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const result = await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("AC2: rejects a malformed kitId", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const result = await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId: "../oops" },
    });
    expect(result.isError).toBe(true);
  });

  it("AC2: rejects an empty group filter", async () => {
    const kitsRoot = await makeKitsRoot();
    const client = await connectPreview(kitsRoot, okBooter());
    const result = await client.callTool({
      name: PREVIEW_TOOL_NAME,
      arguments: { kitId: "acme-abc123", group: "" },
    });
    expect(result.isError).toBe(true);
  });
});

// ─── stderr capture helper ───────────────────────────────────────────────────

interface StderrCapture {
  parsed: () => Record<string, unknown>[];
  restore: () => void;
}

function captureStderr(): StderrCapture {
  const raw: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      raw.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    });
  return {
    parsed: () =>
      raw
        .join("")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    restore: () => spy.mockRestore(),
  };
}
