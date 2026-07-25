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
      files: [{ path: "x", content: "x", mimeType: "text/plain", encoding: "utf8" }],
      manifestEntry: {},
      usage: {},
    };
    expect(hooks.isConjureResult(valid)).toBe(true);
    expect(hooks.isConjureResult({ ...valid, files: undefined })).toBe(false);
    expect(hooks.isConjureResult({ ...valid, componentName: "" })).toBe(false);
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

  it("drives production submitGenerate to request no client-side deadline for conjure, unlike generic calls", async () => {
    // Regression for genie#241 / Copilot review on #243: a fixed client
    // deadline for conjure (originally 150s) can still be too short —
    // `GENIE_LLM_REQUEST_TIMEOUT_MS` bounds each individual HTTP attempt,
    // not the call as a whole, and `conjure` can run a two-attempt schema
    // retry loop where EACH attempt is itself wrapped in `withRetry` (up to
    // `1 + GENIE_LLM_RETRY_MAX`, default 4, HTTP attempts with backoff
    // between them) — both the timeout and the retry ceiling are
    // operator-configurable, so no fixed client constant can be derived
    // that's guaranteed to outlast every valid deployment's worst case.
    //
    // The fix: the conjure call site now passes `NO_CLIENT_DEADLINE` as its
    // `callTool` timeout override, so `createHostBridge` schedules no
    // client-side timer for that call at all.
    //
    // This drives submission through the real Generate submit path
    // (`initProductShell` → `submitGenerate`, via a DOM click), not a direct
    // `bridge.callTool` call — closing the exact gap the Copilot review on
    // #243 flagged in the prior version of this test (supplying the
    // timeout override directly to `callTool` duplicated, rather than
    // verified, the production call site — it would still pass even if the
    // Generate submit path stopped threading the override through).
    const { hooks, window, document } = loadShell();
    expect(hooks.NO_CLIENT_DEADLINE).toBeNull();

    let resolveConjure: (value: unknown) => void = () => {};
    const conjure = new Promise((resolve) => {
      resolveConjure = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<{ name: string; args: any; timeoutMs: unknown }> = [];
    const bridge = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool: vi.fn((name: string, args: any, timeoutMs: unknown) => {
        calls.push({ name, args, timeoutMs });
        if (name === "mcp__genie__list_kits") {
          return Promise.resolve({
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", canEdit: true }],
          });
        }
        if (name === "mcp__genie__list_files") {
          return Promise.resolve({ files: [] });
        }
        if (name === "mcp__genie__list_components") {
          return Promise.resolve({ components: [] });
        }
        return conjure;
      }),
      destroy: () => {},
    };
    hooks.initProductShell(document, bridge);
    await settle();

    const prompt = document.getElementById("generate-prompt") as HTMLTextAreaElement;
    prompt.value = "Build a compact status card";
    prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
    (document.getElementById("conjure-button") as HTMLButtonElement).click();
    await settle();

    const listKitsCall = calls.find((call) => call.name === "mcp__genie__list_kits");
    const conjureCall = calls.find((call) => call.name === "mcp__genie__conjure");
    // The production submit path threads NO_CLIENT_DEADLINE through to the
    // conjure call specifically. If the call site ever stops passing it,
    // this assertion (not just the bridge-level unit test below) catches it.
    expect(conjureCall?.timeoutMs).toBe(hooks.NO_CLIENT_DEADLINE);
    expect(conjureCall?.timeoutMs).toBeNull();
    // Generic calls are unaffected: submitGenerate never threads an
    // override through for them (they keep the fixed 60s default).
    expect(listKitsCall?.timeoutMs).toBeUndefined();

    resolveConjure({
      componentName: "Status card",
      group: "surfaces",
      files: [{ path: "components/StatusCard.tsx", content: "export default null" }],
      manifestEntry: { name: "Status card" },
      usage: { inputTokens: 12, outputTokens: 20 },
    });
    await settle();
    expect(document.getElementById("draft-name")?.textContent).toBe("Status card");
  });

  it("createHostBridge schedules no timer at all for NO_CLIENT_DEADLINE, however long the host takes", async () => {
    // Bridge-level companion to the submit-path test above: confirms
    // `createHostBridge` itself honours the sentinel — the call is still
    // pending arbitrarily far past both the old 60s generic default and the
    // server's 120s LLM ceiling, and only settles once the host actually
    // replies.
    vi.useFakeTimers();
    try {
      const { hooks, window } = loadHooks();
      const posted: unknown[] = [];
      const host = { postMessage: vi.fn((message) => posted.push(message)) };
      const bridge = hooks.createHostBridge(window, host);

      const pending = bridge.callTool("mcp__genie__conjure", {}, hooks.NO_CLIENT_DEADLINE);
      pending.catch(() => {});

      // Advance well past both the old 60s generic default and the
      // server's 120s LLM ceiling: still pending, no client-side timeout.
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const request = posted.at(-1) as { id: number };
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("still times out a generic (non-conjure) tool call at the default 60s deadline", async () => {
    vi.useFakeTimers();
    try {
      const { hooks, window } = loadHooks();
      const host = { postMessage: vi.fn() };
      const bridge = hooks.createHostBridge(window, host);

      const pending = bridge.callTool("mcp__genie__list_kits", {});
      const assertion = expect(pending).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
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

  it("submits once, retains the exact draft, routes to Review, and announces success", async () => {
    const { hooks, window, document } = loadShell();
    const result = {
      componentName: "Status card",
      group: "surfaces",
      files: [{ path: "components/StatusCard.tsx", content: "export default null" }],
      manifestEntry: { name: "Status card" },
      usage: { inputTokens: 12, outputTokens: 20 },
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
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", canEdit: true }],
          });
        }
        if (name === "mcp__genie__list_files") return Promise.resolve({ files: [] });
        if (name === "mcp__genie__list_components") return Promise.resolve({ components: [] });
        if (name === "mcp__genie__conjure") return conjure;
        return Promise.resolve({});
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
          kit: 'UI kit "Acme" (id: acme-kit).',
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
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", canEdit: true }],
          });
        }
        if (name === "mcp__genie__list_files") return Promise.resolve({ files: [] });
        if (name === "mcp__genie__list_components") return Promise.resolve({ components: [] });
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
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", canEdit: true }],
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
            kits: [{ id: "acme-kit", name: "Acme", owner: "team", canEdit: true }],
          });
        }
        if (name === "mcp__genie__list_files") return Promise.resolve({ files: [] });
        if (name === "mcp__genie__list_components") return Promise.resolve({ components: [] });
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
      files: [{ path: "components/StatusCard.tsx", content: "export default null" }],
      manifestEntry: { name: "Status card" },
      usage: { inputTokens: 12, outputTokens: 20 },
    });
    await settle();

    // Focus landed on the rendered draft heading, never left on the now-hidden button.
    expect(document.activeElement?.id).toBe("draft-name");
    expect(document.getElementById("draft-name")?.textContent).toBe("Status card");
  });
});

describe("buildKitContext (genie#239 / Copilot review on #246)", () => {
  function bridgeWith(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: Record<string, (args: any) => Promise<unknown>>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<{ name: string; args: any }> = [];
    return {
      calls,
      bridge: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callTool: (name: string, args: any) => {
          calls.push({ name, args });
          const handler = handlers[name];
          return handler ? handler(args) : Promise.resolve({});
        },
        destroy: () => {},
      },
    };
  }

  function shellWithProductInit() {
    const { hooks, document } = loadShell();
    // `buildKitContext` lives inside initProductShell's closure — it's
    // exposed via the object initProductShell() returns (not directly on
    // __genieViewerTestHooks), so tests must go through that instance.
    return hooks.initProductShell(document, {
      callTool: () => Promise.resolve({}),
      destroy: () => {},
    });
  }

  it("reads populated token files AND the root styles.css, folding both into the context string", async () => {
    const shell = shellWithProductInit();
    const { bridge, calls } = bridgeWith({
      mcp__genie__list_files: () =>
        Promise.resolve({
          files: [
            { path: "tokens/colors.css" },
            { path: "styles.css" },
            { path: "README.md" },
          ],
        }),
      mcp__genie__list_components: () => Promise.resolve({ components: [] }),
      mcp__genie__read_file: (args: { path: string }) => {
        if (args.path === "tokens/colors.css") {
          return Promise.resolve({ content: "--color-brand: #123456;", encoding: "utf-8" });
        }
        if (args.path === "styles.css") {
          return Promise.resolve({ content: "@import './tokens/colors.css';", encoding: "utf-8" });
        }
        return Promise.reject(new Error("unexpected read"));
      },
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    expect(context).toContain('UI kit "Acme" (id: acme-kit).');
    expect(context).toContain("tokens/colors.css");
    expect(context).toContain("--color-brand: #123456;");
    expect(context).toContain("styles.css");
    expect(context).toContain("@import './tokens/colors.css';");
    // README.md is neither tokens/** nor root styles.css — never read.
    expect(calls.some((c) => c.name === "mcp__genie__read_file" && c.args.path === "README.md")).toBe(
      false,
    );
  });

  it("reads a bounded sample of existing component file contents, not just group/name metadata", async () => {
    const shell = shellWithProductInit();
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () => Promise.resolve({ files: [] }),
      mcp__genie__list_components: () =>
        Promise.resolve({
          components: [
            { group: "surfaces", name: "Card", path: "components/Card.tsx" },
            { group: "actions", name: "Button", path: "components/Button.tsx" },
          ],
        }),
      mcp__genie__read_file: (args: { path: string }) => {
        if (args.path === "components/Card.tsx") {
          return Promise.resolve({ content: "export function Card() {}", encoding: "utf-8" });
        }
        if (args.path === "components/Button.tsx") {
          return Promise.resolve({ content: "export function Button() {}", encoding: "utf-8" });
        }
        return Promise.reject(new Error("unexpected read"));
      },
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    expect(context).toContain("Existing primitives/components: surfaces/Card, actions/Button");
    expect(context).toContain("component: surfaces/Card");
    expect(context).toContain("export function Card() {}");
    expect(context).toContain("component: actions/Button");
    expect(context).toContain("export function Button() {}");
  });

  it("falls back gracefully when a token file is unreadable, keeping the rest of the context", async () => {
    const shell = shellWithProductInit();
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () =>
        Promise.resolve({ files: [{ path: "tokens/broken.css" }, { path: "tokens/ok.css" }] }),
      mcp__genie__list_components: () => Promise.resolve({ components: [] }),
      mcp__genie__read_file: (args: { path: string }) => {
        if (args.path === "tokens/broken.css") return Promise.reject(new Error("host read failed"));
        return Promise.resolve({ content: "--space-1: 4px;", encoding: "utf-8" });
      },
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    expect(context).toContain("tokens/ok.css");
    expect(context).toContain("--space-1: 4px;");
    expect(context).not.toContain("tokens/broken.css");
  });

  it("caps total context length at KIT_CONTEXT_MAX_CHARS across multiple token files", async () => {
    const shell = shellWithProductInit();
    const bigChunk = "x".repeat(15_000);
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () =>
        Promise.resolve({
          files: [{ path: "tokens/a.css" }, { path: "tokens/b.css" }, { path: "tokens/c.css" }],
        }),
      mcp__genie__list_components: () => Promise.resolve({ components: [] }),
      mcp__genie__read_file: () => Promise.resolve({ content: bigChunk, encoding: "utf-8" }),
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    // Regression for Copilot review on #246: this used to allow slack
    // because headings were appended to an already-sliced chunk (so a chunk
    // could exceed its remaining budget) and the "\n\n" join separators
    // between sections weren't accounted for at all. The assembled string
    // must now be a hard cap at KIT_CONTEXT_MAX_CHARS.
    expect(context.length).toBeLessThanOrEqual(20_000);
  });

  it("truncates the trailing components-inventory line rather than letting it push the assembled context past KIT_CONTEXT_MAX_CHARS", async () => {
    const shell = shellWithProductInit();
    const bigChunk = "x".repeat(19_950);
    const manyComponents = Array.from({ length: 200 }, (_, i) => ({
      group: "group" + i,
      name: "Component" + i,
      path: "components/Component" + i + ".tsx",
    }));
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () => Promise.resolve({ files: [{ path: "styles.css" }] }),
      mcp__genie__list_components: () => Promise.resolve({ components: manyComponents }),
      mcp__genie__read_file: (args: { path: string }) => {
        if (args.path === "styles.css") return Promise.resolve({ content: bigChunk, encoding: "utf-8" });
        return Promise.reject(new Error("unexpected read"));
      },
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    // Regression for Copilot review on #246: the components-inventory line
    // used to be appended unconditionally AFTER the budget-tracked loop, so
    // it could push the total past KIT_CONTEXT_MAX_CHARS (and past conjure's
    // own 100k kit-schema cap) regardless of how much budget remained.
    expect(context.length).toBeLessThanOrEqual(20_000);
  });

  it("proceeds with partial context once the shared deadline elapses, instead of waiting on every read", async () => {
    const shell = shellWithProductInit();
    let readCalls = 0;
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () => Promise.resolve({ files: [{ path: "tokens/slow.css" }] }),
      mcp__genie__list_components: () => Promise.resolve({ components: [] }),
      mcp__genie__read_file: () => {
        readCalls += 1;
        // Never resolves — simulates an unresponsive host tool call. Without
        // a shared deadline this would hang buildKitContext (and therefore
        // the whole test) rather than degrading to partial context.
        return new Promise(() => {});
      },
    });

    // Regression for Copilot review on #246: this test previously exercised
    // the real, production KIT_CONTEXT_DEADLINE_MS (8s) by omitting the
    // deadline argument, which meant it genuinely blocked for ~8s of real
    // wall-clock time on every focused and full test run. buildKitContext
    // now takes an injectable deadline override specifically so tests like
    // this one can exercise the "deadline elapses" branch with a short,
    // deterministic budget instead.
    const injectedDeadlineMs = 25;
    const start = Date.now();
    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme", injectedDeadlineMs);
    const elapsed = Date.now() - start;

    expect(readCalls).toBe(1);
    expect(context).toBe('UI kit "Acme" (id: acme-kit).');
    // Bounded by the injected deadline, not the host bridge's 60s per-call
    // timeout or the real production KIT_CONTEXT_DEADLINE_MS — generous
    // slack for CI jitter while still being far shorter than either.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("falls back to the display name alone when both list tools are unavailable", async () => {
    const shell = shellWithProductInit();
    const { bridge } = bridgeWith({
      mcp__genie__list_files: () => Promise.reject(new Error("not implemented")),
      mcp__genie__list_components: () => Promise.reject(new Error("not implemented")),
    });

    const context = await shell.buildKitContext(bridge, "acme-kit", "Acme");

    expect(context).toBe('UI kit "Acme" (id: acme-kit).');
  });
});

describe("MCP-App handshake capability gate", () => {
  function fakeHostWindow() {
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    const posted: unknown[] = [];
    const parent = {
      postMessage: (message: unknown) => posted.push(message),
    };
    const win = {
      parent,
      document: { documentElement: null, body: null },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ||= []).push(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = (listeners[type] || []).filter((l) => l !== listener);
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      ResizeObserver: undefined,
    };
    function dispatch(data: unknown) {
      for (const listener of listeners.message || []) {
        listener({ source: parent, data });
      }
    }
    return { win, posted, dispatch };
  }

  it("does not hand over a live bridge when the host omits hostCapabilities.serverTools", () => {
    const { hooks } = loadHooks();
    const { win, posted, dispatch } = fakeHostWindow();
    const onReady = vi.fn();
    const onUnavailable = vi.fn();

    hooks.initMcpApp(
      { getElementById: () => null, querySelectorAll: () => [] },
      {
        win,
        onReady,
        onUnavailable,
      },
    );

    const initializeRequest = posted.at(-1) as { id: number };
    dispatch({ jsonrpc: "2.0", id: initializeRequest.id, result: { hostCapabilities: {} } });

    expect(onReady).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("does not hand over a live bridge when hostCapabilities is absent entirely", () => {
    const { hooks } = loadHooks();
    const { win, posted, dispatch } = fakeHostWindow();
    const onReady = vi.fn();
    const onUnavailable = vi.fn();

    hooks.initMcpApp(
      { getElementById: () => null, querySelectorAll: () => [] },
      {
        win,
        onReady,
        onUnavailable,
      },
    );

    const initializeRequest = posted.at(-1) as { id: number };
    dispatch({ jsonrpc: "2.0", id: initializeRequest.id, result: {} });

    expect(onReady).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("hands over a live bridge when the host advertises hostCapabilities.serverTools", () => {
    const { hooks } = loadHooks();
    const { win, posted, dispatch } = fakeHostWindow();
    const onReady = vi.fn();
    const onUnavailable = vi.fn();

    hooks.initMcpApp(
      { getElementById: () => null, querySelectorAll: () => [] },
      {
        win,
        onReady,
        onUnavailable,
      },
    );

    const initializeRequest = posted.at(-1) as { id: number };
    dispatch({
      jsonrpc: "2.0",
      id: initializeRequest.id,
      result: { hostCapabilities: { serverTools: {} } },
    });

    expect(onUnavailable).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
