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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../server.js";
import {
  PREVIEW_TOOL_NAME,
  InvalidKitIdError,
  ViewerRegistry,
  buildResourceUri,
  clientSupportsUi,
  resolveKitDir,
  runPreview,
  registerPreviewTool,
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
  return mkdtemp(join(tmpdir(), "genie-preview-kits-"));
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
    resolve({ url: "http://127.0.0.1:5173/", port: 5173, close: () => Promise.resolve() });

    const [a, b] = await Promise.all([p1, p2]);
    expect(booter.calls).toHaveLength(1);
    expect(a).toBe(b);
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

  it("rejects a malformed kitId before booting anything", async () => {
    const kitsRoot = await makeKitsRoot();
    const booter = okBooter();
    const registry = new ViewerRegistry(booter);

    await expect(runPreview({ kitsRoot, registry }, { kitId: "../etc" }, {})).rejects.toThrow(
      InvalidKitIdError,
    );
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
