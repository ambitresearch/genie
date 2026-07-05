/**
 * Tests for the M3-04 (DRO-260) `validate` full-scan ORCHESTRATOR
 * (`packages/server/src/validate/full-scan.ts`).
 *
 * The orchestrator is the seam that ties the three already-unit-tested pieces
 * together across a whole kit:
 *   - `validate/marker.ts`  → AC3 `markerMissing`
 *   - `validate/render.ts`  → AC4 `thin` (content-height measurement)
 *   - `validate/phash.ts`   → AC5 `variantsIdentical` (perceptual-hash clusters)
 * and aggregates AC6 `{ total, bad }`.
 *
 * Both collaborators are injected as seams (a `FullScanKitStore` and a
 * `Renderer`), exactly as `refine.ts` injects its `RefineKitStore`/`RegionCropper`
 * — so this suite runs fully offline: NO browser is ever launched, and the
 * perceptual hash runs against synthetic in-memory pixel buffers (the real
 * `computePHash`, so the clustering path is exercised end-to-end without a
 * render). The real Playwright path is covered separately by the tool-level +
 * manual end-to-end runs recorded on the PR.
 */
import { describe, expect, it } from "vitest";
import { fullScan, type FullScanKitStore, type FullScanDeps } from "./full-scan.js";
import type { Renderer, RenderedCard } from "./render.js";

// ── Synthetic image builders (same idea as phash.test.ts) ─────────────────────
// A FLAT solid color hashes to the same value regardless of the color (every
// block ties at the image-wide median), so "distinct" fixtures must have
// internal structure — a left/right split — to hash differently.

function splitImage(
  left: [number, number, number, number],
  right: [number, number, number, number],
  size = 64,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = x < size / 2 ? left : right;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  return { data, width: size, height: size };
}

/**
 * A TOP/BOTTOM split — a different spatial ORIENTATION than `splitImage`'s
 * left/right, so it hashes far from BOTH `IMAGE_A` and `IMAGE_B`. blockhash
 * encodes the light/dark spatial PATTERN (not absolute colors), so two
 * left/right splits — even with different colors — can hash near-identically
 * (their dark/light quadrant layout matches); a top/bottom split cannot. Use
 * this for a third fixture that must not cluster with the left/right pair.
 * (Verified empirically: L/R vs inverse-L/R = 256 bits, L/R vs T/B = 128 bits —
 * both far above the 4-bit `DEFAULT_TOLERANCE_BITS`.)
 */
function stackImage(
  top: [number, number, number, number],
  bottom: [number, number, number, number],
  size = 64,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = y < size / 2 ? top : bottom;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  return { data, width: size, height: size };
}

/** Two visually-different card images (swapped halves → different hashes). */
const IMAGE_A = splitImage([200, 124, 94, 255], [32, 64, 96, 255]);
const IMAGE_B = splitImage([32, 64, 96, 255], [200, 124, 94, 255]);

// ── Stubs ─────────────────────────────────────────────────────────────────────

interface StubFile {
  path: string;
  content: string;
}

/** A kit store backed by a fixed file list (structural match for the store). */
function stubKitStore(files: StubFile[]): FullScanKitStore & { readCalls: string[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const readCalls: string[] = [];
  return {
    readCalls,
    async listFiles() {
      return files.map((f) => ({ path: f.path }));
    },
    async readFile(_kitId: string, path: string) {
      readCalls.push(path);
      const f = byPath.get(path);
      if (!f) throw new Error(`no such file: ${path}`);
      return { content: f.content, encoding: "utf-8" as const, mimeType: "text/html" };
    },
  };
}

/**
 * A renderer whose output is scripted per-HTML. `script` maps the raw HTML to a
 * `RenderedCard` (contentHeight + image); an unmapped HTML yields a tall,
 * distinct-enough default so it never accidentally trips the thin/variant checks.
 */
function stubRenderer(
  script: (html: string) => RenderedCard,
): Renderer & { rendered: string[]; closed: number } {
  const rendered: string[] = [];
  const state = { closed: 0 };
  return {
    rendered,
    get closed() {
      return state.closed;
    },
    async render(html: string): Promise<RenderedCard> {
      rendered.push(html);
      return script(html);
    },
    async close(): Promise<void> {
      state.closed += 1;
    },
  };
}

/**
 * A renderer that records the `viewport` argument passed to each `render()`
 * call (DRO-711 regression coverage — the marker-viewport precedence fix).
 * `stubRenderer` above deliberately drops this argument (no existing test
 * needed it); this variant exists specifically to assert on it.
 */
function viewportCapturingRenderer(
  script: (html: string) => RenderedCard,
): Renderer & { viewports: Array<{ width: number; height: number }> } {
  const viewports: Array<{ width: number; height: number }> = [];
  return {
    viewports,
    async render(html: string, viewport: { width: number; height: number }): Promise<RenderedCard> {
      viewports.push(viewport);
      return script(html);
    },
    async close(): Promise<void> {},
  };
}

/** A renderer that always throws — models a browser that launched but fails
 * mid-render on a specific page. */
function throwingRenderer(): Renderer {
  return {
    async render(): Promise<RenderedCard> {
      throw new Error("render boom");
    },
    async close(): Promise<void> {},
  };
}

const MARKER = '<!-- @genie group="actions" viewport="400x200" -->';

function deps(overrides: Partial<FullScanDeps>): FullScanDeps {
  return {
    kitStore: stubKitStore([]),
    renderer: null,
    ...overrides,
  };
}

// A default rendered card that is tall (not thin) and distinct-per-call so the
// happy path never trips thin/variant. The three fixtures are mutually far in
// hash space: IMAGE_A / IMAGE_B are inverse left/right splits (256 bits apart),
// and stackImage is a top/bottom split (~128 bits from both) — see the
// stackImage doc for why orientation, not color, is what separates them.
function tallDistinct(html: string): RenderedCard {
  const pick =
    html.length % 3 === 0
      ? IMAGE_A
      : html.length % 3 === 1
        ? IMAGE_B
        : stackImage([10, 20, 30, 255], [220, 210, 200, 255]);
  return { contentHeight: 500, image: pick };
}

describe("fullScan — markerMissing (AC3)", () => {
  it("flags a preview whose first line lacks the @genie marker", async () => {
    const kitStore = stubKitStore([
      { path: "components/actions/Ok/Ok.html", content: `${MARKER}\n<button>Hi</button>` },
      { path: "components/actions/Bad/Bad.html", content: `<div>no marker here</div>` },
    ]);
    const res = await fullScan(deps({ kitStore, renderer: stubRenderer(tallDistinct) }), {
      kitId: "k",
    });
    expect(res.markerMissing).toEqual(["components/actions/Bad/Bad.html"]);
  });

  it("does not flag a well-formed marker", async () => {
    const kitStore = stubKitStore([{ path: "a/A.html", content: `${MARKER}\n<button>A</button>` }]);
    const res = await fullScan(deps({ kitStore, renderer: stubRenderer(tallDistinct) }), {
      kitId: "k",
    });
    expect(res.markerMissing).toEqual([]);
  });

  it("returns markerMissing sorted for deterministic output", async () => {
    const kitStore = stubKitStore([
      { path: "z/Z.html", content: `no marker` },
      { path: "a/A.html", content: `no marker` },
    ]);
    const res = await fullScan(deps({ kitStore, renderer: null }), { kitId: "k" });
    expect(res.markerMissing).toEqual(["a/A.html", "z/Z.html"]);
  });
});

describe("fullScan — thin (AC4)", () => {
  it("flags a render shorter than the default 80px minHeight", async () => {
    const kitStore = stubKitStore([{ path: "a/Short.html", content: `${MARKER}\n<span>.</span>` }]);
    const renderer = stubRenderer(() => ({ contentHeight: 40, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.thin).toEqual(["a/Short.html"]);
  });

  it("does not flag a render at/above the default 80px minHeight", async () => {
    const kitStore = stubKitStore([{ path: "a/Tall.html", content: `${MARKER}\n<div>tall</div>` }]);
    const renderer = stubRenderer(() => ({ contentHeight: 80, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    // 80 is NOT < 80 — boundary is exclusive.
    expect(res.thin).toEqual([]);
  });

  it("respects a per-file meta.json renderCheck.minHeight override", async () => {
    const kitStore = stubKitStore([
      { path: "a/Btn/Btn.html", content: `${MARKER}\n<div>x</div>` },
      {
        path: "a/Btn/meta.json",
        content: JSON.stringify({ group: "actions", renderCheck: { minHeight: 150 } }),
      },
    ]);
    // 120 clears the default 80 but is below the meta override of 150 → thin.
    const renderer = stubRenderer(() => ({ contentHeight: 120, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.thin).toEqual(["a/Btn/Btn.html"]);
  });

  it("falls back to the default when meta.json is malformed", async () => {
    const kitStore = stubKitStore([
      { path: "a/Btn/Btn.html", content: `${MARKER}\n<div>x</div>` },
      { path: "a/Btn/meta.json", content: `{ not valid json` },
    ]);
    // 90 >= default 80 → not thin, because the malformed meta is ignored.
    const renderer = stubRenderer(() => ({ contentHeight: 90, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.thin).toEqual([]);
  });

  // ── DRO-711 regression coverage ──────────────────────────────────────────
  // Real-Chromium QA (DRO-711, post-merge hardening of DRO-260/PR #152) found
  // that `conjure.ts` never synthesizes a `meta.json` — the LLM system prompt
  // only encourages one and the output schema doesn't require it — so a
  // meta.json-less kit (the common case) used to render EVERY card at the
  // generic 400x300 DEFAULT_VIEWPORT regardless of the component's actual
  // marker-declared size, silently flagging ordinary button-sized cards
  // `thin` and diluting the AC5 pHash signal (see full-scan.ts's
  // DEFAULT_VIEWPORT doc for the full real-render evidence). These tests
  // pin the fix: the marker's own `viewport="WxH"` token is now the
  // REALISTIC default, with `meta.json` still winning as an explicit
  // per-component override — the same precedence `manifest/compiler.ts`
  // already established for the identical marker-vs-meta.json question.

  it("renders at the marker's own viewport when no meta.json is present (DRO-711)", async () => {
    const kitStore = stubKitStore([
      {
        path: "a/Btn/Btn.html",
        content: '<!-- @genie group="actions" viewport="320x96" -->\n<div>x</div>',
      },
    ]);
    const renderer = viewportCapturingRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(renderer.viewports).toEqual([{ width: 320, height: 96 }]);
  });

  it("prefers an explicit meta.json viewport over the marker's viewport (DRO-711)", async () => {
    const kitStore = stubKitStore([
      {
        path: "a/Btn/Btn.html",
        content: '<!-- @genie group="actions" viewport="320x96" -->\n<div>x</div>',
      },
      {
        path: "a/Btn/meta.json",
        content: JSON.stringify({ group: "actions", viewport: { width: 800, height: 600 } }),
      },
    ]);
    const renderer = viewportCapturingRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(renderer.viewports).toEqual([{ width: 800, height: 600 }]);
  });

  it("falls back to DEFAULT_VIEWPORT only when the marker has no viewport attribute at all (DRO-711)", async () => {
    const kitStore = stubKitStore([
      { path: "a/Btn/Btn.html", content: '<!-- @genie group="actions" -->\n<div>x</div>' },
    ]);
    const renderer = viewportCapturingRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(renderer.viewports).toEqual([{ width: 400, height: 300 }]);
  });

  it("passes the renderer the component's OWN declared viewport, not a generic one (DRO-711)", async () => {
    // Regression for the real-render finding: the OLD code rendered every
    // card at the generic 400x300 DEFAULT_VIEWPORT regardless of the
    // component's actual size, because it only ever consulted `meta.json`
    // (which `conjure.ts` never produces) and ignored the marker's own
    // `viewport="WxH"` token. This test pins that a real renderer now
    // receives the CORRECT per-component viewport — the precondition for it
    // to report a real, comparable `contentHeight`/pHash for that component.
    //
    // NOTE: whether an ordinary single-line button's real height (measured
    // ~46-48px on real Chromium at this exact 320x96 viewport during DRO-711)
    // should itself count as "thin" against `DEFAULT_MIN_HEIGHT` (80) is a
    // SEPARATE, still-open calibration question this fix does not decide —
    // see the DRO-711 follow-up issue. This test only pins viewport
    // propagation, using a stubbed height so it stays independent of that
    // open question.
    const kitStore = stubKitStore([
      {
        path: "a/Btn/Btn.html",
        content: '<!-- @genie group="actions" viewport="320x96" -->\n<button>Primary</button>',
      },
    ]);
    const renderer = viewportCapturingRenderer(() => ({ contentHeight: 48, image: IMAGE_A }));
    await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(renderer.viewports).toEqual([{ width: 320, height: 96 }]);
  });
});

describe("fullScan — variantsIdentical (AC5)", () => {
  it("clusters two identical-looking renders", async () => {
    const kitStore = stubKitStore([
      { path: "a/One.html", content: `${MARKER}\n<button>one</button>` },
      { path: "a/Two.html", content: `${MARKER}\n<button>two</button>` },
    ]);
    // Both render to the SAME image → within tolerance → clustered.
    const renderer = stubRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.variantsIdentical).toEqual(["a/One.html", "a/Two.html"]);
  });

  it("leaves visually-distinct renders out of variantsIdentical", async () => {
    const kitStore = stubKitStore([
      { path: "a/One.html", content: `${MARKER}\n<button>one</button>` },
      { path: "a/Two.html", content: `${MARKER}\n<button>two</button>` },
    ]);
    const renderer = stubRenderer((html) => ({
      contentHeight: 300,
      image: html.includes("one") ? IMAGE_A : IMAGE_B,
    }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.variantsIdentical).toEqual([]);
  });

  it("clusters three identical renders (the AC5 example: 3 buttons that look the same)", async () => {
    const kitStore = stubKitStore([
      { path: "x/X.html", content: `${MARKER}\n<button>a</button>` },
      { path: "y/Y.html", content: `${MARKER}\n<button>b</button>` },
      { path: "z/Z.html", content: `${MARKER}\n<button>c</button>` },
    ]);
    const renderer = stubRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.variantsIdentical.slice().sort()).toEqual(["x/X.html", "y/Y.html", "z/Z.html"]);
  });
});

describe("fullScan — total & bad (AC6)", () => {
  it("total counts only .html files; bad sums the three category lengths", async () => {
    const kitStore = stubKitStore([
      { path: "a/Ok/Ok.html", content: `${MARKER}\n<div>fine</div>` }, // clean
      { path: "a/Ok/Ok.tsx", content: `export const Ok = () => null;` }, // not .html
      { path: "a/Ok/meta.json", content: `{"group":"actions"}` }, // not .html
      { path: "a/NoMark/NoMark.html", content: `<div>missing marker</div>` }, // markerMissing
      { path: "a/Thin/Thin.html", content: `${MARKER}\n<i>.</i>` }, // thin
    ]);
    const renderer = stubRenderer((html) => {
      if (html.includes("missing marker")) return { contentHeight: 300, image: IMAGE_A };
      if (html.includes("<i>.</i>")) return { contentHeight: 20, image: IMAGE_B };
      // The clean card must NOT cluster with the two above — use a top/bottom
      // split (distinct spatial orientation → far hash from both L/R splits).
      return { contentHeight: 300, image: stackImage([1, 2, 3, 255], [250, 240, 230, 255]) };
    });
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.total).toBe(3); // only the three .html files
    expect(res.markerMissing).toEqual(["a/NoMark/NoMark.html"]);
    expect(res.thin).toEqual(["a/Thin/Thin.html"]);
    expect(res.variantsIdentical).toEqual([]);
    // bad = 1 + 1 + 0 (AC6: sum of the three lengths, literal).
    expect(res.bad).toBe(2);
  });

  it("counts a path once per category even when it is both markerMissing and thin", async () => {
    const kitStore = stubKitStore([
      { path: "a/BadThin.html", content: `<div>no marker AND thin</div>` },
    ]);
    const renderer = stubRenderer(() => ({ contentHeight: 10, image: IMAGE_A }));
    const res = await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(res.markerMissing).toEqual(["a/BadThin.html"]);
    expect(res.thin).toEqual(["a/BadThin.html"]);
    // Same path in TWO lists → AC6's literal sum counts it twice.
    expect(res.bad).toBe(2);
  });
});

describe("fullScan — graceful degradation & robustness (AC7 env-gap)", () => {
  it("skips thin + variantsIdentical when the renderer is null, but still runs markerMissing", async () => {
    const kitStore = stubKitStore([
      { path: "a/Ok.html", content: `${MARKER}\n<div>x</div>` },
      { path: "a/Bad.html", content: `<div>no marker</div>` },
    ]);
    const res = await fullScan(deps({ kitStore, renderer: null }), { kitId: "k" });
    expect(res.markerMissing).toEqual(["a/Bad.html"]);
    expect(res.thin).toEqual([]);
    expect(res.variantsIdentical).toEqual([]);
    expect(res.total).toBe(2);
    expect(res.bad).toBe(1); // only markerMissing contributes
  });

  it("tolerates a per-file render failure without aborting the scan", async () => {
    const kitStore = stubKitStore([{ path: "a/Ok.html", content: `${MARKER}\n<div>x</div>` }]);
    // Renderer throws on every render — thin/variant can't be computed, but the
    // scan must still complete and report the marker result + total.
    const res = await fullScan(deps({ kitStore, renderer: throwingRenderer() }), {
      kitId: "k",
    });
    expect(res.markerMissing).toEqual([]);
    expect(res.thin).toEqual([]);
    expect(res.variantsIdentical).toEqual([]);
    expect(res.total).toBe(1);
    expect(res.bad).toBe(0);
  });

  it("tolerates a readFile failure by skipping that file", async () => {
    // listFiles advertises a file that readFile then can't return.
    const base = stubKitStore([{ path: "a/Ghost.html", content: "unused" }]);
    const kitStore: FullScanKitStore = {
      listFiles: base.listFiles,
      async readFile() {
        throw new Error("gone");
      },
    };
    const res = await fullScan(deps({ kitStore, renderer: stubRenderer(tallDistinct) }), {
      kitId: "k",
    });
    // Unreadable file is skipped entirely — not inspected, not counted.
    expect(res.total).toBe(0);
    expect(res.markerMissing).toEqual([]);
    expect(res.bad).toBe(0);
  });

  it("closes nothing itself — the caller owns the renderer lifecycle", async () => {
    // The orchestrator must NOT close a renderer it did not create (the tool
    // creates + closes one per scan). A stub that counts closes proves it.
    const kitStore = stubKitStore([{ path: "a/A.html", content: `${MARKER}\n<div>x</div>` }]);
    const renderer = stubRenderer(() => ({ contentHeight: 300, image: IMAGE_A }));
    await fullScan(deps({ kitStore, renderer }), { kitId: "k" });
    expect(renderer.closed).toBe(0);
  });

  it("returns an all-empty result for a kit with no .html files", async () => {
    const kitStore = stubKitStore([
      { path: "README.md", content: "# hi" },
      { path: "a/Ok/meta.json", content: "{}" },
    ]);
    const res = await fullScan(deps({ kitStore, renderer: stubRenderer(tallDistinct) }), {
      kitId: "k",
    });
    expect(res).toEqual({
      markerMissing: [],
      thin: [],
      variantsIdentical: [],
      total: 0,
      bad: 0,
    });
  });
});
