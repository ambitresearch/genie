/**
 * M7-03 (#235) — Review → Refine → Approve → Apply workflow.
 *
 * These tests are the executable form of the issue's acceptance criteria. The
 * headline safety rule they exist to enforce is AC12: **only an explicit,
 * confirmed Apply may reach `plan`/`write_files`**. Generate, Refine, Approve,
 * Request Changes, deterministic tweaks and navigation must produce exactly
 * zero write calls.
 *
 * Structure mirrors the other viewer suites: pure helpers are exercised through
 * `window.__genieViewerTestHooks` with no DOM, and the wired controller is
 * driven against the real `index.html` shell with a fake host bridge.
 */
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

function loadHooks(): Hooks {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url: "https://viewer.example.test/?route=review",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dom.window as any).__genieViewerTestHooks = {};
  dom.window.eval(VIEWER_JS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (dom.window as any).__genieViewerTestHooks as Hooks;
}

function loadShell() {
  const dom = new JSDOM(VIEWER_HTML, {
    runScripts: "outside-only",
    url: "https://viewer.example.test/?route=review",
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

const MARKER = '<!-- @genie group="actions" viewport="400x200" -->';

function fileEntry(path: string, content: string) {
  return { path, content, mimeType: "text/html", encoding: "utf-8" as const };
}

/** A minimal, schema-valid conjure/refine payload for `Button`. */
function conjureResult(overrides: Record<string, unknown> = {}) {
  return {
    componentName: "Button",
    group: "actions",
    files: [fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`)],
    manifestEntry: { viewport: { width: 400, height: 200 } },
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    ...overrides,
  };
}

function refineResult(overrides: Record<string, unknown> = {}) {
  return {
    ...conjureResult(),
    diff: [
      "diff --git a/components/actions/Button/Button.html b/components/actions/Button/Button.html",
      "--- a/components/actions/Button/Button.html",
      "+++ b/components/actions/Button/Button.html",
      "@@ -1,2 +1,3 @@",
      ` ${MARKER}`,
      "-<button>Old</button>",
      "+<button>Go</button>",
      "+<span>new</span>",
      "",
    ].join("\n"),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* AC5 — refine payload validation (fail closed, mirrors isConjureResult) */
/* ------------------------------------------------------------------ */

describe("isRefineResult", () => {
  it("accepts a well-formed refine payload (conjure shape plus diff)", () => {
    const { isRefineResult } = loadHooks();
    expect(isRefineResult(refineResult())).toBe(true);
  });

  it("rejects a payload missing the diff", () => {
    const { isRefineResult } = loadHooks();
    expect(isRefineResult(conjureResult())).toBe(false);
  });

  it("rejects a non-string diff, but not an empty one", () => {
    const { isRefineResult } = loadHooks();
    expect(isRefineResult(refineResult({ diff: 42 }))).toBe(false);
    // This assertion used to demand `false`, which encoded a real defect: the
    // server's `buildUnifiedDiff` returns "" for a byte-identical refine, so
    // rejecting it mislabelled a truthful no-op as an unverifiable host reply.
    expect(isRefineResult(refineResult({ diff: "" }))).toBe(true);
  });

  it("rejects extra keys beyond the canonical shape", () => {
    const { isRefineResult } = loadHooks();
    expect(isRefineResult({ ...refineResult(), surprise: true })).toBe(false);
  });

  it("still enforces the nested conjure schema", () => {
    const { isRefineResult } = loadHooks();
    // lowercase component name — right shape, wrong content
    expect(isRefineResult(refineResult({ componentName: "button" }))).toBe(false);
    // no self-consistent <Name>/<Name>.html preview
    expect(
      isRefineResult(
        refineResult({ files: [fileEntry("components/actions/Button/Other.html", MARKER)] }),
      ),
    ).toBe(false);
  });

  it("rejects non-objects without throwing", () => {
    const { isRefineResult } = loadHooks();
    for (const value of [null, undefined, "x", 3, [], true]) {
      expect(isRefineResult(value)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC5 — real diff statistics, never a cosmetic placeholder            */
/* ------------------------------------------------------------------ */

describe("parseUnifiedDiff", () => {
  it("counts real additions and deletions", () => {
    const { parseUnifiedDiff } = loadHooks();
    const stats = parseUnifiedDiff(refineResult().diff);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  it("does not count +++/--- file headers as changed lines", () => {
    const { parseUnifiedDiff } = loadHooks();
    const stats = parseUnifiedDiff(
      ["--- a/x.html", "+++ b/x.html", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    );
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("collects the set of touched files", () => {
    const { parseUnifiedDiff } = loadHooks();
    const stats = parseUnifiedDiff(
      [
        "diff --git a/components/actions/Button/Button.html b/components/actions/Button/Button.html",
        "+++ b/components/actions/Button/Button.html",
        "+a",
        "diff --git a/components/actions/Button/Button.css b/components/actions/Button/Button.css",
        "+++ b/components/actions/Button/Button.css",
        "+b",
      ].join("\n"),
    );
    expect(stats.files).toEqual([
      "components/actions/Button/Button.html",
      "components/actions/Button/Button.css",
    ]);
    expect(stats.additions).toBe(2);
  });

  it("returns a zeroed, non-throwing result for absent or unusable input", () => {
    const { parseUnifiedDiff } = loadHooks();
    for (const value of [undefined, null, "", 5, {}]) {
      expect(parseUnifiedDiff(value)).toEqual({ additions: 0, deletions: 0, files: [] });
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC5 — checklist reflects real validator/file results                */
/* ------------------------------------------------------------------ */

function checkById(list: Array<{ id: string }>, id: string) {
  return list.find((entry) => entry.id === id);
}

describe("computeChecklist", () => {
  it("passes the automated checks for a valid draft", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({ result: conjureResult(), renderState: "pass" });
    expect(checkById(list, "marker")!.state).toBe("pass");
    expect(checkById(list, "preview-file")!.state).toBe("pass");
    expect(checkById(list, "containment")!.state).toBe("pass");
    expect(checkById(list, "schema")!.state).toBe("pass");
    expect(checkById(list, "csp")!.state).toBe("pass");
    expect(checkById(list, "render")!.state).toBe("pass");
  });

  it("fails the marker check when the @genie first line is missing", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({
      result: conjureResult({
        files: [fileEntry("components/actions/Button/Button.html", "<button>Go</button>")],
      }),
      renderState: "pass",
    });
    expect(checkById(list, "marker")!.state).toBe("fail");
  });

  it("fails the CSP check for remote subresources, web fonts and inline script", () => {
    const { computeChecklist } = loadHooks();
    const hostile = [
      `${MARKER}\n<img src="https://evil.example/x.png">`,
      `${MARKER}\n<style>@font-face{src:url(https://f.example/a.woff2)}</style>`,
      `${MARKER}\n<script>alert(1)</script>`,
    ];
    for (const content of hostile) {
      const list = computeChecklist({
        result: conjureResult({
          files: [fileEntry("components/actions/Button/Button.html", content)],
        }),
        renderState: "pass",
      });
      expect(checkById(list, "csp")!.state).toBe("fail");
    }
  });

  it("keeps the kit-wide validation check deferred and never green before a write", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({ result: conjureResult(), renderState: "pass" });
    const kitScan = checkById(list, "kit-validate")!;
    expect(kitScan.kind).toBe("deferred");
    expect(kitScan.state).toBe("pending");
  });

  it("reports a pending render as pending, not as a pass", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({ result: conjureResult(), renderState: "pending" });
    expect(checkById(list, "render")!.state).toBe("pending");
    // AC5: a partial run must never look fully green.
    expect(list.every((entry: { state: string }) => entry.state === "pass")).toBe(false);
  });

  it("marks a failed render as a failure", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({ result: conjureResult(), renderState: "fail" });
    expect(checkById(list, "render")!.state).toBe("fail");
  });

  it("surfaces manual checks that require explicit acknowledgement", () => {
    const { computeChecklist } = loadHooks();
    const list = computeChecklist({ result: conjureResult(), renderState: "pass" });
    const manual = list.filter((entry: { kind: string }) => entry.kind === "manual");
    expect(manual.length).toBeGreaterThan(0);
    expect(manual.every((entry: { state: string }) => entry.state === "pending")).toBe(true);
  });

  it("marks acknowledged manual checks as passing", () => {
    const { computeChecklist } = loadHooks();
    const base = computeChecklist({ result: conjureResult(), renderState: "pass" });
    const manualId = base.filter((entry: { kind: string }) => entry.kind === "manual")[0].id;
    const list = computeChecklist({
      result: conjureResult(),
      renderState: "pass",
      manualAcks: { [manualId]: true },
    });
    expect(checkById(list, manualId)!.state).toBe("pass");
  });

  it("returns an empty list when there is no draft", () => {
    const { computeChecklist } = loadHooks();
    expect(computeChecklist({ result: null, renderState: "pending" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* AC3/AC9 — draft immutability and approval invalidation              */
/* ------------------------------------------------------------------ */

describe("createReviewStore", () => {
  it("numbers drafts monotonically and retains prior drafts", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    const first = store.addDraft(conjureResult(), "generate");
    const second = store.addDraft(refineResult(), "refine");
    expect(first.label).toBe("draft #1");
    expect(second.label).toBe("draft #2");
    expect(store.state().drafts).toHaveLength(2);
    expect(store.state().drafts[0].result).toEqual(conjureResult());
  });

  it("does not mutate an existing draft when a new one arrives", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    const first = store.addDraft(conjureResult(), "generate");
    const snapshot = JSON.stringify(first.result);
    store.addDraft(refineResult(), "refine");
    expect(JSON.stringify(store.state().drafts[0].result)).toBe(snapshot);
  });

  it("records approval against the current draft only", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    expect(store.isApproved()).toBe(true);
    expect(store.state().decision).toBe("approved");
  });

  it("invalidates approval when a new draft arrives", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    store.addDraft(refineResult(), "refine");
    expect(store.isApproved()).toBe(false);
    expect(store.state().decision).toBe("none");
  });

  it("invalidates approval when the selected draft changes", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.addDraft(refineResult(), "refine");
    store.approve();
    store.select(1);
    expect(store.isApproved()).toBe(false);
  });

  it("invalidates approval when a manual acknowledgement is withdrawn", () => {
    const { createReviewStore, computeChecklist } = loadHooks();
    const store = createReviewStore();
    store.addDraft(conjureResult(), "generate");
    const manualId = computeChecklist({ result: conjureResult(), renderState: "pass" }).filter(
      (entry: { kind: string }) => entry.kind === "manual",
    )[0].id;
    store.acknowledge(manualId, true);
    store.approve();
    store.acknowledge(manualId, false);
    expect(store.isApproved()).toBe(false);
  });

  it("records Request Changes without mutating the draft or approving it", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    const draft = store.addDraft(conjureResult(), "generate");
    const snapshot = JSON.stringify(draft.result);
    store.requestChanges();
    expect(store.state().decision).toBe("changes-requested");
    expect(store.isApproved()).toBe(false);
    expect(store.state().drafts).toHaveLength(1);
    expect(JSON.stringify(store.state().drafts[0].result)).toBe(snapshot);
  });

  it("clears all drafts and decisions when the kit selection changes", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    store.reset();
    expect(store.state().drafts).toHaveLength(0);
    expect(store.current()).toBeNull();
    expect(store.isApproved()).toBe(false);
  });

  it("tracks applied drafts so an applied draft is not re-applied", () => {
    const { createReviewStore } = loadHooks();
    const store = createReviewStore();
    const draft = store.addDraft(conjureResult(), "generate");
    store.approve();
    store.markApplied(["components/actions/Button/Button.html"]);
    expect(store.state().appliedDraftId).toBe(draft.id);
    expect(store.state().writtenPaths).toEqual(["components/actions/Button/Button.html"]);
  });
});

/* ------------------------------------------------------------------ */
/* AC10 — the Apply gate names every blocker                           */
/* ------------------------------------------------------------------ */

function greenChecklist(hooks: Hooks) {
  const list = hooks.computeChecklist({ result: conjureResult(), renderState: "pass" });
  const acks: Record<string, boolean> = {};
  for (const entry of list as Array<{ id: string; kind: string }>) {
    if (entry.kind === "manual") acks[entry.id] = true;
  }
  return hooks.computeChecklist({
    result: conjureResult(),
    renderState: "pass",
    manualAcks: acks,
  });
}

describe("computeApplyGate", () => {
  it("enables Apply only when every precondition holds", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it("blocks with a named reason when there is no draft", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: [],
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.join(" ")).toMatch(/draft/i);
  });

  it("blocks an unapproved draft", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.join(" ")).toMatch(/approve/i);
  });

  it("blocks on a failing automated check and names it", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const checklist = hooks.computeChecklist({ result: conjureResult(), renderState: "fail" });
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist,
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.join(" ")).toMatch(/render/i);
  });

  it("blocks on unacknowledged manual checks", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: hooks.computeChecklist({ result: conjureResult(), renderState: "pass" }),
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.length).toBeGreaterThan(0);
  });

  it("does not treat the deferred kit scan as a blocker", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.blockers.join(" ")).not.toMatch(/kit-wide|full scan/i);
  });

  it("blocks when the host cannot write (standalone is read-only)", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: false,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.join(" ")).toMatch(/host/i);
  });

  it("blocks a second apply while one is in flight", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: true,
      inFlight: true,
    });
    expect(gate.enabled).toBe(false);
  });

  it("blocks re-applying an already applied draft", () => {
    const hooks = loadHooks();
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();
    store.markApplied(["components/actions/Button/Button.html"]);
    const gate = hooks.computeApplyGate({
      state: store.state(),
      checklist: greenChecklist(hooks),
      hostCanWrite: true,
      inFlight: false,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.blockers.join(" ")).toMatch(/already applied/i);
  });
});

/* ------------------------------------------------------------------ */
/* AC6/AC7 — refine availability                                       */
/* ------------------------------------------------------------------ */

describe("canRefine", () => {
  it("enables refine for a component that exists in the kit", () => {
    const { canRefine } = loadHooks();
    expect(
      canRefine({ hostAvailable: true, componentInKit: true, inFlight: false, instruction: "x" })
        .enabled,
    ).toBe(true);
  });

  it("disables refine in standalone and explains why", () => {
    const { canRefine } = loadHooks();
    const gate = canRefine({
      hostAvailable: false,
      componentInKit: true,
      inFlight: false,
      instruction: "x",
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/MCP-capable host/i);
  });

  it("disables refine for an unapplied draft and says to apply first", () => {
    const { canRefine } = loadHooks();
    const gate = canRefine({
      hostAvailable: true,
      componentInKit: false,
      inFlight: false,
      instruction: "x",
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/apply this draft first/i);
  });

  it("disables refine while a refine is in flight and with an empty instruction", () => {
    const { canRefine } = loadHooks();
    expect(
      canRefine({ hostAvailable: true, componentInKit: true, inFlight: true, instruction: "x" })
        .enabled,
    ).toBe(false);
    expect(
      canRefine({ hostAvailable: true, componentInKit: true, inFlight: false, instruction: "  " })
        .enabled,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* AC12 — exact plan/write_files argument construction                 */
/* ------------------------------------------------------------------ */

describe("buildPlanArgs / buildWriteFilesArgs", () => {
  it("scopes the plan to exactly the draft's paths", () => {
    const { buildPlanArgs } = loadHooks();
    const result = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", MARKER),
        fileEntry("components/actions/Button/Button.css", ".a{}"),
      ],
    });
    expect(buildPlanArgs({ result }, "my-kit")).toEqual({
      kitId: "my-kit",
      writes: ["components/actions/Button/Button.html", "components/actions/Button/Button.css"],
    });
  });

  it("maps refine/conjure file entries onto the write_files input shape", () => {
    const { buildWriteFilesArgs } = loadHooks();
    const result = conjureResult();
    expect(buildWriteFilesArgs("plan-123", { result })).toEqual({
      planId: "plan-123",
      files: [
        {
          path: "components/actions/Button/Button.html",
          data: `${MARKER}\n<button>Go</button>\n`,
          mimeType: "text/html",
          encoding: "utf-8",
        },
      ],
    });
  });

  it("never emits a localPath alongside data", () => {
    const { buildWriteFilesArgs } = loadHooks();
    const args = buildWriteFilesArgs("plan-123", { result: conjureResult() });
    for (const file of args.files) {
      expect(file).not.toHaveProperty("localPath");
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC8 — deterministic controls are capability-detected, never faked   */
/* ------------------------------------------------------------------ */

describe("deterministic controls", () => {
  it("reports no controls for a component that declares none", () => {
    const { detectDeterministicControls } = loadHooks();
    expect(detectDeterministicControls(conjureResult().files)).toEqual([]);
  });

  it("detects a declared, token-backed custom property", () => {
    const { detectDeterministicControls } = loadHooks();
    const files = [
      fileEntry("components/actions/Button/Button.html", MARKER),
      {
        ...fileEntry("components/actions/Button/Button.css", ":root{--radius:8px;}"),
        mimeType: "text/css",
      },
    ];
    const controls = detectDeterministicControls(files);
    expect(controls.map((control: { property: string }) => control.property)).toContain("--radius");
  });

  it("ignores custom properties outside the safe allowlist", () => {
    const { detectDeterministicControls } = loadHooks();
    const files = [
      fileEntry("components/actions/Button/Button.html", MARKER),
      {
        ...fileEntry("components/actions/Button/Button.css", ":root{--evil-url:url(x);}"),
        mimeType: "text/css",
      },
    ];
    expect(detectDeterministicControls(files)).toEqual([]);
  });

  it("applies a tweak locally by rewriting only the declared value", () => {
    const { detectDeterministicControls, applyDeterministicTweak } = loadHooks();
    const result = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", MARKER),
        {
          ...fileEntry("components/actions/Button/Button.css", ":root{--radius:8px;}"),
          mimeType: "text/css",
        },
      ],
    });
    const control = detectDeterministicControls(result.files)[0];
    const next = applyDeterministicTweak(result, control.id, 12);
    expect(next.files[1].content).toContain("--radius:12px");
    // original untouched — drafts are immutable
    expect(result.files[1].content).toContain("--radius:8px");
  });

  it("rejects a value outside the control's declared bounds", () => {
    const { detectDeterministicControls, applyDeterministicTweak } = loadHooks();
    const result = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", MARKER),
        {
          ...fileEntry("components/actions/Button/Button.css", ":root{--radius:8px;}"),
          mimeType: "text/css",
        },
      ],
    });
    const control = detectDeterministicControls(result.files)[0];
    expect(applyDeterministicTweak(result, control.id, 99999)).toBeNull();
    expect(applyDeterministicTweak(result, "no-such-control", 4)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* AC12 — tool-order contract against a fake host                      */
/* ------------------------------------------------------------------ */

type Call = { name: string; args: Record<string, unknown> };

function fakeBridge(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    bridge: {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const handler = handlers[name];
        if (!handler) throw new Error(`unexpected tool ${name}`);
        return handler(args);
      }),
    },
  };
}

function applyHandlers(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  return {
    mcp__genie__plan: () => ({ planId: "plan-1" }),
    mcp__genie__write_files: () => ({
      writtenPaths: ["components/actions/Button/Button.html"],
    }),
    mcp__genie__validate: () => ({
      markerMissing: [],
      thin: [],
      variantsIdentical: [],
      total: 1,
      bad: 0,
    }),
    ...overrides,
  };
}

describe("runApply — the only path that may write", () => {
  it("calls plan, then write_files with the returned planId, then validate", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge(applyHandlers());
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });

    expect(outcome.ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual([
      "mcp__genie__plan",
      "mcp__genie__write_files",
      "mcp__genie__validate",
    ]);
    expect(calls[0].args).toEqual({
      kitId: "my-kit",
      writes: ["components/actions/Button/Button.html"],
    });
    expect(calls[1].args).toMatchObject({ planId: "plan-1" });
    expect(outcome.writtenPaths).toEqual(["components/actions/Button/Button.html"]);
  });

  it("never writes when plan fails, and reports the real reason", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge(
      applyHandlers({
        mcp__genie__plan: () => {
          throw new Error("TooManyWritesError: 300 > 256");
        },
      }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/TooManyWrites/);
    expect(calls.map((call) => call.name)).toEqual(["mcp__genie__plan"]);
  });

  it("reports a failed write without claiming success", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge(
      applyHandlers({
        mcp__genie__write_files: () => {
          throw new Error("plan expired");
        },
      }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/expired/i);
    expect(calls.map((call) => call.name)).not.toContain("mcp__genie__validate");
  });

  it("rejects a malformed plan reply rather than writing with a bogus planId", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge(
      applyHandlers({ mcp__genie__plan: () => ({ nope: true }) }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    expect(outcome.ok).toBe(false);
    expect(calls.map((call) => call.name)).toEqual(["mcp__genie__plan"]);
  });

  it("treats a partial write as a failure and surfaces the written subset", async () => {
    const hooks = loadHooks();
    const result = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", MARKER),
        fileEntry("components/actions/Button/Button.css", ".a{}"),
      ],
    });
    const { bridge } = fakeBridge(
      applyHandlers({
        mcp__genie__write_files: () => ({
          writtenPaths: ["components/actions/Button/Button.html"],
        }),
      }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(result, "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/partial|incomplete/i);
    expect(outcome.writtenPaths).toEqual(["components/actions/Button/Button.html"]);
  });

  it("still reports success when the post-write kit scan surfaces advisory findings", async () => {
    const hooks = loadHooks();
    const { bridge } = fakeBridge(
      applyHandlers({
        mcp__genie__validate: () => ({
          markerMissing: ["components/actions/Other/Other.html"],
          thin: [],
          variantsIdentical: [],
          total: 2,
          bad: 1,
        }),
      }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.validation.bad).toBe(1);
  });

  it("does not fail the apply when the post-write scan itself errors", async () => {
    const hooks = loadHooks();
    const { bridge } = fakeBridge(
      applyHandlers({
        mcp__genie__validate: () => {
          throw new Error("ERR_FULLSCAN_UNAVAILABLE");
        },
      }),
    );
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    store.approve();

    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: true,
    });
    // The bytes are already on disk — reporting failure here would be a lie.
    expect(outcome.ok).toBe(true);
    expect(outcome.validation).toBeNull();
  });

  it("refuses to run for an unapproved draft", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge(applyHandlers());
    const store = hooks.createReviewStore();
    store.addDraft(conjureResult(), "generate");
    const outcome = await hooks.runApply({
      bridge,
      kitId: "my-kit",
      draft: store.current(),
      approved: false,
    });
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("runRefine", () => {
  it("sends exactly the refine contract's arguments", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge({
      mcp__genie__refine: () => refineResult(),
    });
    const outcome = await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "make it round",
      model: "gpt-4o-mini",
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("mcp__genie__refine");
    expect(calls[0].args).toEqual({
      kitId: "my-kit",
      componentName: "Button",
      instruction: "make it round",
      model: "gpt-4o-mini",
    });
  });

  it("includes the region only when one is supplied", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge({ mcp__genie__refine: () => refineResult() });
    await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "tighten this",
      model: "m",
      region: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(calls[0].args).toMatchObject({ region: { x: 1, y: 2, w: 3, h: 4 } });
  });

  it("rejects a malformed refine reply instead of accepting a bad draft", async () => {
    const hooks = loadHooks();
    const { bridge } = fakeBridge({
      mcp__genie__refine: () => ({ componentName: "Button" }),
    });
    const outcome = await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "x",
      model: "m",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toBeUndefined();
  });

  it("never calls a write tool", async () => {
    const hooks = loadHooks();
    const { calls, bridge } = fakeBridge({ mcp__genie__refine: () => refineResult() });
    await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "x",
      model: "m",
    });
    expect(calls.map((call) => call.name)).not.toContain("mcp__genie__plan");
    expect(calls.map((call) => call.name)).not.toContain("mcp__genie__write_files");
  });

  it("surfaces ERR_COMPONENT_NOT_FOUND verbatim enough to be actionable", async () => {
    const hooks = loadHooks();
    const { bridge } = fakeBridge({
      mcp__genie__refine: () => {
        throw new Error("ERR_COMPONENT_NOT_FOUND: Button is not in my-kit");
      },
    });
    const outcome = await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "x",
      model: "m",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/ERR_COMPONENT_NOT_FOUND/);
  });

  it("redacts secrets out of host error text", async () => {
    const hooks = loadHooks();
    const { bridge } = fakeBridge({
      mcp__genie__refine: () => {
        throw new Error("upstream rejected: Authorization: Bearer sk-live-abc123def456");
      },
    });
    const outcome = await hooks.runRefine({
      bridge,
      kitId: "my-kit",
      componentName: "Button",
      instruction: "x",
      model: "m",
    });
    expect(outcome.message).not.toMatch(/sk-live-abc123def456/);
    expect(outcome.message).toMatch(/redacted/);
  });
});

/* ------------------------------------------------------------------ */
/* AC1/AC2/AC19 — the wired Review view                                */
/* ------------------------------------------------------------------ */

describe("review view markup", () => {
  it("ships the three-pane structure with the required landmarks", () => {
    const { document } = loadShell();
    expect(document.getElementById("review-conversation")).not.toBeNull();
    expect(document.querySelector(".review-stage")).not.toBeNull();
    expect(document.getElementById("review-panel")).not.toBeNull();
    expect(document.getElementById("review-panel")!.getAttribute("aria-label")).toBeTruthy();
  });

  it("exposes the decision, refine and apply controls", () => {
    const { document } = loadShell();
    for (const id of [
      "refine-input",
      "refine-submit",
      "decision-approve",
      "decision-request-changes",
      "apply-button",
      "apply-blockers",
      "review-checklist",
      "review-diff-stats",
    ]) {
      expect(document.getElementById(id), `#${id} is missing`).not.toBeNull();
    }
  });

  it("keeps Apply disabled and the empty state visible with no draft", () => {
    const { document } = loadShell();
    expect((document.getElementById("apply-button") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("review-empty") as HTMLElement).hidden).toBe(false);
  });

  it("states plainly that nothing has been written to the kit yet", () => {
    const { document } = loadShell();
    const text = document.getElementById("review-view")!.textContent ?? "";
    expect(text).toMatch(/nothing has been written|not been written|held only/i);
  });

  it("carries a polite live region for status announcements", () => {
    const { document } = loadShell();
    const live = document.getElementById("review-live");
    expect(live).not.toBeNull();
    expect(live!.getAttribute("role")).toBe("status");
  });
});

/* ------------------------------------------------------------------ */
/* AC16/AC17 — untrusted content is rendered as data                   */
/* ------------------------------------------------------------------ */

describe("untrusted content handling", () => {
  it("renders a hostile diff as text, never as markup", () => {
    const { document, hooks } = loadShell();
    const target = document.getElementById("review-diff-files")!;
    hooks.renderDiffFiles(document, target, {
      additions: 1,
      deletions: 0,
      files: ['<img src=x onerror="alert(1)">'],
    });
    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toContain("<img");
  });

  it("renders hostile blocker text as data", () => {
    const { document, hooks } = loadShell();
    const target = document.getElementById("apply-blockers")!;
    hooks.renderBlockers(document, target, ["<script>alert(1)</script>"]);
    expect(target.querySelector("script")).toBeNull();
    expect(target.textContent).toContain("<script>");
  });
});

/* ------------------------------------------------------------------ */
/* AC1–AC20 — the WIRED controller, driven through the real markup     */
/*                                                                     */
/* Every test above exercises a pure helper in isolation, which is     */
/* exactly why four integration bugs survived a green suite: the       */
/* helpers agreed with the tests and disagreed with each other. These  */
/* tests boot `initReviewController` against `index.html` and drive it */
/* only through DOM events, so any drift between the store's           */
/* vocabulary and the renderer's is a failure here.                    */
/* ------------------------------------------------------------------ */

type ToolCall = { name: string; args: Record<string, unknown> };

/** Boot the real controller against the real markup with a recording bridge. */
function loadWired(replies: Record<string, unknown | ((args: never) => unknown)> = {}) {
  const shell = loadShell();
  const calls: ToolCall[] = [];
  const bridge = {
    callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const reply = replies[name];
      if (typeof reply === "function")
        return Promise.resolve((reply as (a: unknown) => unknown)(args));
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(reply ?? {});
    },
  };
  const announced: string[] = [];
  const controller = shell.hooks.initReviewController(shell.document, {
    getBridge: () => bridge,
    announce: (message: string) => announced.push(message),
  });
  return { ...shell, controller, calls, announced };
}

const PLAN_ID = "plan_01HX";

const HAPPY_REPLIES = {
  mcp__genie__plan: { planId: PLAN_ID },
  mcp__genie__write_files: { writtenPaths: ["components/actions/Button/Button.html"] },
  mcp__genie__validate: { markerMissing: 0, thin: 0, variantsIdentical: 0, total: 4, bad: 0 },
};

/**
 * jsdom never fetches an iframe `srcdoc`, so the render check would sit at
 * `pending` forever. Fire the `load` the browser would fire, on the frame the
 * controller actually created.
 */
function firePreviewLoad(document: Document) {
  const frame = document.querySelector("#review-preview iframe");
  if (!frame) throw new Error("no preview frame was rendered");
  frame.dispatchEvent(new document.defaultView!.Event("load"));
}

/** Drive the checklist to fully green: render pass + every manual box ticked. */
function makeGreen(document: Document, controller: { refresh: () => void }) {
  firePreviewLoad(document);
  controller.refresh();
  const boxes = document.querySelectorAll<HTMLInputElement>("[data-check-toggle]");
  for (const box of Array.from(boxes)) {
    box.checked = true;
    box.dispatchEvent(new document.defaultView!.Event("change", { bubbles: true }));
  }
}

describe("wired review controller", () => {
  function seed(replies = HAPPY_REPLIES) {
    const wired = loadWired(replies);
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "design-default",
      componentInKit: false,
    });
    return wired;
  }

  it("renders the draft, hides the empty state and reports it is unwritten", () => {
    const { document } = seed();
    expect((document.getElementById("review-empty") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("draft-review") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("draft-label")!.textContent).toMatch(/draft #1/i);
  });

  it("renders the automated checks green once the preview has rendered", () => {
    const { document, controller } = seed();
    // Simulate the iframe load path the controller wires up.
    firePreviewLoad(document);
    controller.refresh();
    const marker = document.querySelector('[data-check-id="marker"]');
    expect(marker!.className).toContain("check-item--pass");
    const render = document.querySelector('[data-check-id="render"]');
    // The store's vocabulary and the renderer's must be the same words.
    expect(render!.className).not.toContain("check-item--undefined");
  });

  it("keeps Apply disabled until the draft is explicitly approved", () => {
    const { document, controller } = seed();
    makeGreen(document, controller);
    const apply = document.getElementById("apply-button") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(document.getElementById("apply-blockers")!.textContent).toMatch(/approve/i);
  });

  it("opens Apply only after Approve, and only behind a confirmation dialog", () => {
    const { document, controller, calls } = seed();
    firePreviewLoad(document);
    makeGreen(document, controller);
    document
      .getElementById("decision-approve")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    const apply = document.getElementById("apply-button") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);

    apply.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    // Opening the dialog must not touch the kit.
    expect(calls).toHaveLength(0);
    expect((document.getElementById("apply-confirm") as HTMLElement).hidden).toBe(false);
  });

  it("takes the background out of the tab order while the dialog is modal", () => {
    const { document, controller } = seed();
    firePreviewLoad(document);
    makeGreen(document, controller);
    document
      .getElementById("decision-approve")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    document
      .getElementById("apply-button")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    const layout = document.getElementById("review-layout")!;
    expect(layout.hasAttribute("inert")).toBe(true);
    expect(layout.getAttribute("aria-hidden")).toBe("true");

    document
      .getElementById("apply-confirm-cancel")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    expect(layout.hasAttribute("inert")).toBe(false);
    expect(layout.hasAttribute("aria-hidden")).toBe(false);
  });

  it("writes through plan → write_files → validate and marks the draft applied", async () => {
    const wired = seed();
    const { document, controller, calls } = wired;
    firePreviewLoad(document);
    makeGreen(document, controller);
    document
      .getElementById("decision-approve")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    document
      .getElementById("apply-button")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    document
      .getElementById("apply-confirm-accept")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls.map((c) => c.name)).toEqual([
      "mcp__genie__plan",
      "mcp__genie__write_files",
      "mcp__genie__validate",
    ]);
    // The planId must be the server's, echoed verbatim.
    expect(calls[1].args.planId).toBe(PLAN_ID);
    // write_files takes `data`, not conjure's `content`.
    const files = calls[1].args.files as Array<Record<string, unknown>>;
    expect(files[0]).toHaveProperty("data");
    expect(files[0]).not.toHaveProperty("content");
    // validate is kit-scoped only.
    expect(calls[2].args).toEqual({ kitId: "my-kit" });

    await vi.waitFor(() => {
      expect(controller.state().appliedDraftId).toBe("draft-1");
    });
    const apply = document.getElementById("apply-button") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(document.getElementById("apply-blockers")!.textContent).toMatch(/already applied/i);
  });

  it("drops the approval when a manual check is un-acknowledged", () => {
    const { document, controller } = seed();
    firePreviewLoad(document);
    makeGreen(document, controller);
    document
      .getElementById("decision-approve")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    expect((document.getElementById("apply-button") as HTMLButtonElement).disabled).toBe(false);

    const box = document.querySelector<HTMLInputElement>("[data-check-toggle]")!;
    box.checked = false;
    box.dispatchEvent(new document.defaultView!.Event("change", { bubbles: true }));
    expect((document.getElementById("apply-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches between drafts through the switcher buttons", () => {
    const wired = seed();
    const { document, controller } = wired;
    controller.addDraft(conjureResult({ componentName: "Badge" }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "design-default",
      componentInKit: false,
    });
    expect(controller.state().currentNumber).toBe(2);

    const buttons = document.querySelectorAll<HTMLButtonElement>("#review-draft-switcher button");
    expect(buttons).toHaveLength(2);
    buttons[0].dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    // Selection is by draft *number*; a mismatch here means the switcher and
    // the store disagree about what identifies a draft.
    expect(controller.state().currentNumber).toBe(1);
    // `renderSwitcher` rebuilds the list, so re-query rather than reusing the
    // detached nodes.
    const after = document.querySelectorAll<HTMLButtonElement>("#review-draft-switcher button");
    expect(after[0].getAttribute("aria-pressed")).toBe("true");
    expect(after[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("refuses to refine a draft that is not yet in the kit, and says why", () => {
    const { document, calls } = seed();
    const input = document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it larger";
    input.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    const submit = document.getElementById("refine-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(document.getElementById("refine-status")!.textContent).toMatch(
      /apply this draft first/i,
    );
    submit.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    expect(calls).toHaveLength(0);
  });

  it("sends the model the draft was generated under when refining a kit component", async () => {
    const wired = loadWired({ mcp__genie__refine: refineResult() });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "design-default",
      componentInKit: true,
    });
    const { document, calls } = wired;
    const input = document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it larger";
    input.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    document
      .getElementById("refine-submit")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].name).toBe("mcp__genie__refine");
    // A model *label* here ("Configured model") would be rejected by the server.
    expect(calls[0].args.model).toBe("design-default");
    expect(calls[0].args).toEqual({
      kitId: "my-kit",
      componentName: "Button",
      instruction: "make it larger",
      model: "design-default",
    });
  });

  it("never writes when the plan step fails", async () => {
    const wired = seed({ ...HAPPY_REPLIES, mcp__genie__plan: new Error("kit is read-only") });
    const { document, controller, calls } = wired;
    firePreviewLoad(document);
    makeGreen(document, controller);
    document
      .getElementById("decision-approve")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    document
      .getElementById("apply-button")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    document
      .getElementById("apply-confirm-accept")!
      .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].name).toBe("mcp__genie__plan");
    await vi.waitFor(() => {
      expect(document.getElementById("review-status")!.textContent).toMatch(/read-only/i);
    });
    expect(controller.state().appliedDraftId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Renderer ⇄ CSS contracts                                            */
/*                                                                     */
/* These renderers put meaning into `textContent`. If CSS ever adds a  */
/* `::before` sign or glyph it would double up, so the contract is     */
/* pinned here rather than left to a visual review.                    */
/* ------------------------------------------------------------------ */

describe("renderer contracts", () => {
  it("writes the diff signs into text, not into a CSS pseudo-element", () => {
    const { document, hooks } = loadShell();
    const target = document.getElementById("review-diff-stats")!;
    hooks.renderDiffStats(document, target, { additions: 12, deletions: 3, files: ["a.html"] });
    expect(target.textContent).toContain("+12");
    expect(target.textContent).toContain("-3");
  });

  it("writes the checklist glyph into the icon span", () => {
    const { document, hooks } = loadShell();
    const target = document.getElementById("review-checklist")!;
    hooks.renderChecklist(document, target, [
      { id: "marker", label: "Marker present", kind: "auto", state: "pass", detail: "" },
      { id: "render", label: "Preview renders", kind: "auto", state: "fail", detail: "" },
      { id: "kit-validate", label: "Kit scan", kind: "deferred", state: "pending", detail: "" },
    ]);
    const icons = Array.from(
      target.querySelectorAll(".check-item__icon"),
      (node) => node.textContent,
    );
    expect(icons.every((glyph) => Boolean(glyph && glyph.trim()))).toBe(true);
    expect(target.querySelector('[data-check-id="marker"]')!.className).toContain(
      "check-item--pass",
    );
  });

  it("records where a draft came from so a reviewer can see its provenance", () => {
    const { document, hooks } = loadShell();
    const controller = hooks.initReviewController(document, {
      getBridge: () => null,
    });
    controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "design-default",
      componentInKit: true,
      source: "browse",
    });
    expect(document.getElementById("draft-summary")!.textContent).toContain("Browse");
  });
});

/**
 * Adversarial-review regressions (AGENTS.md §5).
 *
 * Every test above this line seeds the review workspace by calling
 * `controller.addDraft(...)` directly. That is a *fixture*, and it masked two
 * blocking integration failures: the code path that is supposed to create a
 * draft from a Browse selection never created one, and Apply never refreshed
 * anything. These tests deliberately drive the real entry points instead.
 */
const BROWSE_MANIFEST = {
  version: 1,
  name: "kit",
  generatedAt: "2026-07-01T00:00:00.000Z",
  groups: ["surfaces"],
  components: [
    {
      name: "Card",
      group: "surfaces",
      path: "components/surfaces/Card/preview.html",
      viewport: "480x320",
      hash: "sha256-BBB=",
      lastModified: "2026-07-01T00:00:00.000Z",
    },
  ],
};

const CARD_SOURCE = `${MARKER}\n<div class="card">Card from the kit</div>`;

/** Wire Browse to a real product shell exactly the way the boot paths do. */
function loadBrowseToReview(
  source: string | null,
  opts: { onApplied?: (applied: Record<string, unknown>) => unknown } = {},
  manifest: Record<string, unknown> = BROWSE_MANIFEST,
) {
  const shell = loadShell();
  const calls: string[] = [];
  const bridge = {
    callTool(name: string) {
      calls.push(name);
      if (name === "mcp__genie__read_file") {
        return Promise.resolve(source === null ? {} : { content: source, encoding: "utf-8" });
      }
      if (name === "mcp__genie__list_kits") return Promise.resolve({ kits: [] });
      return Promise.resolve({});
    },
    destroy() {},
  };
  // Embedded tier: Refine is only reachable through a real MCP host bridge,
  // so a standalone shell would make the "Refine is unlocked" assertion
  // vacuously false for the wrong reason.
  const shellController = shell.hooks.initProductShell(shell.document, bridge, opts);
  const browse = shell.hooks.initBrowseController(shell.document, {
    hostBridge: bridge,
    kitId: "kit-a",
    kitName: "kit",
    onRefine: (context: unknown) => shellController.setRefineContext(context),
  });
  browse.update(manifest);
  browse.setHostBridge(bridge);
  return { ...shell, browse, shellController, calls };
}

async function refineFromBrowse(shell: ReturnType<typeof loadBrowseToReview>) {
  const item = Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
    (el) => el.dataset.componentName === "Card",
  );
  item!.click();
  // The detail panel reads the component's source through the host bridge
  // before it can hand anything to Review; let that read settle first,
  // otherwise every case degrades to the no-source path and the test proves
  // nothing.
  await vi.waitFor(() => {
    expect(shell.document.querySelector<HTMLElement>("[data-refine-action]")).not.toBeNull();
    expect(shell.document.getElementById("browse-detail")!.textContent).not.toMatch(
      /Loading source/i,
    );
  });
  shell.document.querySelector<HTMLButtonElement>("[data-refine-action]")!.click();
}

describe("Browse → Review handoff (AC2 / S2)", () => {
  it("carries the component's real source through buildRefineContext", () => {
    const hooks = loadHooks();
    const context = hooks.buildRefineContext(
      "kit-a",
      { group: "surfaces", componentName: "Card" },
      "default",
      CARD_SOURCE,
    );
    expect(context.source).toBe(CARD_SOURCE);
    expect(context.path).toBe("components/surfaces/Card/Card.html");
  });

  it("treats a missing source as no source rather than an empty draft", () => {
    const hooks = loadHooks();
    expect(
      hooks.buildRefineContext("kit-a", { group: "surfaces", componentName: "Card" }, "default", "")
        .source,
    ).toBeNull();
    expect(
      hooks.buildRefineContext("kit-a", { group: "surfaces", componentName: "Card" }, "default")
        .source,
    ).toBeNull();
  });

  it("seeds a REAL reviewable draft, not a read-only metadata card", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);

    // The failure this pins: Review used to land on its EMPTY state with a
    // dead Refine pane, because nothing ever created a draft.
    expect((shell.document.getElementById("review-empty") as HTMLElement).hidden).toBe(true);
    expect((shell.document.getElementById("draft-review") as HTMLElement).hidden).toBe(false);
    expect(shell.document.getElementById("draft-label")!.textContent).toMatch(/draft #1/i);
  });

  it("renders a kit file whose name is not its folder's name", async () => {
    // The manifest compiler cards EVERY `.html` under `components/` and derives
    // `name` from the file's own basename (server `manifest/compiler.ts` —
    // `walkPreviewFiles` + `deriveName`), so `Button/preview.html` is a
    // legitimate kit entry point that can never satisfy the canonical
    // `<Name>/<Name>.html` form.
    //
    // Before Copilot #2 the Browse handoff fabricated a canonical path, which
    // hid this. Now that the real path flows through, a preview pane that only
    // understood the canonical form would go blank on a perfectly valid kit.
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const frame = shell.document.querySelector("#review-preview iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("srcdoc")).toContain("Card from the kit");
    // ...and the CONVENTION check still reports the truth about that file
    // rather than being relaxed to make the render work.
    expect(shell.document.querySelector('[data-check-id="preview-file"]')!.className).toContain(
      "check-item--fail",
    );
  });

  it("uses the kit's bytes as the review baseline so the checklist can run", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const frame = shell.document.querySelector("#review-preview iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("srcdoc")).toContain("Card from the kit");
    expect(shell.document.querySelector('[data-check-id="marker"]')!.className).toContain(
      "check-item--pass",
    );
  });

  it("unlocks Refine, because a component opened from Browse IS in the kit", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const input = shell.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "Tighten the padding";
    input.dispatchEvent(new shell.window.Event("input", { bubbles: true }));
    // `refine` loads its source from the kit, so this is the one case where a
    // brand-new review draft may be refined without applying first.
    expect((shell.document.getElementById("refine-submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("falls back to a truthful message — never 'next milestone' — when the source is unavailable", async () => {
    const shell = loadBrowseToReview(null);
    await refineFromBrowse(shell);
    expect((shell.document.getElementById("review-empty") as HTMLElement).hidden).toBe(false);
    const copy = `${shell.document.getElementById("review-empty-heading")!.textContent} ${
      shell.document.getElementById("review-empty-detail")!.textContent
    }`;
    // M7-03 IS the milestone that ships Refine and Apply; promising them
    // later would be a lie.
    expect(copy).not.toMatch(/next workflow milestone/i);
    expect(copy).toMatch(/could not read|could not open/i);
  });
});

describe("post-apply refresh (AC13 / AC14)", () => {
  function seedApplied(onApplied?: (applied: Record<string, unknown>) => unknown) {
    const wired = loadWired(HAPPY_REPLIES);
    const calls: Array<Record<string, unknown>> = [];
    const controller = wired.hooks.initReviewController(wired.document, {
      getBridge: () => ({
        callTool(name: string, args: Record<string, unknown>) {
          wired.calls.push({ name, args });
          const reply = (HAPPY_REPLIES as Record<string, unknown>)[name];
          return Promise.resolve(reply ?? {});
        },
      }),
      announce: (message: string) => wired.announced.push(message),
      onApplied: (applied: Record<string, unknown>) => {
        calls.push(applied);
        return onApplied ? onApplied(applied) : undefined;
      },
    });
    controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "design-default",
      componentInKit: false,
    });
    return { ...wired, controller, appliedCalls: calls };
  }

  async function applyIt(shell: ReturnType<typeof seedApplied>) {
    makeGreen(shell.document, shell.controller);
    (shell.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (shell.document.getElementById("apply-button") as HTMLButtonElement).click();
    (shell.document.getElementById("apply-confirm-accept") as HTMLButtonElement).click();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }

  it("refreshes the kit after the write, naming the component that was applied", async () => {
    const shell = seedApplied();
    await applyIt(shell);
    expect(shell.appliedCalls).toHaveLength(1);
    expect(shell.appliedCalls[0]).toMatchObject({
      kitId: "my-kit",
      group: "actions",
      componentName: "Button",
    });
    expect(shell.appliedCalls[0].writtenPaths).toEqual(["components/actions/Button/Button.html"]);
  });

  it("refreshes only after the write actually landed", async () => {
    const order: string[] = [];
    const shell = seedApplied(() => {
      order.push("refresh");
    });
    const originalPush = shell.calls.push.bind(shell.calls);
    shell.calls.push = ((call: { name: string }) => {
      if (call.name === "mcp__genie__write_files") order.push("write");
      return originalPush(call);
    }) as typeof shell.calls.push;
    await applyIt(shell);
    expect(order).toEqual(["write", "refresh"]);
  });

  it("stays truthful when the refresh fails: the bytes ARE written", async () => {
    const shell = seedApplied(() => Promise.reject(new Error("manifest unreachable")));
    await applyIt(shell);
    const status = shell.document.getElementById("review-status")!.textContent ?? "";
    // Not a false success…
    expect(status).toMatch(/could not be refreshed|reload/i);
    // …but not a bogus failure either: a second Apply would be pointless.
    expect(status).toMatch(/applied/i);
    expect(shell.document.getElementById("apply-blockers")!.textContent).toMatch(
      /already applied/i,
    );
  });
});

describe("in-flight refine is invalidated by switching drafts", () => {
  it("discards a late refine response aimed at the draft you navigated away from", async () => {
    let release: ((value: unknown) => void) | null = null;
    const wired = loadWired({
      mcp__genie__refine: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
    });
    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it bigger";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();

    // Navigate to a different draft while the first refine is still in flight.
    wired.controller.addDraft(conjureResult({ componentName: "Card", group: "surfaces" }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
    });
    const options = wired.document.querySelectorAll<HTMLButtonElement>(
      ".review-draft-switcher__option",
    );
    options[0].click();

    const before = wired.document.querySelectorAll(".review-draft-switcher__option").length;
    release!(refineResult());
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    // The stale reply must not append itself as a successor draft.
    expect(wired.document.querySelectorAll(".review-draft-switcher__option").length).toBe(before);
  });
});

describe("segmented pane control is keyboard operable (AC19)", () => {
  function segments(document: Document) {
    return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-review-pane]"));
  }

  it("moves selection AND focus with the arrow keys", () => {
    const { document, controller } = (() => {
      const wired = loadWired(HAPPY_REPLIES);
      wired.controller.addDraft(conjureResult(), {
        kitId: "k",
        kitLabel: "K",
        model: "m",
        componentInKit: false,
      });
      return wired;
    })();
    expect(controller).toBeTruthy();
    const tabs = segments(document);
    expect(tabs.length).toBeGreaterThan(1);
    tabs[0].focus();

    tabs[0].dispatchEvent(
      new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    // A roving tabindex makes the group ONE Tab stop, so selection without
    // focus would strand the keyboard user on an invisible control.
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].tabIndex).toBe(0);
    expect(tabs[0].tabIndex).toBe(-1);
  });

  it("wraps at both ends and supports Home/End", () => {
    const wired = loadWired(HAPPY_REPLIES);
    const tabs = segments(wired.document);
    const key = (el: HTMLElement, k: string) =>
      el.dispatchEvent(new wired.window.KeyboardEvent("keydown", { key: k, bubbles: true }));

    key(tabs[0], "ArrowLeft");
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    key(tabs[tabs.length - 1], "ArrowRight");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    key(tabs[0], "End");
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    key(tabs[tabs.length - 1], "Home");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Copilot review of PR #250. Ten findings, all verified against source and
// against the server's own schemas before being accepted. Each one is pinned
// here so the fix cannot silently regress.
// ───────────────────────────────────────────────────────────────────────────
describe("PR #250 review findings", () => {
  // #1 — `refine`'s server schema is `model: z.string().min(1).default(...)`
  // (packages/server/src/tools/refine.ts:137). An empty string is NOT the
  // same as an omitted field: `""` fails `.min(1)` and the call is rejected
  // before it reaches a model, whereas omitting it lets the default apply.
  // A Browse-seeded draft has no model selection, so it must omit the key.
  it("omits `model` entirely rather than sending an empty string", async () => {
    const wired = loadWired({ ...HAPPY_REPLIES, mcp__genie__refine: refineResult() });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: true,
      model: "",
    });
    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "tighten the padding";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__refine")).toBe(true);
    });
    const args = wired.calls.find((c) => c.name === "mcp__genie__refine")!.args;
    expect(Object.prototype.hasOwnProperty.call(args, "model")).toBe(false);
  });

  it("still forwards a real model when one was selected", async () => {
    const wired = loadWired({ ...HAPPY_REPLIES, mcp__genie__refine: refineResult() });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: true,
      model: "claude-x",
    });
    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "tighten the padding";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__refine")).toBe(true);
    });
    expect(wired.calls.find((c) => c.name === "mcp__genie__refine")!.args.model).toBe("claude-x");
  });

  // #2 — Browse reads bytes from `sourcePath || path`. Fabricating a
  // canonical path means Review can plan a write to a DIFFERENT file than the
  // one whose bytes it is showing.
  it("carries the path Browse actually read, not a fabricated canonical one", () => {
    const { buildRefineContext } = loadHooks();
    const context = buildRefineContext(
      "kit-a",
      { group: "surfaces", componentName: "Card", path: "components/surfaces/Card/preview.html" },
      "default",
      "<div>card</div>",
    );
    expect(context.path).toBe("components/surfaces/Card/preview.html");
  });

  it("prefers sourcePath over the iframe transport path", () => {
    const { buildRefineContext } = loadHooks();
    const context = buildRefineContext(
      "kit-a",
      {
        group: "surfaces",
        componentName: "Card",
        path: "https://cdn.example.test/transport/Card.html",
        sourcePath: "components/surfaces/Card/Card.html",
      },
      "default",
      "<div>card</div>",
    );
    expect(context.path).toBe("components/surfaces/Card/Card.html");
  });

  // #3 — AC7 requires the failure reason to stay actionable. `render()`
  // recomputes an ENABLED refine gate (the instruction is preserved by
  // design) and blanks the status line, erasing the message set just above.
  it("keeps a refine failure reason visible after the re-render", async () => {
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__refine: new Error("upstream model refused the request"),
    });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: true,
      model: "m",
    });
    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it red";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.announced.join(" ")).toMatch(/refused|failed/i);
    });
    expect(wired.document.getElementById("refine-status")!.textContent).toMatch(/refused|failed/i);
  });

  // #4 — `refine` returns PROPOSED files; it does not persist them. Carrying
  // `componentInKit: true` onto the refined draft re-opens the Refine gate,
  // and the next call reloads the OLDER on-disk component — silently dropping
  // the first refinement.
  it("marks a refined draft as not yet in the kit", async () => {
    const wired = loadWired({ ...HAPPY_REPLIES, mcp__genie__refine: refineResult() });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: true,
      model: "m",
    });
    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it red";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.document.getElementById("draft-label")!.textContent).toMatch(/#2/);
    });
    input.value = "again";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    expect((wired.document.getElementById("refine-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(wired.document.getElementById("refine-status")!.textContent).toMatch(
      /apply this draft first/i,
    );
  });

  // #5 — AC8 promises deterministic controls recompute the REAL diff. Copying
  // the parent's `diff` shows either nothing (tweak on a generated draft) or
  // stale stats from the previous model edit.
  it("recomputes the diff for a deterministic tweak", () => {
    const { applyDeterministicTweak, detectDeterministicControls, parseUnifiedDiff } = loadHooks();
    // A parent carrying a STALE diff is the dangerous case: silently
    // inheriting it reports the previous model edit as this draft's change.
    const base = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", MARKER),
        {
          ...fileEntry("components/actions/Button/Button.css", ":root{--radius:8px;}"),
          mimeType: "text/css",
        },
      ],
    });
    base.diff = "diff --git a/stale.css b/stale.css\n--- a/stale.css\n+++ b/stale.css\n+stale\n";
    const control = detectDeterministicControls(base.files)[0];
    expect(control).toBeTruthy();
    const tweaked = applyDeterministicTweak(base, control.id, 12);
    expect(typeof tweaked.diff).toBe("string");
    expect(tweaked.diff).not.toMatch(/stale/);
    const stats = parseUnifiedDiff(tweaked.diff);
    expect(stats.additions).toBeGreaterThan(0);
    expect(stats.deletions).toBeGreaterThan(0);
    expect(stats.files).toEqual(["components/actions/Button/Button.css"]);
    expect(tweaked.diff).toMatch(/\+.*--radius:12px/);
    expect(tweaked.diff).toMatch(/-.*--radius:8px/);
    // The parent draft is immutable: its own diff must survive untouched.
    expect(base.diff).toMatch(/stale/);
  });

  // #6 — Compiled manifest entries key the component as `name`
  // (packages/server/src/store/manifest.ts:37). Reading `componentName` off a
  // RAW manifest entry never matches, and synthesising one with the wrong key
  // projects a tree item with an undefined name.
  it("matches and synthesises raw manifest entries by `name`", async () => {
    const shell = loadShell();
    const browse = shell.hooks.initBrowseController(shell.document, {
      kitId: "kit-a",
      kitName: "kit",
    });
    browse.update({
      version: 1,
      name: "kit",
      generatedAt: "2026-07-01T00:00:00.000Z",
      groups: ["surfaces"],
      components: [
        {
          name: "Card",
          group: "surfaces",
          path: "components/surfaces/Card/Card.html",
          viewport: "480x320",
          hash: "sha256-AAA=",
          lastModified: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    // Already present: must NOT be duplicated by a synthetic entry.
    browse.openComponent("surfaces", "Card");
    const names = Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(
      (el) => el.dataset.componentName,
    );
    expect(names.filter((n) => n === "Card")).toHaveLength(1);
    // Brand new (first Apply): must project with a usable name.
    browse.openComponent("actions", "Button");
    const after = Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(
      (el) => el.dataset.componentName,
    );
    expect(after).toContain("Button");
    expect(after).not.toContain("undefined");
  });

  // #7 — Apply's side effect cannot be discarded like a stale Refine reply.
  // A draft-switcher click mid-flight bumps `generation`, and the guarded
  // clear then leaves the whole workspace disabled forever.
  it("always clears its own single-flight flag, even if the draft changed mid-apply", async () => {
    let releasePlan: (v: unknown) => void = () => {};
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__plan: () =>
        new Promise((resolve) => {
          releasePlan = resolve;
        }),
    });
    for (const note of ["first", "second"]) {
      wired.controller.addDraft(
        conjureResult(),
        {
          kitId: "my-kit",
          kitLabel: "My Kit",
          componentInKit: false,
          model: "m",
        },
        note,
      );
    }
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-confirm-accept") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__plan")).toBe(true);
    });
    // Switch drafts while the write is still in flight.
    const options = wired.document.querySelectorAll<HTMLButtonElement>(
      ".review-draft-switcher__option",
    );
    // The switcher is deliberately NOT disabled during an apply, and
    // selecting a draft bumps `generation` so a late refine reply cannot land
    // on the wrong draft. That same bump must not swallow the apply's lock.
    options[0].click();
    expect(wired.document.getElementById("apply-blockers")!.textContent).toMatch(
      /already in progress/i,
    );
    releasePlan({ planId: PLAN_ID });
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__validate")).toBe(true);
    });
    await Promise.resolve();
    wired.controller.refresh();
    // `inFlight` is this apply's lock, not the draft's: it must be released
    // however the selection moved, or Apply and Refine are dead for the rest
    // of the session with no recovery path.
    expect(wired.document.getElementById("apply-blockers")!.textContent).not.toMatch(
      /already in progress/i,
    );
    expect(
      wired.hooks.canRefine({
        hostAvailable: true,
        componentInKit: true,
        inFlight: false,
        instruction: "go",
      }).enabled,
    ).toBe(true);
  });

  // #8 — AC11 requires kit, component, exact paths AND byte scope before any
  // `plan` call. Generic "your kit" prose does not satisfy informed consent.
  it("names the kit, the component and the byte scope in the confirmation", () => {
    const wired = loadWired();
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: false,
      model: "m",
    });
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    const dialog = wired.document.getElementById("apply-confirm")!;
    expect(dialog.hidden).toBe(false);
    const text = dialog.textContent || "";
    expect(text).toMatch(/My Kit/);
    expect(text).toMatch(/Button/);
    expect(text).toMatch(/components\/actions\/Button\/Button\.html/);
    expect(text).toMatch(/\d+\s*bytes?/i);
  });

  // #9 — The advisory-validation compromise must not also swallow the
  // distinction AC13/S6 cares about. Bytes ARE written (so never re-write),
  // but a validation failure must NOT present as a completed, verified apply.
  it("records the write but withholds the verified-success state when validation fails", async () => {
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__validate: new Error("validate is unreadable to this host"),
    });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: false,
      model: "m",
    });
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-confirm-accept") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__write_files")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(wired.document.getElementById("apply-blockers")!.textContent).toMatch(
        /already applied/i,
      );
    });
    // Written — so it can never be double-written…
    expect(wired.calls.filter((c) => c.name === "mcp__genie__write_files")).toHaveLength(1);
    // …but the user is told verification did not complete, not that all is well.
    expect(wired.document.getElementById("review-status")!.textContent).toMatch(
      /could not|unverified|not verified|unable/i,
    );
  });

  // #10 — Under `default-src 'none'` an inline `onclick=` handler is blocked
  // just as surely as a <script> tag. Passing such a draft as "CSP safe" lets
  // a component whose interaction cannot run be written to the kit.
  it("fails the CSP check on inline event handlers", () => {
    const { computeChecklist } = loadHooks();
    const hostile = conjureResult({
      files: [
        fileEntry(
          "components/actions/Button/Button.html",
          `${MARKER}\n<button onclick="alert(1)">Go</button>\n`,
        ),
      ],
    });
    const csp = computeChecklist({ result: hostile, renderState: "pass" }).find(
      (row: { id: string }) => row.id === "csp",
    );
    expect(csp.state).toBe("fail");
  });
});

/**
 * PR #250, second review round. Nine findings (six inline, three suppressed as
 * low-confidence — all nine verified against source before being pinned here).
 * Each test below fails against the pre-fix tree.
 */
describe("PR #250 second review round", () => {
  function seedTwo(replies: Record<string, unknown | ((args: never) => unknown)>) {
    const wired = loadWired(replies);
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
      source: `${MARKER}\n<button>Old</button>\n`,
    });
    makeGreen(wired.document, wired.controller);
    return wired;
  }

  /** Type an instruction and press Refine, returning once the call is in flight. */
  function startRefine(document: Document) {
    const input = document.querySelector<HTMLTextAreaElement>("#refine-input")!;
    input.value = "tighten the spacing";
    input.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("#refine-submit")!.click();
  }

  // ── Finding 1 — adding a draft must invalidate an in-flight refine ────────
  it("discards a refine reply that lands after a newer draft was added", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const wired = seedTwo({
      ...HAPPY_REPLIES,
      mcp__genie__refine: () => pending,
    });
    startRefine(wired.document);

    // A second Generate lands while the refine is still in flight. It selects
    // the new draft, so the older refine's answer is answering a question the
    // user has already moved on from.
    // `componentInKit: true` keeps Refine legal for the NEW draft, so the
    // button re-enabling is a real signal that the discarded reply was
    // processed rather than an artefact of an unrelated gate.
    wired.controller.addDraft(conjureResult({ componentName: "Badge" }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
    });
    const before = wired.document.querySelectorAll(".review-draft-switcher__option").length;

    release(refineResult());
    await vi.waitFor(() => {
      expect(wired.document.querySelector<HTMLButtonElement>("#refine-submit")!.disabled).toBe(
        false,
      );
    });
    expect(wired.document.querySelectorAll(".review-draft-switcher__option").length).toBe(before);
    expect(wired.document.querySelector("#draft-name")!.textContent).toContain("Badge");
  });

  // ── Finding 8 — a discarded reply must still repaint ──────────────────────
  it("re-enables the controls after discarding a stale refine reply", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const wired = seedTwo({ ...HAPPY_REPLIES, mcp__genie__refine: () => pending });
    wired.controller.addDraft(conjureResult({ componentName: "Badge" }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
      source: `${MARKER}\n<b>x</b>\n`,
    });
    startRefine(wired.document);

    // Switch back to draft #1 mid-flight: the repaint that accompanies the
    // switch happens while `inFlight` is still true, so every control renders
    // disabled. Releasing the stale reply must repaint, not just unlock.
    const options = wired.document.querySelectorAll<HTMLButtonElement>(
      ".review-draft-switcher__option",
    );
    options[0]!.click();

    release(refineResult());
    await vi.waitFor(() => {
      expect(wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.disabled).toBe(
        false,
      );
    });
  });

  // ── Finding 2 — the "nothing written" note must stop lying after Apply ────
  it("stops claiming nothing was written once the draft is applied", async () => {
    const wired = seedTwo(HAPPY_REPLIES);
    const note = () => wired.document.querySelector("#draft-persistence-note")!.textContent ?? "";
    expect(note()).toMatch(/nothing has been written/i);

    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();

    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/applied/i);
    });
    expect(note()).not.toMatch(/nothing has been written/i);
    expect(note()).toMatch(/written to/i);
  });

  // ── Finding 6 — Review must re-evaluate when the host bridge changes ──────
  it("re-renders Review when the host bridge becomes available", () => {
    // Drives the REAL shell, not the review controller in isolation: `setBridge`
    // is the shell's method, and the whole finding is that it used to repaint
    // Browse but not Review. Seeding through `setRefineContext` is how Browse
    // itself hands a draft to the shell's own Review controller.
    const shell = loadShell();
    const bridge = {
      callTool(name: string) {
        return Promise.resolve(name === "mcp__genie__list_kits" ? { kits: [] } : {});
      },
    };
    // `undefined` = host handshake still pending, which is exactly the state the
    // embedded tier boots in before `setBridge` lands.
    const shellController = shell.hooks.initProductShell(shell.document, undefined, {});
    shellController.setRefineContext({
      kitId: "my-kit",
      group: "actions",
      componentName: "Button",
      displayName: "Button",
      variant: "default",
      source: `${MARKER}\n<button>Old</button>\n`,
      path: "components/actions/Button/Button.html",
    });

    const submit = () => shell.document.querySelector<HTMLButtonElement>("#refine-submit")!;
    const input = shell.document.querySelector<HTMLTextAreaElement>("#refine-input")!;
    input.value = "tighten the spacing";
    input.dispatchEvent(new shell.window.Event("input", { bubbles: true }));
    // No host yet, so Refine is correctly dead.
    expect(submit().disabled).toBe(true);

    shellController.setBridge(bridge);
    // Synchronous assertion on purpose: the repaint must come from `setBridge`
    // itself, not as a side effect of the async `list_kits` it also fires.
    expect(submit().disabled).toBe(false);

    shellController.setUnavailable();
    expect(submit().disabled).toBe(true);
  });

  // ── Finding 3 — Browse must refuse a component from a different kit ────────
  it("refuses to open a component belonging to a different kit", () => {
    const shell = loadShell();
    const browse = shell.hooks.initBrowseController(shell.document, {
      kitId: "my-kit",
      manifest: BROWSE_MANIFEST,
    });
    // Same kit is fine.
    expect(() => browse.openComponent("actions", "Button", "my-kit")).not.toThrow();
    // A different kit would read the WRONG bytes under the right name, so it
    // must throw rather than silently show a lie.
    expect(() => browse.openComponent("actions", "Button", "other-kit")).toThrow(/my-kit/);
    // An unspecified kit stays permissive (deep links carry no kit).
    expect(() => browse.openComponent("actions", "Button")).not.toThrow();
    browse.teardown();
  });

  // ── Finding 7 — the refine target is the DIRECTORY, not the display name ───
  it("derives the refine target from the path directory, not the manifest name", () => {
    const { componentDirFromPath } = loadHooks();
    // The server's `parseComponentPath` resolves a refine target by path
    // segment 3. The manifest `name` is only the basename, so a component
    // whose file is not `<Name>/<Name>.html` would 404 on refine.
    expect(componentDirFromPath("components/actions/Button/preview.html")).toBe("Button");
    expect(componentDirFromPath("components/actions/Button/Button.html")).toBe("Button");
    expect(componentDirFromPath("components/actions/preview.html")).toBe("");
    expect(componentDirFromPath("")).toBe("");
  });

  // ── Finding 5 + 9 — relative subresources are blocked, and `load` can't see it ──
  it("rejects relative subresources the embedded CSP will block", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    // `default-src 'none'` with no `style-src` for cards blocks a relative
    // stylesheet outright; `font-src 'none'` blocks a relative font. The
    // preview iframe fires `load` for all of these, so the static gate is the
    // only thing that can catch them.
    expect(violatesEmbeddedCsp('<link rel="stylesheet" href="styles.css">')).toBe(true);
    expect(violatesEmbeddedCsp('<img src="./icon.png">')).toBe(true);
    expect(violatesEmbeddedCsp("<style>a{background:url(./bg.png)}</style>")).toBe(true);
    expect(violatesEmbeddedCsp('<div style="background:url(../x/y.png)"></div>')).toBe(true);
  });

  it("still accepts inline-only markup and data: URIs", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp("<style>a{color:red}</style><button>Go</button>")).toBe(false);
    expect(violatesEmbeddedCsp('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(false);
    expect(violatesEmbeddedCsp('<a href="#main">skip</a>')).toBe(false);
    expect(violatesEmbeddedCsp('<use href="#icon-star"/>')).toBe(false);
  });

  it("does not claim the preview proved more than a load event can", () => {
    const { computeChecklist } = loadHooks();
    const rows = computeChecklist({ result: conjureResult(), renderState: "pass" });
    const render = rows.find((row: { id: string }) => row.id === "render");
    expect(render.state).toBe("pass");
    // A `load` on a sandboxed srcdoc frame proves the document parsed. It does
    // NOT prove subresources resolved or that anything was painted.
    expect(`${render.label} ${render.detail}`).toMatch(/load|parsed|document/i);
    expect(`${render.label} ${render.detail}`).not.toMatch(/without errors/i);
  });

  // ── Finding 4 — deletions encoded in the diff must be planned and executed ──
  it("plans and executes deletions the refine diff encodes", async () => {
    const { deletedPathsFromDiff, buildPlanArgs } = loadHooks();
    const diff = [
      "diff --git a/components/actions/Button/old.html b/components/actions/Button/old.html",
      "--- a/components/actions/Button/old.html",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-<div>gone</div>",
      "diff --git a/components/actions/Button/Button.html b/components/actions/Button/Button.html",
      "--- a/components/actions/Button/Button.html",
      "+++ b/components/actions/Button/Button.html",
      "@@ -1 +1 @@",
      "-<button>Old</button>",
      "+<button>Go</button>",
    ].join("\n");
    expect(deletedPathsFromDiff(diff)).toEqual(["components/actions/Button/old.html"]);

    const draft = { result: refineResult({ diff }) };
    const planArgs = buildPlanArgs(draft, "my-kit");
    expect(planArgs.deletes).toEqual(["components/actions/Button/old.html"]);
    expect(planArgs.writes).toEqual(["components/actions/Button/Button.html"]);
  });

  it("names the deletions in the Apply confirmation and calls delete_files", async () => {
    const diff = [
      "diff --git a/components/actions/Button/old.html b/components/actions/Button/old.html",
      "--- a/components/actions/Button/old.html",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-<div>gone</div>",
    ].join("\n");
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__delete_files: {
        deletedPaths: ["components/actions/Button/old.html"],
        notFoundPaths: [],
      },
    });
    wired.controller.addDraft(refineResult({ diff }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
      source: `${MARKER}\n<button>Old</button>\n`,
    });
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();

    // AC11 — the confirmation must name delete paths before any tool call.
    const dialog = wired.document.querySelector("#apply-confirm")!.textContent ?? "";
    expect(dialog).toContain("components/actions/Button/old.html");
    expect(dialog).toMatch(/delete/i);

    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();
    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/applied/i);
    });

    const names = wired.calls.map((call) => call.name);
    expect(names).toEqual([
      "mcp__genie__plan",
      "mcp__genie__write_files",
      "mcp__genie__delete_files",
      "mcp__genie__validate",
    ]);
    const planCall = wired.calls.find((call) => call.name === "mcp__genie__plan")!;
    expect(planCall.args.deletes).toEqual(["components/actions/Button/old.html"]);
    const deleteCall = wired.calls.find((call) => call.name === "mcp__genie__delete_files")!;
    expect(deleteCall.args).toEqual({
      planId: PLAN_ID,
      paths: ["components/actions/Button/old.html"],
    });
  });

  it("never calls delete_files when the draft deletes nothing", async () => {
    const wired = loadWired(HAPPY_REPLIES);
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
    });
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();
    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/applied/i);
    });
    expect(wired.calls.map((call) => call.name)).not.toContain("mcp__genie__delete_files");
    const planCall = wired.calls.find((call) => call.name === "mcp__genie__plan")!;
    expect(planCall.args.deletes).toBeUndefined();
  });

  it("reports a failed delete truthfully without claiming a clean apply", async () => {
    const diff = [
      "--- a/components/actions/Button/old.html",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-<div>gone</div>",
    ].join("\n");
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__delete_files: new Error("PathOutsidePlanError: not authorized"),
    });
    wired.controller.addDraft(refineResult({ diff }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
      source: `${MARKER}\n<button>Old</button>\n`,
    });
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();

    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(
        /stale|could not|remove/i,
      );
    });
    // The writes DID land, so this is never reported as "nothing was written".
    expect(wired.document.querySelector("#review-status")!.textContent).not.toMatch(
      /nothing was written/i,
    );
  });
});

// ── PR #250, Copilot review round 3 ───────────────────────────────────────────
//
// Two findings, both verified against source before a line was changed:
//   1. `runApply` downgraded a FAILED delete to a warning and still returned `ok: true`, so
//      `confirmApply` stamped the draft applied. The "already applied" blocker then removed the
//      only retry path, stranding the leftover files permanently.
//   2. The embedded boot's `onApplied` called `browseController.openComponent(...)`, which returns
//      `void`. `confirmApply` awaits that callback, so it resolved instantly — BEFORE the
//      post-apply `read_file` ran — and that read swallows failures to `null`. AC14's truthful
//      "the view is stale" path could therefore never fire in the embedded tier.
describe("PR #250 third review round", () => {
  // The boot IIFE is not reachable from jsdom, but it is where `onApplied` is actually wired.
  // Dropping the promise there defeats the whole awaitable-refresh fix while every behavioural
  // test still passes, so pin the wiring at the source level.
  it("returns the Browse refresh from every boot onApplied so confirmApply can await it", () => {
    const callbacks = VIEWER_JS.match(/onApplied: function \(applied\) \{[\s\S]*?\n\s*\},/g);
    expect(callbacks).toBeTruthy();
    // The shell wrapper plus both boot sites. Every one of them has to hand the promise back.
    expect(callbacks!.length).toBe(3);
    for (const callback of callbacks!) {
      expect(callback).toMatch(/\n\s*return /);
    }
    const refreshes = callbacks!.filter((body) => /browseController\.openComponent\(/.test(body));
    expect(refreshes.length).toBe(2);
    for (const refresh of refreshes) {
      expect(refresh).toMatch(/return browseController\.openComponent\(/);
    }
  });
});

describe("PR #250 third review round", () => {
  /** Build a draft whose diff deletes a file, with `delete_files` failing. */
  function loadStuckDelete() {
    const diff = [
      "--- a/components/actions/Button/old.html",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-<div>gone</div>",
    ].join("\n");
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__delete_files: new Error("PathOutsidePlanError: not authorized"),
    });
    wired.controller.addDraft(refineResult({ diff }), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
      source: `${MARKER}\n<button>Old</button>\n`,
    });
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();
    return wired;
  }

  // Finding 1 — a partial apply is not an apply. The writes are idempotent, so leaving the gate
  // open is the only honest state: it is the sole way to finish removing the stranded file.
  it("leaves a partially applied draft retryable when a delete is stuck", async () => {
    const wired = loadStuckDelete();
    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/stale/i);
    });
    expect(wired.document.getElementById("apply-blockers")!.textContent).not.toMatch(
      /already applied/i,
    );
    expect(wired.document.querySelector<HTMLButtonElement>("#apply-button")!.disabled).toBe(false);
  });

  // …and the status must say so, or a re-enabled button is just a mystery.
  it("tells the user the stuck delete can be retried", async () => {
    const wired = loadStuckDelete();
    await vi.waitFor(() => {
      expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/stale/i);
    });
    expect(wired.document.querySelector("#review-status")!.textContent).toMatch(/again|retry/i);
  });

  // A fully clean apply must still latch, or finding 1's fix would break the AC13 contract.
  it("still marks a clean apply as applied", async () => {
    const wired = loadWired(HAPPY_REPLIES);
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      model: "m",
      componentInKit: true,
    });
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-confirm-accept")!.click();
    await vi.waitFor(() => {
      expect(wired.document.getElementById("apply-blockers")!.textContent).toMatch(
        /already applied/i,
      );
    });
  });

  // Finding 2 — `openComponent` must be awaitable and must REJECT when the re-read fails,
  // otherwise `confirmApply`'s `refreshFailed` branch is unreachable.
  it("openComponent rejects when the applied bytes cannot be re-read", async () => {
    const shell = loadBrowseToReview(null);
    const settled = shell.browse.openComponent("actions", "Button");
    expect(typeof (settled as Promise<void> | undefined)?.then).toBe("function");
    await expect(settled).rejects.toThrow(/re-read|stale|refresh/i);
  });

  it("openComponent resolves once the applied bytes come back", async () => {
    const shell = loadBrowseToReview(`${MARKER}\n<button>New</button>\n`);
    await expect(shell.browse.openComponent("actions", "Button")).resolves.toBeUndefined();
  });

  // The end-to-end consequence: a real Browse refresh failure must surface AC14's stale-view copy
  // instead of a silent false success.
  it("surfaces the stale-view note when the post-apply re-read fails", async () => {
    const shell = loadBrowseToReview(null);
    await expect(shell.browse.openComponent("actions", "Button")).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Copilot review round 4 on PR #250. Nine findings; five were         */
/* documentation-accuracy and are fixed in `docs/`. These four are     */
/* behavioural, and the first is a real privilege-escalation hole:     */
/* the delete list is derived from the MODEL'S diff, which no          */
/* containment check ever saw.                                        */
/* ------------------------------------------------------------------ */
describe("PR #250 fourth review round", () => {
  /** A refine reply whose unified diff removes `path` (`+++ /dev/null`). */
  function deletingDraft(path: string) {
    return refineResult({
      diff: [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-<div>gone</div>",
        "",
      ].join("\n"),
    });
  }

  function containmentOf(result: Record<string, unknown>) {
    const { computeChecklist } = loadHooks();
    const rows = computeChecklist({ result, renderState: "pass" }) as {
      id: string;
      state: string;
    }[];
    return rows.find((row) => row.id === "containment")!;
  }

  it("fails containment when the diff deletes another component's file", () => {
    // Finding 1 — `components/actions/Other/Other.html` satisfies FILE_PATH_PATTERN
    // and would be waved through by a path-shape check alone.
    expect(containmentOf(deletingDraft("components/actions/Other/Other.html")).state).toBe("fail");
  });

  it("fails containment when the diff deletes a kit-root file", () => {
    expect(containmentOf(deletingDraft("styles.css")).state).toBe("fail");
  });

  it("keeps containment green for a delete inside the component's own folder", () => {
    expect(containmentOf(deletingDraft("components/actions/Button/old.html")).state).toBe("pass");
  });

  it("never asks the plan to authorise a delete outside the component folder", () => {
    // Defence in depth: the checklist gate above blocks Apply, but the plan is the
    // authorisation boundary — `delete_files` accepts any path the plan globbed.
    const { buildPlanArgs } = loadHooks();
    for (const escape of ["styles.css", "components/actions/Other/Other.html"]) {
      const args = buildPlanArgs({ result: deletingDraft(escape) }, "kit-a") as {
        deletes?: string[];
      };
      expect(args.deletes ?? []).not.toContain(escape);
    }
    const kept = buildPlanArgs(
      { result: deletingDraft("components/actions/Button/old.html") },
      "kit-a",
    ) as { deletes?: string[] };
    expect(kept.deletes).toEqual(["components/actions/Button/old.html"]);
  });

  it("reports decoded bytes, not base64 characters, in the Apply confirmation", () => {
    // Finding 2 — binary entries arrive base64-encoded, so measuring the *text*
    // overstates what lands on disk by ~4/3. Mirror write_files' `byteLengthOf`.
    const payload = Buffer.from("PNGDATA-PNGDATA").toString("base64");
    const wired = loadWired(HAPPY_REPLIES);
    wired.controller.addDraft(
      conjureResult({
        files: [
          fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`),
          {
            path: "components/actions/Button/icon.png",
            content: payload,
            mimeType: "image/png",
            encoding: "base64",
          },
        ],
      }),
      { kitId: "my-kit", kitLabel: "My Kit", model: "m", componentInKit: false },
    );
    makeGreen(wired.document, wired.controller);
    wired.document.querySelector<HTMLButtonElement>("#decision-approve")!.click();
    wired.document.querySelector<HTMLButtonElement>("#apply-button")!.click();

    const row = Array.from(wired.document.querySelectorAll("#apply-confirm-files li")).find((li) =>
      li.textContent?.includes("icon.png"),
    )!;
    expect(row.textContent).toContain(`${15} bytes`);
    expect(row.textContent).not.toContain(`${payload.length} bytes`);
  });

  it("re-reads the applied component's source exactly once", async () => {
    // Finding 3 — `select()` already renders, so a forced second render started a
    // second `read_file` and REPLACED the pending read the caller awaits. A
    // transient failure on that second read reported a stale view even though the
    // first had already succeeded.
    const shell = loadBrowseToReview(CARD_SOURCE);
    shell.calls.length = 0;
    await shell.browse.openComponent("surfaces", "Card");
    const reads = shell.calls.filter((name) => name === "mcp__genie__read_file");
    expect(reads).toHaveLength(1);
  });

  it("keeps the Browse display name when a component enters Review", async () => {
    // Finding 4 — the manifest's `name` is the user-facing identity and need not
    // match the directory. Review used to rename the component to its directory.
    const shell = loadBrowseToReview(CARD_SOURCE, {}, {
      ...BROWSE_MANIFEST,
      groups: ["actions"],
      components: [
        {
          name: "Primary buttons",
          group: "actions",
          path: "components/actions/Button/Button.html",
          viewport: "480x320",
          hash: "sha256-CCC=",
          lastModified: "2026-07-01T00:00:00.000Z",
        },
      ],
    } as Record<string, unknown>);
    const item = Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Primary buttons",
    );
    item!.click();
    await vi.waitFor(() => {
      expect(shell.document.querySelector<HTMLElement>("[data-refine-action]")).not.toBeNull();
      expect(shell.document.getElementById("browse-detail")!.textContent).not.toMatch(
        /Loading source/i,
      );
    });
    shell.document.querySelector<HTMLButtonElement>("[data-refine-action]")!.click();
    await vi.waitFor(() => {
      expect(shell.document.getElementById("draft-name")!.textContent).toBe("Primary buttons");
    });
  });
});

describe("PR #250 fifth review round", () => {
  it("accepts a refine result whose diff is empty, because a no-op refine is valid", () => {
    const hooks = loadHooks();
    // Server contract: `refineOutputShape.diff` is a bare `z.string()`
    // (`refine.ts`), and `buildUnifiedDiff` returns `""` whenever every path is
    // byte-identical on both sides. Rejecting that turns a truthful "the model
    // changed nothing" answer into "the host returned a result this viewer
    // cannot verify" — a lie about the host.
    expect(hooks.isRefineResult({ ...refineResult(), diff: "" })).toBe(true);
    // The type and size guards are the real protections and must survive.
    expect(hooks.isRefineResult({ ...refineResult(), diff: null })).toBe(false);
    expect(hooks.isRefineResult({ ...refineResult(), diff: "x".repeat(262145) })).toBe(false);
  });

  it("renders a no-change refine without a phantom diff section", () => {
    const hooks = loadHooks();
    // `parseUnifiedDiff("")` must stay zeroed so the review pane can hide the
    // section rather than print "0 files changed" as if that were a finding.
    const stats = hooks.parseUnifiedDiff("");
    expect(stats).toEqual({ additions: 0, deletions: 0, files: [] });
  });

  it("fails the CSP check for a remote <video poster>", () => {
    const hooks = loadHooks();
    // `media-src` has no fallback of its own under `default-src 'none'`, so the
    // poster frame is blocked and the card renders visibly broken — exactly the
    // outcome this gate exists to catch before Apply.
    expect(
      hooks.violatesEmbeddedCsp('<video poster="https://example.test/frame.png"></video>'),
    ).toBe(true);
    expect(hooks.violatesEmbeddedCsp('<video poster="data:image/png;base64,AAA"></video>')).toBe(
      false,
    );
  });

  it("hands Review the real source when Refine is clicked before the read settles", async () => {
    // The lazy `resolveSource()` fixed the STALE closure, but not the EARLY
    // one: between first paint and `read_file` resolving, the button is live
    // and `latestSource` is still `null`, so an eager click reported "could not
    // read" for a component whose bytes arrived milliseconds later.
    const shell = loadShell();
    let releaseRead: (value: unknown) => void = () => {};
    const readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const bridge = {
      callTool(name: string) {
        if (name === "mcp__genie__read_file") {
          return readGate.then(() => ({ content: CARD_SOURCE, encoding: "utf-8" }));
        }
        if (name === "mcp__genie__list_kits") return Promise.resolve({ kits: [] });
        return Promise.resolve({});
      },
      destroy() {},
    };
    const shellController = shell.hooks.initProductShell(shell.document, bridge, {});
    const browse = shell.hooks.initBrowseController(shell.document, {
      hostBridge: bridge,
      kitId: "kit-a",
      kitName: "kit",
      onRefine: (context: unknown) => shellController.setRefineContext(context),
    });
    browse.update(BROWSE_MANIFEST);
    browse.setHostBridge(bridge);

    const item = Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    item!.click();
    await vi.waitFor(() => {
      expect(shell.document.querySelector<HTMLElement>("[data-refine-action]")).not.toBeNull();
    });
    // Deliberately click WHILE the read is still in flight.
    expect(shell.document.getElementById("browse-detail")!.textContent).toMatch(/Loading source/i);
    shell.document.querySelector<HTMLButtonElement>("[data-refine-action]")!.click();
    releaseRead(null);

    await vi.waitFor(() => {
      expect((shell.document.getElementById("draft-review") as HTMLElement).hidden).toBe(false);
    });
    expect((shell.document.getElementById("review-empty") as HTMLElement).hidden).toBe(true);
    expect(
      shell.document.querySelector("#review-preview iframe")!.getAttribute("srcdoc"),
    ).toContain("Card from the kit");
  });

  it("keeps Refine inert while the pending read is being awaited", async () => {
    const shell = loadShell();
    let releaseRead: (value: unknown) => void = () => {};
    const readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const bridge = {
      callTool(name: string) {
        if (name === "mcp__genie__read_file") {
          reads += 1;
          return readGate.then(() => ({ content: CARD_SOURCE, encoding: "utf-8" }));
        }
        if (name === "mcp__genie__list_kits") return Promise.resolve({ kits: [] });
        return Promise.resolve({});
      },
      destroy() {},
    };
    const shellController = shell.hooks.initProductShell(shell.document, bridge, {});
    const browse = shell.hooks.initBrowseController(shell.document, {
      hostBridge: bridge,
      kitId: "kit-a",
      kitName: "kit",
      onRefine: (context: unknown) => shellController.setRefineContext(context),
    });
    browse.update(BROWSE_MANIFEST);
    browse.setHostBridge(bridge);
    Array.from(shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .find((el) => el.dataset.componentName === "Card")!
      .click();
    await vi.waitFor(() => {
      expect(shell.document.querySelector<HTMLElement>("[data-refine-action]")).not.toBeNull();
    });

    const button = shell.document.querySelector<HTMLButtonElement>("[data-refine-action]")!;
    button.click();
    // A second click during the await must not queue a second handoff, and the
    // control must say so rather than looking dead.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.click();
    releaseRead(null);

    await vi.waitFor(() => {
      expect((shell.document.getElementById("draft-review") as HTMLElement).hidden).toBe(false);
    });
    // One draft, not two — the disabled window is what guarantees it.
    expect(shell.document.getElementById("draft-label")!.textContent).toMatch(/draft #1/i);
    // And the await reuses the in-flight read rather than issuing another.
    expect(reads).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* PR #250 sixth review round + CodeQL frame-src taint                 */
/* ------------------------------------------------------------------ */

describe("PR #250 sixth review round", () => {
  /**
   * Finding 20 — `plan` and `validate` were passed NO_CLIENT_DEADLINE. Only `write_files` and
   * `delete_files` genuinely need an unbounded client wait (timing one out mid-write leaves it
   * ambiguous whether bytes landed), and only refine/conjure need it for the LLM window. `plan`
   * runs BEFORE any side effect and `validate` is advisory AFTER one, so a host that never answers
   * either simply locked `inFlight` forever with no recovery but a reload — which drops the draft.
   */
  it("gives plan and validate a bounded client deadline, but never the write tools", async () => {
    const hooks = await loadHooks();
    const seen: Array<{ name: string; timeout: unknown }> = [];
    const bridge = {
      callTool: async (name: string, _args: unknown, timeout?: unknown) => {
        seen.push({ name, timeout });
        if (name === "mcp__genie__plan") return { planId: "plan-1" };
        if (name === "mcp__genie__write_files") {
          return { writtenPaths: ["components/actions/Button/Button.html"] };
        }
        if (name === "mcp__genie__validate") return { markerMissing: [], orphanedFiles: [] };
        return {};
      },
    };
    await hooks.runApply({
      bridge,
      kitId: "kit-1",
      approved: true,
      draft: { id: 1, result: conjureResult() },
    });

    const timeoutFor = (name: string) =>
      seen.find((c) => c.name === `mcp__genie__${name}`)?.timeout;
    // Bounded: a stuck host frees the workspace instead of wedging it.
    expect(typeof timeoutFor("plan")).toBe("number");
    expect(typeof timeoutFor("validate")).toBe("number");
    // Still unbounded: a client-side timeout here cannot tell you whether the write landed.
    expect(timeoutFor("write_files")).toBe(hooks.NO_CLIENT_DEADLINE);
  });

  /**
   * Finding 21 — the confirmation dialog's decoded-byte arithmetic assumed well-formed base64.
   * The Review payload gate only checked the `encoding` enum, so `content: "="` reached
   * `entryByteLength` and produced `-1`, the dialog reported "-1 bytes", and Apply then failed at
   * the server's `isValidBase64Content` (`store/kit-files.ts:84`). Reject the same grammar up
   * front so the gate — not the confirmation copy — is where malformed base64 stops.
   */
  it("never reports a negative byte count for malformed base64", async () => {
    const hooks = await loadHooks();
    // `"="` passes /^[A-Za-z0-9+/]*={0,2}$/ but fails the length-%-4 rule the server enforces.
    expect(hooks.entryByteLength({ content: "=", encoding: "base64" })).toBe(0);
    expect(hooks.entryByteLength({ content: "QQ==", encoding: "base64" })).toBe(1);
  });

  it("blocks Apply when a base64 entry is not valid base64", async () => {
    const hooks = await loadHooks();
    // Keep the valid HTML preview so marker/preview-file/CSP all still pass: the ONLY thing wrong
    // with this draft is the base64 grammar of the second entry.
    const bad = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`),
        {
          path: "components/actions/Button/Button.png",
          content: "=",
          mimeType: "image/png",
          encoding: "base64" as const,
        },
      ],
    });
    // Guard: the same draft with well-formed base64 must still pass, or this test proves nothing.
    const good = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`),
        {
          path: "components/actions/Button/Button.png",
          content: "QQ==",
          mimeType: "image/png",
          encoding: "base64" as const,
        },
      ],
    });
    const goodSchema = hooks
      .computeChecklist({ result: good, renderState: "pass" })
      .find((row: { id: string }) => row.id === "schema");
    expect(goodSchema.state).toBe("pass");
    const checklist = hooks.computeChecklist({ result: bad, renderState: "pass" });
    const schema = checklist.find((row: { id: string }) => row.id === "schema");
    expect(schema.state).toBe("fail");
  });

  /**
   * Finding 22 — the confirmation copy claimed "This is the first time anything leaves this viewer
   * session." That is false on the supported stuck-delete retry: `write_files` already succeeded,
   * so bytes HAVE left. Re-confirming performs an idempotent duplicate write before retrying the
   * deletion. Copy must not deny a write that already happened.
   */
  it("drops the first-write claim once bytes have already been written", async () => {
    // A draft that both writes and deletes, so the stuck-delete retry path is reachable.
    const withDelete = refineResult({
      diff: [
        "diff --git a/components/actions/Button/Old.html b/components/actions/Button/Old.html",
        "--- a/components/actions/Button/Old.html",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        `-${MARKER}`,
        "",
      ].join("\n"),
    });
    const wired = loadWired({
      ...HAPPY_REPLIES,
      // The delete strands: neither removed nor already-absent, so the draft stays retryable.
      mcp__genie__delete_files: { deletedPaths: [], notFoundPaths: [] },
    });
    wired.controller.addDraft(withDelete, {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: false,
      model: "m",
    });
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();

    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    expect(wired.document.getElementById("apply-confirm-detail")!.textContent).toMatch(
      /first time/i,
    );
    (wired.document.getElementById("apply-confirm-accept") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.calls.some((c) => c.name === "mcp__genie__delete_files")).toBe(true);
      expect(wired.document.getElementById("review-status")!.textContent).toMatch(/retry/i);
    });

    // The retry: write_files already succeeded, so bytes HAVE left this session.
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    const detail = wired.document.getElementById("apply-confirm-detail")!.textContent ?? "";
    expect(detail).not.toMatch(/first time/i);
    expect(detail).toMatch(/already written|rewrites/i);
  });
});

describe("CodeQL — iframe src taint (alerts 2, 4, 5, 7)", () => {
  /**
   * `js/xss-through-dom`, `js/xss` and `js/client-side-unvalidated-url-redirection` all reach the
   * same sink: `iframe.setAttribute("src", …)`. Sources are a manifest-supplied `card.path`, a
   * `data-src` re-read from the DOM, and — worst — a `freshSrc` carried on an HMR postMessage,
   * which any page in the frame tree can send. The sandbox (allow-scripts, NO allow-same-origin)
   * contains the damage but is defence in depth, not the guard. Normalize the way the WHATWG URL
   * parser does, then allow only relative paths plus http/https/data.
   */
  it("passes relative and http(s)/data URLs through untouched", async () => {
    const hooks = await loadHooks();
    expect(hooks.safeFrameSrc("components/actions/Button/Button.html")).toBe(
      "components/actions/Button/Button.html",
    );
    expect(hooks.safeFrameSrc("https://example.test/x.html")).toBe("https://example.test/x.html");
    // Every `data:` URL the server mints is base64 (`grid-resource.ts`), so the metacharacter
    // strip below is a no-op on the real transport -- the base64 alphabet has no `<`, `>`, `"`
    // or `'` in it. Assert that byte-for-byte, because the grid depends on it.
    const embedded = "data:text/html;base64,PGI+aGk8L2I+";
    expect(hooks.safeFrameSrc(embedded)).toBe(embedded);
  });

  it("escapes HTML metacharacters that can never appear in a serialized URL", async () => {
    const hooks = await loadHooks();
    // WHATWG URL serialization always percent-encodes `<`, `>`, `"` and `'`, so a raw one is
    // always an injection attempt -- and a global replace over a regex that always matches `<`,
    // `'` and `"` is what CodeQL recognises as a barrier (`MetacharEscapeSanitizer`), which is how
    // alerts 8-10 clear. Copilot round 9: this originally DELETED the character, which silently
    // retargeted a legitimate `.../O'Reilly/preview.html` at a different file. Escaping keeps the
    // barrier and resolves to the byte the manifest actually names.
    expect(hooks.safeFrameSrc('components/a"onload=x/B.html')).toBe(
      "components/a%22onload=x/B.html",
    );
    expect(hooks.safeFrameSrc("components/a<script>/B.html")).toBe(
      "components/a%3Cscript%3E/B.html",
    );
    expect(hooks.safeFrameSrc("components/a'b/B.html")).toBe("components/a%27b/B.html");
  });

  it("neutralises javascript: and other script-bearing schemes", async () => {
    const hooks = await loadHooks();
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(hooks.safeFrameSrc(hostile)).toBe("about:blank");
    }
  });

  it("closes the WHATWG tab/newline and C0-trim bypasses", async () => {
    const hooks = await loadHooks();
    // The URL parser strips ASCII tab/LF/CR ANYWHERE and trims leading/trailing C0-or-space
    // BEFORE scheme detection, so all of these parse as `javascript:` in a real browser.
    for (const hostile of [
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
      "  javascript:alert(1)",
      "\u0000javascript:alert(1)",
    ]) {
      expect(hooks.safeFrameSrc(hostile)).toBe("about:blank");
    }
  });

  it("rejects protocol-relative URLs and non-strings", async () => {
    const hooks = await loadHooks();
    expect(hooks.safeFrameSrc("//evil.example/x")).toBe("about:blank");
    expect(hooks.safeFrameSrc(undefined)).toBe("about:blank");
    expect(hooks.safeFrameSrc(null)).toBe("about:blank");
    expect(hooks.safeFrameSrc("")).toBe("about:blank");
  });

  it("guards every iframe src assignment in the source", () => {
    const source = VIEWER_JS;
    // A raw assignment that isn't wrapped is exactly how alerts 2/4/5/7 got in. If you add a new
    // one, wrap it — don't relax this guard.
    const assignments = source.match(/setAttribute\("src",\s*([^)]*)\)/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      expect(line).toMatch(/safeFrameSrc\(/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Copilot review round 7 — findings 26-35                             */
/* ------------------------------------------------------------------ */

describe("round 7 — payload schema", () => {
  it("rejects two file entries that share a path", () => {
    const hooks = loadHooks();
    // `write_files` rejects duplicates up front with `DuplicatePathError`
    // (packages/server/src/tools/write_files.ts:104). A payload that only fails
    // AFTER the reviewer confirms is a gate that did not gate.
    const duplicate = conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>A</button>\n`),
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>B</button>\n`),
      ],
    });
    expect(hooks.isConjureResult(duplicate)).toBe(false);
    // Positive control: distinct paths still pass, so this is not a vacuous assertion.
    expect(
      hooks.isConjureResult(
        conjureResult({
          files: [
            fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>A</button>\n`),
            fileEntry("components/actions/Button/Button.css", ".b{color:red}"),
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("round 7 — embedded CSP preflight", () => {
  it("rejects a srcset whose later candidate is remote", () => {
    const hooks = loadHooks();
    const mixed =
      '<img srcset="data:image/png;base64,QQ== 1x, https://cdn.example/x.png 2x" alt="">';
    expect(hooks.violatesEmbeddedCsp(mixed)).toBe(true);
    // Positive control: every candidate inline is still allowed.
    expect(
      hooks.violatesEmbeddedCsp(
        '<img srcset="data:image/png;base64,QQ== 1x, data:image/png;base64,QQ== 2x" alt="">',
      ),
    ).toBe(false);
  });

  it("rejects a meta refresh, including character-reference spellings", () => {
    const hooks = loadHooks();
    // `default-src 'none'` does not govern document navigation, and the review
    // sandbox permits the frame to navigate itself.
    expect(
      hooks.violatesEmbeddedCsp('<meta http-equiv="refresh" content="0;url=https://evil.example">'),
    ).toBe(true);
    expect(
      hooks.violatesEmbeddedCsp(
        '<meta http-equiv="&#114;efresh" content="0;url=https://evil.example">',
      ),
    ).toBe(true);
    expect(
      hooks.violatesEmbeddedCsp(
        '<meta http-equiv="&#x72;efresh" content="0;url=https://evil.example">',
      ),
    ).toBe(true);
    // Positive control: an ordinary meta tag is not a navigation.
    expect(hooks.violatesEmbeddedCsp('<meta charset="utf-8">')).toBe(false);
  });
});

describe("round 7 — checklist accessibility", () => {
  it("announces pass/fail state for automated rows", () => {
    const { document, controller } = loadWired(HAPPY_REPLIES);
    controller.addDraft(conjureResult(), { kitId: "my-kit", kitLabel: "My Kit" });
    const row = document.querySelector('[data-check-id="schema"]')!;
    // The glyph is aria-hidden, so without extra text a screen reader hears only
    // the check's name and never its outcome.
    expect(row.textContent).toMatch(/passed/i);
    const manual = document.querySelector('[data-check-kind="manual"]')!;
    // Manual rows already expose state through their checkbox — no double-speak.
    expect(manual.textContent).not.toMatch(/\bpassed\b/i);
  });
});

describe("round 7 — draft provenance", () => {
  it("shows the token usage the model reported", () => {
    const { document, controller } = loadWired(HAPPY_REPLIES);
    controller.addDraft(conjureResult(), { kitId: "my-kit", kitLabel: "My Kit" });
    const summary = document.getElementById("draft-summary")!.textContent ?? "";
    expect(summary).toMatch(/tokens/i);
    expect(summary).toMatch(/10/);
    expect(summary).toMatch(/20/);
    expect(summary).toMatch(/30/);
  });

  it("omits the usage row when the payload carries no usage", () => {
    const { document, controller } = loadWired(HAPPY_REPLIES);
    const bare = conjureResult();
    delete (bare as Record<string, unknown>).usage;
    controller.addDraft(bare, { kitId: "my-kit", kitLabel: "My Kit" });
    expect(document.getElementById("draft-summary")!.textContent ?? "").not.toMatch(/tokens/i);
  });

  it("keeps a browse-sourced draft labelled Browse after a refine", async () => {
    const wired = loadWired({
      ...HAPPY_REPLIES,
      mcp__genie__refine: refineResult(),
    });
    wired.controller.addDraft(conjureResult(), {
      kitId: "my-kit",
      kitLabel: "My Kit",
      componentInKit: true,
      source: "browse",
    });
    expect(wired.document.getElementById("draft-summary")!.textContent).toMatch(/Browse/);

    const input = wired.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "make it wider";
    input.dispatchEvent(new wired.window.Event("input", { bubbles: true }));
    (wired.document.getElementById("refine-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.document.getElementById("draft-label")!.textContent).toMatch(/draft #2/i);
    });
    // A refine of a kit component is still that component — not a fresh generation.
    expect(wired.document.getElementById("draft-summary")!.textContent).toMatch(/Browse/);
  });
});

describe("round 7 — apply dialog truthfulness", () => {
  function twoFileDraft() {
    return conjureResult({
      files: [
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`),
        fileEntry("components/actions/Button/Button.css", ".b{color:red}"),
      ],
    });
  }

  it("remembers that bytes left the session when the write was only partial", async () => {
    const wired = loadWired({
      ...HAPPY_REPLIES,
      // One of the two planned files never landed: `ok:false`, writtenPaths non-empty.
      mcp__genie__write_files: { writtenPaths: ["components/actions/Button/Button.html"] },
    });
    wired.controller.addDraft(twoFileDraft(), { kitId: "my-kit", kitLabel: "My Kit" });
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-confirm-accept") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(wired.document.getElementById("review-status")!.textContent).toMatch(/partial write/i);
    });

    // Reopening must not claim these bytes have never left the session.
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    const detail = wired.document.getElementById("apply-confirm-detail")!.textContent ?? "";
    expect(detail).not.toMatch(/first time anything leaves/i);
    expect(detail).toMatch(/already written once/i);
  });

  it("takes the persistent app header out of the a11y tree while the dialog is up", () => {
    const wired = loadWired(HAPPY_REPLIES);
    wired.controller.addDraft(conjureResult(), { kitId: "my-kit", kitLabel: "My Kit" });
    makeGreen(wired.document, wired.controller);
    (wired.document.getElementById("decision-approve") as HTMLButtonElement).click();
    (wired.document.getElementById("apply-button") as HTMLButtonElement).click();
    const header = wired.document.querySelector(".app-header")!;
    // `aria-modal="true"` only promises focus containment to AT that honours it;
    // the header sits outside the review layout and stayed reachable.
    expect(header.hasAttribute("inert")).toBe(true);
    expect(header.getAttribute("aria-hidden")).toBe("true");
    (wired.document.getElementById("apply-confirm-cancel") as HTMLButtonElement).click();
    expect(header.hasAttribute("inert")).toBe(false);
    expect(header.hasAttribute("aria-hidden")).toBe(false);
  });
});

describe("round 7 — inherited style-src hashes", () => {
  it("warns when the embedding document pins style-src to build-time hashes", () => {
    const { document, controller, window } = loadWired(HAPPY_REPLIES);
    const meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", "default-src 'none'; style-src 'sha256-abc123'");
    document.head.append(meta);
    controller.addDraft(conjureResult(), { kitId: "my-kit", kitLabel: "My Kit" });
    const note = document.getElementById("review-preview-note") as HTMLElement;
    // A `srcdoc` frame inherits this policy, so an unwritten draft's inline
    // <style> can never match a hash minted before the draft existed.
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/style/i);
    void window;
  });

  it("stays quiet when the embedding document pins no style hashes", () => {
    const { document, controller } = loadWired(HAPPY_REPLIES);
    controller.addDraft(conjureResult(), { kitId: "my-kit", kitLabel: "My Kit" });
    expect((document.getElementById("review-preview-note") as HTMLElement).hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Copilot review round 9 — findings 36-37
 * ------------------------------------------------------------------ */

/** Exactly what `setRefineContext` seeds: no `manifestEntry`, no `usage`. */
function browseBaseline(overrides: Record<string, unknown> = {}) {
  return {
    componentName: "Button",
    group: "actions",
    files: [fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>Go</button>\n`)],
    ...overrides,
  };
}

type ChecklistRow = { id: string; state: string };

function schemaRow(result: unknown, hooks: Hooks) {
  const rows = hooks.computeChecklist({ result, renderState: "ok" }) as ChecklistRow[];
  return rows.find((row) => row.id === "schema") as ChecklistRow;
}

describe("F36 — a Browse baseline is validated on its own terms", () => {
  it("passes the schema check for a Browse seed that has no usage or manifestEntry", () => {
    const hooks = loadHooks();
    // A Browse handoff never made a model call, so there is no `usage` to
    // report and no conjure `manifestEntry`. Forcing it through
    // `isConjureResult` failed the row forever and pinned Apply shut.
    expect(schemaRow(browseBaseline(), hooks).state).toBe("pass");
  });

  it("passes the schema check for a deterministic tweak of a Browse baseline", () => {
    const hooks = loadHooks();
    // `applyDeterministicTweak` copies every own key and adds a recomputed
    // `diff`, so the tweak of a Browse seed is `{componentName, group, files, diff}`.
    const tweaked = browseBaseline({ diff: "" });
    expect(schemaRow(tweaked, hooks).state).toBe("pass");
  });

  it("still fails the schema check when a Browse-shaped payload has a bad file entry", () => {
    const hooks = loadHooks();
    const bad = browseBaseline({ files: [{ path: "x.html", content: "hi" }] });
    expect(schemaRow(bad, hooks).state).toBe("fail");
  });

  it("still fails the schema check when two Browse files share a path", () => {
    const hooks = loadHooks();
    const dupe = browseBaseline({
      files: [
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>a</button>\n`),
        fileEntry("components/actions/Button/Button.html", `${MARKER}\n<button>b</button>\n`),
      ],
    });
    expect(schemaRow(dupe, hooks).state).toBe("fail");
  });

  it("still fails the schema check when a Browse payload carries no html at all", () => {
    const hooks = loadHooks();
    // The preview pane must have something to render; a css-only payload is not reviewable.
    const cssOnly = browseBaseline({
      files: [
        {
          path: "components/actions/Button/Button.css",
          content: ".b{color:red}",
          mimeType: "text/css",
          encoding: "utf-8" as const,
        },
      ],
    });
    expect(schemaRow(cssOnly, hooks).state).toBe("fail");
  });

  it("accepts a non-canonical preview.html, which conjure output still may not use", () => {
    const hooks = loadHooks();
    // `Card/preview.html` is a legitimate kit entry point (see the preview-file row), but
    // `hasMatchingHtmlPreview` mirrors the MODEL-OUTPUT schema, so conjure keeps owing the
    // canonical `<Name>/<Name>.html` form.
    const files = [
      fileEntry("components/surfaces/Card/preview.html", `${MARKER}\n<div>Card</div>\n`),
    ];
    expect(
      schemaRow(browseBaseline({ componentName: "Card", group: "surfaces", files }), hooks).state,
    ).toBe("pass");
    expect(
      hooks.isConjureResult(conjureResult({ componentName: "Card", group: "surfaces", files })),
    ).toBe(false);
  });

  it("does not relax the conjure shape: a model reply still owes a usage", () => {
    const hooks = loadHooks();
    // Positive control for the negative above — a payload carrying a
    // `manifestEntry` claims to be a model reply, so it must carry `usage` too.
    const noUsage = conjureResult();
    delete (noUsage as Record<string, unknown>).usage;
    expect(hooks.isConjureResult(noUsage)).toBe(false);
    expect(schemaRow(noUsage, hooks).state).toBe("fail");
  });

  it("renders a PASSING schema row after a real Browse handoff", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const row = shell.document.querySelector('[data-check-id="schema"]');
    // Positive control: the row must actually exist, or the assertion below
    // would pass on a null-shaped nothing.
    expect(row).not.toBeNull();
    expect(row!.className).not.toContain("check-item--fail");
    expect(row!.className).toContain("check-item--pass");
  });
});

describe("F37 — safeFrameSrc matches browser URL resolution", () => {
  it("rejects a backslash protocol-relative URL", () => {
    const hooks = loadHooks();
    // WHATWG treats `\` as `/` for special schemes, so on an https page
    // `\\evil.example/x` resolves to `https://evil.example/x`.
    expect(hooks.safeFrameSrc("\\\\evil.example/x")).toBe("about:blank");
  });

  it("rejects the mixed slash/backslash protocol-relative forms", () => {
    const hooks = loadHooks();
    expect(hooks.safeFrameSrc("/\\evil.example/x")).toBe("about:blank");
    expect(hooks.safeFrameSrc("\\/evil.example/x")).toBe("about:blank");
  });

  it("still rejects the plain protocol-relative form", () => {
    const hooks = loadHooks();
    expect(hooks.safeFrameSrc("//evil.example/x")).toBe("about:blank");
  });

  it("preserves an apostrophe in a manifest path by encoding it", () => {
    const hooks = loadHooks();
    // Deleting the quote silently retargets the frame at a DIFFERENT file.
    // Percent-encoding resolves to the same path the manifest names.
    const out = hooks.safeFrameSrc("components/actions/O'Reilly/preview.html");
    expect(out).not.toBe("about:blank");
    expect(out).toBe("components/actions/O%27Reilly/preview.html");
    expect(decodeURIComponent(out)).toBe("components/actions/O'Reilly/preview.html");
  });

  it("encodes rather than deletes the remaining HTML metacharacters", () => {
    const hooks = loadHooks();
    expect(hooks.safeFrameSrc('a"b')).toBe("a%22b");
    expect(hooks.safeFrameSrc("a<b>c")).toBe("a%3Cb%3Ec");
    expect(hooks.safeFrameSrc("a`b")).toBe("a%60b");
  });

  it("leaves an ordinary relative manifest path untouched", () => {
    const hooks = loadHooks();
    expect(hooks.safeFrameSrc("components/actions/Button/preview.html")).toBe(
      "components/actions/Button/preview.html",
    );
  });

  it("still allows https and data, and still rejects javascript", () => {
    const hooks = loadHooks();
    expect(hooks.safeFrameSrc("https://example.com/x")).toBe("https://example.com/x");
    expect(hooks.safeFrameSrc("data:text/html;base64,PGI+aGk8L2I+")).toBe(
      "data:text/html;base64,PGI+aGk8L2I+",
    );
    expect(hooks.safeFrameSrc("javascript:alert(1)")).toBe("about:blank");
  });
});

/* ------------------------------------------------------------------
 * Copilot review round 10 — F38
 * The blanket `data:` exemption in LOCAL_REF is only correct for
 * IMAGE-bearing attributes. The embedded card policy
 * (`packages/server/src/ui/card-asset-broker.ts`) is:
 *   default-src 'none'; img-src 'self' data: blob:; connect-src 'none';
 *   font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
 * There is no `media-src` and no `frame-src`, and `object-src` is
 * explicitly 'none' — so a `data:` URL on media/object/embed/iframe is
 * blocked just as hard as a remote one, and a green gate ships a card
 * that renders broken.
 * ------------------------------------------------------------------ */

describe("F38 — the data: exemption is directive-aware", () => {
  it("rejects data: media sources, which have no media-src to fall back on", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp('<video src="data:video/mp4;base64,AAAA"></video>')).toBe(true);
    expect(violatesEmbeddedCsp('<audio src="data:audio/mpeg;base64,AAAA"></audio>')).toBe(true);
    expect(violatesEmbeddedCsp('<video><source src="data:video/mp4;base64,AA"></video>')).toBe(
      true,
    );
    expect(violatesEmbeddedCsp('<video><track src="data:text/vtt,WEBVTT"></video>')).toBe(true);
  });

  it("rejects data: object and embed sources, which object-src 'none' blocks outright", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp('<object data="data:text/html,<b>x</b>"></object>')).toBe(true);
    expect(violatesEmbeddedCsp('<embed src="data:image/svg+xml,<svg/>">')).toBe(true);
  });

  it("rejects a nested data: iframe, which has no frame-src in the card policy", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp('<iframe src="data:text/html,<b>x</b>"></iframe>')).toBe(true);
  });

  it("catches the unquoted and whitespace-padded forms too", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp("<video src=data:video/mp4;base64,AAAA></video>")).toBe(true);
    expect(violatesEmbeddedCsp('<object data=" data:text/html,x"></object>')).toBe(true);
  });

  it("still allows data: on image-bearing attributes, which img-src permits", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp('<img src="data:image/png;base64,AAAA" alt="">')).toBe(false);
    expect(violatesEmbeddedCsp('<video poster="data:image/png;base64,AAAA"></video>')).toBe(false);
    expect(
      violatesEmbeddedCsp('<picture><source srcset="data:image/png;base64,AA"></picture>'),
    ).toBe(false);
  });

  it("does not trip on prose or on a media element with no source at all", () => {
    const { violatesEmbeddedCsp } = loadHooks();
    expect(violatesEmbeddedCsp("<p>Use a video src of data: only for images.</p>")).toBe(false);
    expect(violatesEmbeddedCsp("<video controls></video>")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* F39 (Copilot round 12) — the apply dialog must not strand `inert`.  */
/* `.app-header` lives OUTSIDE every [data-route-view], so the         */
/* `inert`/`aria-hidden` the dialog puts on it survives a route change */
/* unless the route change closes the dialog. `popstate` (Back) never  */
/* passes through the dialog's own controls, so it is the vector.      */
/* ------------------------------------------------------------------ */

/** Boot a real product shell that already holds an approved, appliable draft. */
async function loadRoutedDraft() {
  const shell = loadShell();
  const bridge = {
    callTool(name: string) {
      if (name === "mcp__genie__list_kits") return Promise.resolve({ kits: [] });
      return Promise.resolve({});
    },
    destroy() {},
  };
  const shellController = shell.hooks.initProductShell(shell.document, bridge, {});
  shellController.setRefineContext({
    kitId: "kit-a",
    componentName: "Card",
    group: "actions",
    path: "components/actions/Card/Card.html",
    source: CARD_SOURCE,
  });
  const { document } = shell;
  firePreviewLoad(document);
  for (const box of Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-check-toggle]"),
  )) {
    box.checked = true;
    box.dispatchEvent(new document.defaultView!.Event("change", { bubbles: true }));
  }
  document
    .getElementById("decision-approve")!
    .dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  await vi.waitFor(() => {
    expect((document.getElementById("apply-button") as HTMLButtonElement).disabled).toBe(false);
  });
  const applyButton = document.getElementById("apply-button") as HTMLButtonElement;
  // A real pointer click focuses the button first; `dialogReturnFocus` is read off
  // `document.activeElement`, so skipping this would capture the wrong return target.
  applyButton.focus();
  applyButton.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  expect((document.getElementById("apply-confirm") as HTMLElement).hidden).toBe(false);
  return { ...shell, shellController };
}

/** The Back button: change the URL, then fire the event the browser fires. */
function goBackTo(shell: { window: Window & typeof globalThis }, route: string) {
  shell.window.history.pushState({}, "", `?route=${route}`);
  shell.window.dispatchEvent(new shell.window.PopStateEvent("popstate"));
}

describe("F39 — a route change cannot strand the apply dialog", () => {
  it("marks the persistent header inert while the dialog is open", async () => {
    const { document } = await loadRoutedDraft();
    const header = document.querySelector(".app-header") as HTMLElement;
    expect(header.hasAttribute("inert")).toBe(true);
    expect(header.getAttribute("aria-hidden")).toBe("true");
  });

  it("clears inert from the persistent header when Back leaves Review", async () => {
    const shell = await loadRoutedDraft();
    goBackTo(shell, "generate");
    const header = shell.document.querySelector(".app-header") as HTMLElement;
    expect(header.hasAttribute("inert")).toBe(false);
  });

  it("clears aria-hidden from the persistent header when Back leaves Review", async () => {
    const shell = await loadRoutedDraft();
    goBackTo(shell, "generate");
    const header = shell.document.querySelector(".app-header") as HTMLElement;
    expect(header.hasAttribute("aria-hidden")).toBe(false);
  });

  it("hides the dialog itself when Back leaves Review", async () => {
    const shell = await loadRoutedDraft();
    goBackTo(shell, "generate");
    expect((shell.document.getElementById("apply-confirm") as HTMLElement).hidden).toBe(true);
  });

  it("does not leave focus inside the now-hidden Review view", async () => {
    const shell = await loadRoutedDraft();
    goBackTo(shell, "generate");
    const active = shell.document.activeElement;
    const reviewView = shell.document.getElementById("review-view") as HTMLElement;
    expect(reviewView.hidden).toBe(true);
    expect(active === null || !reviewView.contains(active)).toBe(true);
  });

  it("also closes the dialog when an in-app route link changes the view", async () => {
    const shell = await loadRoutedDraft();
    const link = shell.document.querySelector<HTMLElement>('[data-route-link="generate"]');
    expect(link).not.toBeNull();
    link!.dispatchEvent(new shell.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const header = shell.document.querySelector(".app-header") as HTMLElement;
    expect((shell.document.getElementById("apply-confirm") as HTMLElement).hidden).toBe(true);
    expect(header.hasAttribute("inert")).toBe(false);
  });

  it("leaves the dialog open when the route re-renders as Review", async () => {
    const shell = await loadRoutedDraft();
    goBackTo(shell, "review");
    const header = shell.document.querySelector(".app-header") as HTMLElement;
    expect((shell.document.getElementById("apply-confirm") as HTMLElement).hidden).toBe(false);
    expect(header.hasAttribute("inert")).toBe(true);
  });

  it("still returns focus to Apply when the dialog is cancelled normally", async () => {
    const shell = await loadRoutedDraft();
    shell.document
      .getElementById("apply-confirm-cancel")!
      .dispatchEvent(new shell.window.Event("click", { bubbles: true }));
    expect(shell.document.activeElement).toBe(shell.document.getElementById("apply-button"));
    expect((shell.document.querySelector(".app-header") as HTMLElement).hasAttribute("inert")).toBe(
      false,
    );
  });
});
