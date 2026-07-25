import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_JS = readFileSync(resolve(HERE, "../static/viewer.js"), "utf8");
const VIEWER_HTML = readFileSync(resolve(HERE, "../static/index.html"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hooks = Record<string, (...args: any[]) => any>;

function loadHooks(): { hooks: Hooks; window: JSDOM["window"] } {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url: "https://viewer.example.test/?route=generate",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dom.window as any).__genieViewerTestHooks = {};
  dom.window.eval(VIEWER_JS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { hooks: (dom.window as any).__genieViewerTestHooks, window: dom.window };
}

function loadShell() {
  const dom = new JSDOM(VIEWER_HTML, {
    runScripts: "outside-only",
    url: "https://viewer.example.test/?route=generate",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dom.window as any).__genieViewerTestHooks = {};
  dom.window.eval(VIEWER_JS);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: (dom.window as any).__genieViewerTestHooks as Hooks,
    window: dom.window,
    document: dom.window.document,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Generate workflow state", () => {
  it("gates Conjure on trimmed prompt, kit, model, host capability, and single flight", () => {
    const { hooks } = loadHooks();
    const ready = {
      prompt: "Build a compact status card",
      kitId: "acme-kit",
      model: "design-default",
      hostAvailable: true,
      inFlight: false,
    };

    expect(hooks.canConjure(ready)).toBe(true);
    for (const patch of [
      { prompt: " \n " },
      { kitId: "" },
      { model: "" },
      { hostAvailable: false },
      { inFlight: true },
    ]) {
      expect(hooks.canConjure({ ...ready, ...patch })).toBe(false);
    }
  });

  it("preselects one editable kit but requires an explicit choice among multiple kits", () => {
    const { hooks } = loadHooks();
    const kit = { id: "acme-kit", name: "Acme", canEdit: true };

    expect(hooks.selectInitialKit([kit], "")).toBe("acme-kit");
    expect(hooks.selectInitialKit([kit, { ...kit, id: "other-kit" }], "")).toBe("");
    expect(hooks.selectInitialKit([kit, { ...kit, id: "other-kit" }], "other-kit")).toBe(
      "other-kit",
    );
    expect(hooks.selectInitialKit([{ ...kit, canEdit: false }], "")).toBe("");
  });

  it("keeps exact structured Conjure results in monotonically numbered drafts", () => {
    const { hooks } = loadHooks();
    const store = hooks.createDraftStore();
    const firstResult = {
      componentName: "Status card",
      group: "surfaces",
      files: [{ path: "components/StatusCard.tsx", content: "export default null" }],
      manifestEntry: { name: "Status card" },
      usage: { inputTokens: 12, outputTokens: 20 },
    };

    const first = store.add(firstResult);
    const second = store.add({ ...firstResult, componentName: "Alert card" });

    expect(first).toEqual({ number: 1, label: "draft #1", result: firstResult });
    expect(first.result).toBe(firstResult);
    expect(second.number).toBe(2);
    expect(store.current()).toBe(second);
  });

  it("accepts only complete structured Conjure results", () => {
    const { hooks } = loadHooks();
    const valid = {
      componentName: "Status card",
      group: "surfaces",
      files: [{ path: "x", content: "x", mimeType: "text/plain", encoding: "utf-8" }],
      manifestEntry: { viewport: { width: 320, height: 240 } },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    expect(hooks.isConjureResult(valid)).toBe(true);
    expect(hooks.isConjureResult({ ...valid, files: undefined })).toBe(false);
    expect(hooks.isConjureResult({ ...valid, componentName: "" })).toBe(false);
  });

  it("fails closed on a conjure draft with malformed files/manifestEntry/usage (DRO-242)", () => {
    const { hooks } = loadHooks();
    const valid = {
      componentName: "StatusCard",
      group: "surfaces",
      files: [
        {
          path: "components/surfaces/StatusCard/StatusCard.tsx",
          content: "export {}",
          mimeType: "text/tsx",
          encoding: "utf-8",
        },
      ],
      manifestEntry: { viewport: { width: 480, height: 240 } },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    expect(hooks.isConjureResult(valid)).toBe(true);

    // Empty files array — no draft content at all.
    expect(hooks.isConjureResult({ ...valid, files: [] })).toBe(false);
    // A files[] entry missing its content — partial file (the issue's own example).
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ path: "components/surfaces/StatusCard/StatusCard.tsx" }],
      }),
    ).toBe(false);
    // A files[] entry with only path/content — missing mimeType/encoding, which
    // conjure's output schema requires (Copilot review on PR #245).
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [
          { path: "components/surfaces/StatusCard/StatusCard.tsx", content: "export {}" },
        ],
      }),
    ).toBe(false);
    // A files[] entry with an encoding outside the allowed enum.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], encoding: "utf8" }],
      }),
    ).toBe(false);
    // A files[] entry that is a bare string, not an object.
    expect(hooks.isConjureResult({ ...valid, files: ["not-an-object"] })).toBe(false);
    // A null entry inside files[].
    expect(hooks.isConjureResult({ ...valid, files: [null] })).toBe(false);
    // manifestEntry missing entirely.
    expect(hooks.isConjureResult({ ...valid, manifestEntry: undefined })).toBe(false);
    // manifestEntry is an array, not a plain object.
    expect(hooks.isConjureResult({ ...valid, manifestEntry: [] })).toBe(false);
    // manifestEntry is object-like but structurally invalid — missing viewport
    // entirely (Copilot review on PR #245).
    expect(hooks.isConjureResult({ ...valid, manifestEntry: {} })).toBe(false);
    // manifestEntry.viewport is missing width/height.
    expect(hooks.isConjureResult({ ...valid, manifestEntry: { viewport: {} } })).toBe(false);
    // usage missing entirely.
    expect(hooks.isConjureResult({ ...valid, usage: undefined })).toBe(false);
    // usage is an array, not a plain object.
    expect(hooks.isConjureResult({ ...valid, usage: [] })).toBe(false);
    // usage is object-like but structurally invalid — missing all token
    // counts (Copilot review on PR #245).
    expect(hooks.isConjureResult({ ...valid, usage: {} })).toBe(false);
    // usage has a negative token count.
    expect(
      hooks.isConjureResult({ ...valid, usage: { ...valid.usage, promptTokens: -1 } }),
    ).toBe(false);
    // The whole reply is an array rather than an object.
    expect(hooks.isConjureResult([valid])).toBe(false);
  });

  it("fails closed on malformed list_kits entries (DRO-242)", () => {
    const { hooks } = loadHooks();
    const valid = { id: "acme-kit", name: "Acme", owner: "team", updatedAt: "now", canEdit: true };
    expect(hooks.isKitEntry(valid)).toBe(true);

    // Missing id.
    expect(hooks.isKitEntry({ ...valid, id: undefined })).toBe(false);
    // Empty-string id.
    expect(hooks.isKitEntry({ ...valid, id: "" })).toBe(false);
    // Missing name.
    expect(hooks.isKitEntry({ ...valid, name: undefined })).toBe(false);
    // canEdit is not a boolean (e.g. a truthy string).
    expect(hooks.isKitEntry({ ...valid, canEdit: "true" })).toBe(false);
    // owner present but not a string.
    expect(hooks.isKitEntry({ ...valid, owner: { name: "team" } })).toBe(false);
    // owner and updatedAt are both required strings in the canonical output
    // schema — omitting or mistyping either must fail closed.
    expect(hooks.isKitEntry({ id: "acme-kit", name: "Acme", canEdit: true })).toBe(false);
    expect(hooks.isKitEntry({ ...valid, owner: undefined })).toBe(false);
    expect(hooks.isKitEntry({ ...valid, updatedAt: undefined })).toBe(false);
    expect(hooks.isKitEntry({ ...valid, updatedAt: 12345 })).toBe(false);
    // The entry itself is an array, not a plain object.
    expect(hooks.isKitEntry([valid])).toBe(false);
    expect(hooks.isKitEntry(null)).toBe(false);
  });
});

describe("MCP host bridge", () => {
  it("calls tools/call with exact tool arguments and resolves structured content", async () => {
    const { hooks, window } = loadHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posted: any[] = [];
    const host = { postMessage: vi.fn((message) => posted.push(message)) };
    const bridge = hooks.createHostBridge(window, host);
    const args = {
      kitId: "acme-kit",
      kit: "Acme",
      prompt: "Build a status card",
      model: "design-default",
    };

    const pending = bridge.callTool("mcp__genie__conjure", args);
    const request = posted.at(-1);
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "mcp__genie__conjure", arguments: args },
    });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: host as any,
        data: {
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { componentName: "Status card" } },
        },
      }),
    );
    await expect(pending).resolves.toEqual({ componentName: "Status card" });
    bridge.destroy();
  });

  it("normalizes rejected, malformed, and progress host replies", async () => {
    const { hooks, window } = loadHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posted: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = { postMessage: (message: any) => posted.push(message) };
    const progress = vi.fn();
    const bridge = hooks.createHostBridge(window, host, progress);

    const malformed = bridge.callTool("mcp__genie__list_kits", {});
    const malformedId = posted.at(-1).id;
    window.dispatchEvent(
      new window.MessageEvent("message", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: host as any,
        data: { jsonrpc: "2.0", id: malformedId, result: { content: [] } },
      }),
    );
    await expect(malformed).rejects.toThrow("malformed");

    const rejected = bridge.callTool("mcp__genie__conjure", {});
    const rejectedId = posted.at(-1).id;
    window.dispatchEvent(
      new window.MessageEvent("message", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: host as any,
        data: { jsonrpc: "2.0", id: rejectedId, error: { message: "Endpoint timed out" } },
      }),
    );
    await expect(rejected).rejects.toThrow("Endpoint timed out");

    window.dispatchEvent(
      new window.MessageEvent("message", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: host as any,
        data: {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: "generate", message: "Validating files" },
        },
      }),
    );
    expect(progress).toHaveBeenCalledWith("Validating files");
    bridge.destroy();
  });
});

describe("route contract", () => {
  it("normalizes routes and updates history without accepting unknown destinations", () => {
    const { hooks, window } = loadHooks();
    expect(hooks.normalizeRoute("review")).toBe("review");
    expect(hooks.normalizeRoute("settings")).toBe("generate");

    hooks.writeRoute(window, "browse");
    expect(new URL(window.location.href).searchParams.get("route")).toBe("browse");
  });
});

describe("Generate surface DOM states", () => {
  it("renders host-unavailable and no-kit states honestly", async () => {
    const standalone = loadShell();
    standalone.hooks.initProductShell(standalone.document, null);
    await settle();
    expect(standalone.document.getElementById("kit-state")?.textContent).toContain(
      "requires an MCP-capable host",
    );
    expect(
      (standalone.document.getElementById("conjure-button") as HTMLButtonElement).disabled,
    ).toBe(true);

    const embedded = loadShell();
    embedded.hooks.initProductShell(embedded.document, {
      callTool: async () => ({ kits: [] }),
      destroy: () => {},
    });
    await settle();
    expect(embedded.document.getElementById("kit-state")?.textContent).toContain(
      "No kits yet — create or connect a UI kit first",
    );
    expect((embedded.document.getElementById("kit-select") as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it("fails closed and shows an error when list_kits returns non-array or malformed entries (DRO-242)", async () => {
    const nonArray = loadShell();
    nonArray.hooks.initProductShell(nonArray.document, {
      callTool: async () => ({ kits: "not-an-array" }),
      destroy: () => {},
    });
    await settle();
    expect(nonArray.document.getElementById("generate-error")?.hidden).toBe(false);
    expect(nonArray.document.getElementById("kit-state")?.textContent).toContain(
      "could not be loaded",
    );
    expect((nonArray.document.getElementById("kit-select") as HTMLSelectElement).value).toBe("");

    const malformedEntry = loadShell();
    malformedEntry.hooks.initProductShell(malformedEntry.document, {
      // Editable kit missing its id — a structurally invalid entry must
      // reject the whole reply (fail closed), not just be silently dropped.
      callTool: async () => ({ kits: [{ name: "Acme", canEdit: true }] }),
      destroy: () => {},
    });
    await settle();
    expect(malformedEntry.document.getElementById("generate-error")?.hidden).toBe(false);
    expect((malformedEntry.document.getElementById("kit-select") as HTMLSelectElement).value).toBe(
      "",
    );
  });

  it("submits once, retains the exact draft, routes to Review, and announces success", async () => {
    const { hooks, window, document } = loadShell();
    const result = {
      componentName: "Status card",
      group: "surfaces",
      files: [
        {
          path: "components/StatusCard.tsx",
          content: "export default null",
          mimeType: "text/tsx",
          encoding: "utf-8",
        },
      ],
      manifestEntry: { viewport: { width: 320, height: 240 } },
      usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
    };
    let resolveConjure: (value: unknown) => void = () => {};
    const conjure = new Promise((resolve) => {
      resolveConjure = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<{ name: string; args: any }> = [];
    const bridge = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool: vi.fn((name: string, args: any) => {
        calls.push({ name, args });
        if (name === "mcp__genie__list_kits") {
          return Promise.resolve({
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", updatedAt: "2026-01-01T00:00:00Z", canEdit: true }],
          });
        }
        return conjure;
      }),
      destroy: () => {},
    };
    hooks.initProductShell(document, bridge);
    await settle();

    const prompt = document.getElementById("generate-prompt") as HTMLTextAreaElement;
    prompt.value = "  Build a compact status card  ";
    prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
    const button = document.getElementById("conjure-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    button.click();
    await settle();

    expect(calls.filter((call) => call.name === "mcp__genie__conjure")).toEqual([
      {
        name: "mcp__genie__conjure",
        args: {
          kitId: "acme-kit",
          kit: "Acme",
          prompt: "Build a compact status card",
          model: "design-default",
        },
      },
    ]);
    expect(document.getElementById("generate-progress")?.hidden).toBe(false);

    resolveConjure(result);
    await settle();
    expect(new URL(window.location.href).searchParams.get("route")).toBe("review");
    expect(document.getElementById("draft-label")?.textContent).toBe("draft #1");
    expect(document.getElementById("draft-name")?.textContent).toBe("Status card");
    expect(document.getElementById("app-status")?.textContent).toBe(
      "Generated Status card, draft #1.",
    );
    expect(document.querySelector("[data-route-view='review']")?.hidden).toBe(false);
  });

  it("preserves the form and prior draft after a retryable Conjure error", async () => {
    const { hooks, window, document } = loadShell();
    let attempts = 0;
    const bridge = {
      callTool: (name: string) => {
        if (name === "mcp__genie__list_kits") {
          return Promise.resolve({
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", updatedAt: "2026-01-01T00:00:00Z", canEdit: true }],
          });
        }
        attempts += 1;
        return Promise.reject(new Error("Endpoint authentication failed"));
      },
      destroy: () => {},
    };
    hooks.initProductShell(document, bridge);
    await settle();
    const prompt = document.getElementById("generate-prompt") as HTMLTextAreaElement;
    prompt.value = "Build a compact status card";
    prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
    (document.getElementById("conjure-button") as HTMLButtonElement).click();
    await settle();

    expect(prompt.value).toBe("Build a compact status card");
    expect((document.getElementById("kit-select") as HTMLSelectElement).value).toBe("acme-kit");
    expect(document.getElementById("generate-error")?.hidden).toBe(false);
    expect(document.getElementById("generate-error-detail")?.textContent).toContain(
      "authentication failed",
    );
    (document.getElementById("generate-retry") as HTMLButtonElement).click();
    await settle();
    expect(attempts).toBe(2);
  });

  it("retries kit discovery — not generation — when list_kits was what failed", async () => {
    const { hooks, document } = loadShell();
    let listKitsCalls = 0;
    let conjureCalls = 0;
    const bridge = {
      callTool: (name: string) => {
        if (name === "mcp__genie__list_kits") {
          listKitsCalls += 1;
          // First discovery fails; the retry succeeds with a real kit.
          if (listKitsCalls === 1) {
            return Promise.reject(new Error("The host returned malformed UI-kit data."));
          }
          return Promise.resolve({
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", updatedAt: "2026-01-01T00:00:00Z", canEdit: true }],
          });
        }
        conjureCalls += 1;
        return Promise.resolve({});
      },
      destroy: () => {},
    };
    hooks.initProductShell(document, bridge);
    await settle();

    // Discovery failed: error is shown, no kit is selectable.
    expect(document.getElementById("generate-error")?.hidden).toBe(false);
    expect((document.getElementById("kit-select") as HTMLSelectElement).value).toBe("");

    // Retry must re-run discovery (not submitGenerate, which would no-op with no kit).
    (document.getElementById("generate-retry") as HTMLButtonElement).click();
    await settle();

    expect(listKitsCalls).toBe(2);
    expect(conjureCalls).toBe(0);
    expect((document.getElementById("kit-select") as HTMLSelectElement).value).toBe("acme-kit");
    expect(document.getElementById("generate-error")?.hidden).toBe(true);
  });

  it("moves focus to the Review heading on a successful route change, out of the hidden Generate subtree", async () => {
    const { hooks, window, document } = loadShell();
    let resolveConjure: (value: unknown) => void = () => {};
    const conjure = new Promise((resolve) => {
      resolveConjure = resolve;
    });
    const bridge = {
      callTool: (name: string) => {
        if (name === "mcp__genie__list_kits") {
          return Promise.resolve({
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", updatedAt: "2026-01-01T00:00:00Z", canEdit: true }],
          });
        }
        return conjure;
      },
      destroy: () => {},
    };
    hooks.initProductShell(document, bridge);
    await settle();
    const prompt = document.getElementById("generate-prompt") as HTMLTextAreaElement;
    prompt.value = "Build a compact status card";
    prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
    const button = document.getElementById("conjure-button") as HTMLButtonElement;
    button.focus();
    button.click();
    resolveConjure({
      componentName: "Status card",
      group: "surfaces",
      files: [
        {
          path: "components/StatusCard.tsx",
          content: "export default null",
          mimeType: "text/tsx",
          encoding: "utf-8",
        },
      ],
      manifestEntry: { viewport: { width: 320, height: 240 } },
      usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
    });
    await settle();

    // Focus landed on the rendered draft heading, never left on the now-hidden button.
    expect(document.activeElement?.id).toBe("draft-name");
    expect(document.getElementById("draft-name")?.textContent).toBe("Status card");
  });
});
