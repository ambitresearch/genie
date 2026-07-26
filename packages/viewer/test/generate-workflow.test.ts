import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_BROWSE_JS = readFileSync(resolve(HERE, "../static/viewer-browse.js"), "utf8");
const VIEWER_JS = readFileSync(resolve(HERE, "../static/viewer.js"), "utf8");
/**
 * The two classic scripts `index.html` loads, concatenated in document order.
 * Browse comes FIRST (#253): `viewer.js` auto-boots as it is parsed and its
 * boot path calls into the Browse workbench. Each file is its own IIFE, so
 * concatenating them is equivalent to two ordered `<script>` tags.
 */
const VIEWER_SCRIPTS = VIEWER_BROWSE_JS + "\n" + VIEWER_JS;
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
  dom.window.eval(VIEWER_SCRIPTS);
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
  dom.window.eval(VIEWER_SCRIPTS);
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
      componentName: "StatusCard",
      group: "surfaces",
      files: [
        {
          path: "components/surfaces/StatusCard/StatusCard.html",
          content: "x",
          mimeType: "text/plain",
          encoding: "utf-8",
        },
      ],
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
        {
          path: "components/surfaces/StatusCard/StatusCard.html",
          content: "<div>@genie</div>",
          mimeType: "text/html",
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
        files: [{ path: "components/surfaces/StatusCard/StatusCard.tsx", content: "export {}" }],
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
    expect(hooks.isConjureResult({ ...valid, usage: { ...valid.usage, promptTokens: -1 } })).toBe(
      false,
    );
    // The whole reply is an array rather than an object.
    expect(hooks.isConjureResult([valid])).toBe(false);
    // A files[] entry with an extra, unrecognized key — every required field
    // is present and correctly typed, but conjure's output schema is
    // `.strict()` (Copilot review round 3 on PR #245).
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], unexpected: true }],
      }),
    ).toBe(false);
    // manifestEntry with an extra top-level key beyond viewport/subtitle/tags.
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { ...valid.manifestEntry, unexpected: true },
      }),
    ).toBe(false);
    // manifestEntry.viewport with an extra key beyond width/height.
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: {
          ...valid.manifestEntry,
          viewport: { ...valid.manifestEntry.viewport, unexpected: true },
        },
      }),
    ).toBe(false);
    // usage with an extra key beyond promptTokens/completionTokens/totalTokens.
    expect(hooks.isConjureResult({ ...valid, usage: { ...valid.usage, unexpected: true } })).toBe(
      false,
    );
    // Top-level result with an extra key beyond the canonical five.
    expect(hooks.isConjureResult({ ...valid, unexpected: true })).toBe(false);
    // componentName with a space / lowercase leading char — not PascalCase
    // (Copilot review round 4 on PR #245).
    expect(hooks.isConjureResult({ ...valid, componentName: "Status card" })).toBe(false);
    // group uppercase or over the 32-char cap — not kebab-case.
    expect(hooks.isConjureResult({ ...valid, group: "Surfaces" })).toBe(false);
    expect(hooks.isConjureResult({ ...valid, group: "s".repeat(33) })).toBe(false);
    // More than 12 files exceeds COMPONENT_SCHEMA's maxItems.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: Array.from({ length: 13 }, function (_, i) {
          return {
            path: "components/surfaces/StatusCard/File" + i + ".tsx",
            content: "export {}",
            mimeType: "text/tsx",
            encoding: "utf-8",
          };
        }).concat(valid.files[1]),
      }),
    ).toBe(false);
    // Every file present but none is the required <Name>.html preview
    // (AC5's `contains` rule).
    expect(hooks.isConjureResult({ ...valid, files: [valid.files[0]] })).toBe(false);
    // An .html file exists but its <Name> doesn't match the directory's
    // <Name> segment — not self-consistent.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [
          valid.files[0],
          { ...valid.files[1], path: "components/surfaces/StatusCard/Wrong.html" },
        ],
      }),
    ).toBe(false);
    // A file path outside the components/<group>/<Name>/ layout.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], path: "StatusCard.tsx" }, valid.files[1]],
      }),
    ).toBe(false);
    // A mimeType that doesn't match the type/subtype pattern.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], mimeType: "not-a-mime-type" }, valid.files[1]],
      }),
    ).toBe(false);
    // files[].content over the 65536-char maxLength (Copilot review round 5
    // on PR #245) — every required field is present and correctly typed,
    // but the canonical schema bounds content length.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], content: "x".repeat(65537) }, valid.files[1]],
      }),
    ).toBe(false);
    // Astral-character boundary (Copilot review round 6 on PR #245):
    // `maxLength` counts Unicode CODE POINTS, not UTF-16 code units. A
    // string of exactly 65536 astral characters (each a surrogate PAIR,
    // so `.length` reads 131072) is schema-VALID and must be ACCEPTED; one
    // MORE astral character (65537 code points) must be rejected. A naive
    // `.length` check gets both of these backwards.
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], content: "\u{1F600}".repeat(65536) }, valid.files[1]],
      }),
    ).toBe(true);
    expect(
      hooks.isConjureResult({
        ...valid,
        files: [{ ...valid.files[0], content: "\u{1F600}".repeat(65537) }, valid.files[1]],
      }),
    ).toBe(false);
    // manifestEntry.viewport dimensions outside the canonical [1, 4096]
    // integer range — fractions, zero, negatives, over-max, NaN, and
    // Infinity are all schema violations a bare `typeof === "number"` check
    // let through (Copilot review round 5 on PR #245).
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { viewport: { width: 480.5, height: 240 } },
      }),
    ).toBe(false);
    expect(
      hooks.isConjureResult({ ...valid, manifestEntry: { viewport: { width: 0, height: 240 } } }),
    ).toBe(false);
    expect(
      hooks.isConjureResult({ ...valid, manifestEntry: { viewport: { width: -1, height: 240 } } }),
    ).toBe(false);
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { viewport: { width: 4097, height: 240 } },
      }),
    ).toBe(false);
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { viewport: { width: NaN, height: 240 } },
      }),
    ).toBe(false);
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { viewport: { width: Infinity, height: 240 } },
      }),
    ).toBe(false);
    // manifestEntry.subtitle over the 256-char maxLength.
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { ...valid.manifestEntry, subtitle: "x".repeat(257) },
      }),
    ).toBe(false);
    // Astral-character boundary for subtitle, same reasoning as content
    // above: exactly 256 astral code points must be accepted even though
    // `.length` reads 512; 257 must be rejected.
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { ...valid.manifestEntry, subtitle: "\u{1F600}".repeat(256) },
      }),
    ).toBe(true);
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: { ...valid.manifestEntry, subtitle: "\u{1F600}".repeat(257) },
      }),
    ).toBe(false);
    // manifestEntry.tags over the 16-item maxItems.
    expect(
      hooks.isConjureResult({
        ...valid,
        manifestEntry: {
          ...valid.manifestEntry,
          tags: Array.from({ length: 17 }, function (_, i) {
            return "tag" + i;
          }),
        },
      }),
    ).toBe(false);
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
    // An extra, unrecognized key — list_kits' output schema is `.strict()`
    // (Copilot review round 3 on PR #245).
    expect(hooks.isKitEntry({ ...valid, unexpected: true })).toBe(false);
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
            kits: [
              { id: "acme-kit", name: "Acme", owner: "team", updatedAt: "now", canEdit: true },
            ],
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
      componentName: "StatusCard",
      group: "surfaces",
      files: [
        {
          path: "components/surfaces/StatusCard/StatusCard.html",
          content: "x",
          mimeType: "text/plain",
          encoding: "utf-8",
        },
      ],
      manifestEntry: { viewport: { width: 320, height: 240 } },
      usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
    });
    await settle();
    expect(document.getElementById("draft-name")?.textContent).toBe("StatusCard");
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

    // The canonical list_kits output schema is strict at the reply level
    // (additionalProperties: false, packages/server/src/tools/
    // list_kits.test.ts:174-178) — `kits` is the only allowed key. A reply
    // with an extra top-level key must be rejected outright, not accepted
    // because `kits` itself happens to be well-formed (Copilot review round
    // 4 on PR #245).
    const unexpectedKey = loadShell();
    unexpectedKey.hooks.initProductShell(unexpectedKey.document, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool: async () => ({ kits: [], unexpected: true }) as any,
      destroy: () => {},
    });
    await settle();
    expect(unexpectedKey.document.getElementById("generate-error")?.hidden).toBe(false);
    expect(unexpectedKey.document.getElementById("kit-state")?.textContent).toContain(
      "could not be loaded",
    );
    expect((unexpectedKey.document.getElementById("kit-select") as HTMLSelectElement).value).toBe(
      "",
    );
  });

  it("clears stale trusted kit state before a malformed list_kits refresh can leave it intact (DRO-242)", async () => {
    const { hooks, document } = loadShell();
    let listKitsCalls = 0;
    const bridge = {
      callTool: (name: string) => {
        if (name === "mcp__genie__list_kits") {
          listKitsCalls += 1;
          // First discovery succeeds with a real, editable kit...
          if (listKitsCalls === 1) {
            return Promise.resolve({
              kits: [
                {
                  id: "acme-kit",
                  name: "Acme",
                  owner: "team",
                  updatedAt: "2026-01-01T00:00:00Z",
                  canEdit: true,
                },
              ],
            });
          }
          // ...but a subsequent refresh (e.g. a host reconnect) comes back
          // malformed.
          return Promise.resolve({ kits: "not-an-array" });
        }
        return Promise.reject(new Error("conjure should not be called in this test"));
      },
      destroy: () => {},
    };
    const controller = hooks.initProductShell(document, bridge);
    await settle();

    const kitSelect = document.getElementById("kit-select") as HTMLSelectElement;
    expect(kitSelect.value).toBe("acme-kit");
    expect(kitSelect.disabled).toBe(false);

    const prompt = document.getElementById("generate-prompt") as HTMLTextAreaElement;
    prompt.value = "Build a compact status card";
    prompt.dispatchEvent(
      new (document.defaultView as typeof window).Event("input", { bubbles: true }),
    );
    expect((document.getElementById("conjure-button") as HTMLButtonElement).disabled).toBe(false);

    // Simulate a host refresh (e.g. reconnect) that re-invokes discovery —
    // this is the same path Retry takes when no kits are loaded.
    controller.setBridge(bridge);
    await settle();

    expect(listKitsCalls).toBe(2);
    // The malformed refresh must clear the previously trusted kit — the
    // stale option/value from discovery #1 must not survive.
    expect(kitSelect.value).toBe("");
    expect(kitSelect.disabled).toBe(true);
    expect(document.getElementById("kit-state")?.textContent).toContain("could not be loaded");
    // With kits cleared, Conjure must be gated off again rather than left
    // enabled on stale data.
    expect((document.getElementById("conjure-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores an older, out-of-order list_kits reply after a newer discovery has already superseded it (DRO-242)", async () => {
    // Copilot review round 6 on PR #245: `setBridge` calls `loadKits()`
    // without cancelling or versioning any call already in flight. Network
    // replies do not have to resolve in call order — an OLDER discovery's
    // `callTool` promise can settle AFTER a NEWER one's. If the older call's
    // resolution is allowed to mutate `kits`/the DOM regardless, it can
    // resurrect a stale (or, as here, malformed-and-rejected) state on top
    // of whatever the newer call already decided.
    const { hooks, document } = loadShell();
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const bridge = {
      callTool: (name: string) => {
        if (name === "mcp__genie__list_kits") {
          callCount += 1;
          // The FIRST call (older) is left pending — it resolves later,
          // out of order, once we've already observed the second call's
          // result below.
          if (callCount === 1) return first;
          // The SECOND call (newer) resolves immediately with a malformed
          // reply — this is the call whose fail-closed outcome must win.
          return Promise.resolve({ kits: "not-an-array" });
        }
        return Promise.reject(new Error("conjure should not be called in this test"));
      },
      destroy: () => {},
    };
    const controller = hooks.initProductShell(document, bridge);
    // Trigger the second (newer) discovery before the first has settled —
    // e.g. a rapid host reconnect while the initial discovery was still
    // in flight.
    controller.setBridge(bridge);
    await settle();

    const kitSelect = document.getElementById("kit-select") as HTMLSelectElement;
    // The newer call's malformed reply must have already failed closed.
    expect(callCount).toBe(2);
    expect(kitSelect.value).toBe("");
    expect(kitSelect.disabled).toBe(true);
    expect(document.getElementById("kit-state")?.textContent).toContain("could not be loaded");

    // Now the STALE first call finally resolves with a well-formed,
    // editable kit — arriving strictly after the newer call already
    // rejected. It must be silently ignored: no re-populating `kits`, no
    // re-enabling the `<select>`/Conjure gate on data a newer call has
    // already superseded.
    resolveFirst({
      kits: [
        {
          id: "stale-kit",
          name: "Stale",
          owner: "team",
          updatedAt: "2026-01-01T00:00:00Z",
          canEdit: true,
        },
      ],
    });
    await settle();

    expect(kitSelect.value).toBe("");
    expect(kitSelect.disabled).toBe(true);
    expect(document.getElementById("kit-state")?.textContent).toContain("could not be loaded");
    expect((document.getElementById("conjure-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits once, retains the exact draft, routes to Review, and announces success", async () => {
    const { hooks, window, document } = loadShell();
    const result = {
      componentName: "StatusCard",
      group: "surfaces",
      files: [
        {
          path: "components/surfaces/StatusCard/StatusCard.tsx",
          content: "export default null",
          mimeType: "text/tsx",
          encoding: "utf-8",
        },
        {
          path: "components/surfaces/StatusCard/StatusCard.html",
          content: "<div>@genie</div>",
          mimeType: "text/html",
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
            kits: [
              {
                id: "acme-kit",
                name: "Acme",
                owner: "team",
                updatedAt: "2026-01-01T00:00:00Z",
                canEdit: true,
              },
            ],
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
    expect(document.getElementById("draft-name")?.textContent).toBe("StatusCard");
    expect(document.getElementById("app-status")?.textContent).toBe(
      "Generated StatusCard, draft #1.",
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
            kits: [
              {
                id: "acme-kit",
                name: "Acme",
                owner: "team",
                updatedAt: "2026-01-01T00:00:00Z",
                canEdit: true,
              },
            ],
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
            kits: [
              {
                id: "acme-kit",
                name: "Acme",
                owner: "team",
                updatedAt: "2026-01-01T00:00:00Z",
                canEdit: true,
              },
            ],
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
            kits: [
              {
                id: "acme-kit",
                name: "Acme",
                owner: "team",
                updatedAt: "2026-01-01T00:00:00Z",
                canEdit: true,
              },
            ],
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
      componentName: "StatusCard",
      group: "surfaces",
      files: [
        {
          path: "components/surfaces/StatusCard/StatusCard.tsx",
          content: "export default null",
          mimeType: "text/tsx",
          encoding: "utf-8",
        },
        {
          path: "components/surfaces/StatusCard/StatusCard.html",
          content: "<div>@genie</div>",
          mimeType: "text/html",
          encoding: "utf-8",
        },
      ],
      manifestEntry: { viewport: { width: 320, height: 240 } },
      usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
    });
    await settle();

    // Focus landed on the rendered draft heading, never left on the now-hidden button.
    expect(document.activeElement?.id).toBe("draft-name");
    expect(document.getElementById("draft-name")?.textContent).toBe("StatusCard");
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
          files: [{ path: "tokens/colors.css" }, { path: "styles.css" }, { path: "README.md" }],
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
    expect(
      calls.some((c) => c.name === "mcp__genie__read_file" && c.args.path === "README.md"),
    ).toBe(false);
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
        if (args.path === "styles.css")
          return Promise.resolve({ content: bigChunk, encoding: "utf-8" });
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

describe("MCP host bridge — text-only tool results (#251)", () => {
  /**
   * Post a `tools/call` and reply with `result`, returning the pending promise.
   * Keeps each case to the one line that actually varies: the result shape.
   */
  function callWithResult(
    hooks: Hooks,
    window: JSDOM["window"],
    result: unknown,
  ): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posted: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = { postMessage: (message: any) => posted.push(message) };
    const bridge = hooks.createHostBridge(window, host);
    const pending = bridge.callTool("mcp__genie__validate", {}) as Promise<unknown>;
    window.dispatchEvent(
      new window.MessageEvent("message", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: host as any,
        data: { jsonrpc: "2.0", id: posted.at(-1).id, result },
      }),
    );
    // The listener is synchronous, so the promise has already settled; tearing the
    // bridge down here cannot reject an already-settled request.
    bridge.destroy();
    return pending;
  }

  it("resolves a text-only result — the live kit-wide validate payload from #251", async () => {
    // Verbatim from the issue's live stdio capture: `hasStructured:false`, the
    // real payload sitting unreachable in `content[0].text`. Tools that declare
    // no `outputSchema` are spec-correct in omitting `structuredContent`, so the
    // bridge — not the server — is what has to give.
    const payload = {
      markerMissing: ["index.html"],
      thin: ["kits/acme/components/StatusPill.html"],
      total: 2,
      bad: 2,
    };
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
    ).resolves.toEqual(payload);
  });

  it("prefers structuredContent when a result carries both", async () => {
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, {
        structuredContent: { from: "structured" },
        content: [{ type: "text", text: JSON.stringify({ from: "text" }) }],
      }),
    ).resolves.toEqual({ from: "structured" });
  });

  it("skips non-text, unparseable, and primitive entries and takes the first usable object", async () => {
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, {
        content: [
          { type: "image", data: "…" },
          { type: "text", text: "not json at all" },
          // Valid JSON, but a primitive — scanning must continue past it rather
          // than surface a number as the payload.
          { type: "text", text: "42" },
          { type: "text", text: JSON.stringify({ ok: true }) },
          { type: "text", text: JSON.stringify({ later: true }) },
        ],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects when the only text parses to a primitive rather than a payload", async () => {
    // `42` is valid JSON but no tool payload; resolving it would hand callers a
    // number where they destructure fields.
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, { content: [{ type: "text", text: "42" }] }),
    ).rejects.toThrow("malformed");
  });

  it("rejects when no content entry yields JSON", async () => {
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, { content: [{ type: "text", text: "Kit written." }] }),
    ).rejects.toThrow("malformed");
  });

  it("still rejects an isError result whose text parses cleanly", async () => {
    // The fallback runs after the error branch, so a well-formed error payload
    // must not be resurrected into a success.
    const { hooks, window } = loadHooks();
    await expect(
      callWithResult(hooks, window, {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ message: "Kit not found" }) }],
      }),
    ).rejects.toThrow("Kit not found");
  });
});
