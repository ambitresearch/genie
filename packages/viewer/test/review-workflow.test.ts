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

  it("rejects a non-string or empty diff", () => {
    const { isRefineResult } = loadHooks();
    expect(isRefineResult(refineResult({ diff: 42 }))).toBe(false);
    expect(isRefineResult(refineResult({ diff: "" }))).toBe(false);
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
) {
  const shell = loadShell();
  const bridge = {
    callTool(name: string) {
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
  browse.update(BROWSE_MANIFEST);
  browse.setHostBridge(bridge);
  return { ...shell, browse, shellController };
}

async function refineFromBrowse(shell: ReturnType<typeof loadBrowseToReview>) {
  const item = Array.from(
    shell.document.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ).find((el) => el.dataset.componentName === "Card");
  item!.click();
  // The detail panel reads the component's source through the host bridge
  // before it can hand anything to Review; let that read settle first,
  // otherwise every case degrades to the no-source path and the test proves
  // nothing.
  await vi.waitFor(() => {
    expect(
      shell.document.querySelector<HTMLElement>("[data-refine-action]"),
    ).not.toBeNull();
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

  it("uses the kit's bytes as the review baseline so the checklist can run", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const frame = shell.document.querySelector("#review-preview iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("srcdoc")).toContain("Card from the kit");
    expect(
      shell.document.querySelector('[data-check-id="marker"]')!.className,
    ).toContain("check-item--pass");
  });

  it("unlocks Refine, because a component opened from Browse IS in the kit", async () => {
    const shell = loadBrowseToReview(CARD_SOURCE);
    await refineFromBrowse(shell);
    const input = shell.document.getElementById("refine-input") as HTMLTextAreaElement;
    input.value = "Tighten the padding";
    input.dispatchEvent(new shell.window.Event("input", { bubbles: true }));
    // `refine` loads its source from the kit, so this is the one case where a
    // brand-new review draft may be refined without applying first.
    expect(
      (shell.document.getElementById("refine-submit") as HTMLButtonElement).disabled,
    ).toBe(false);
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
    expect(shell.appliedCalls[0].writtenPaths).toEqual([
      "components/actions/Button/Button.html",
    ]);
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
    expect(wired.document.querySelectorAll(".review-draft-switcher__option").length).toBe(
      before,
    );
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
      el.dispatchEvent(
        new wired.window.KeyboardEvent("keydown", { key: k, bubbles: true }),
      );

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
