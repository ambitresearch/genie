/**
 * AC6 — proves `packages/server/src/validate/index.ts` publicly re-exports
 * the marker validator's full surface. Downstream consumers (M3-02/M3-03/
 * M3-04) import from this barrel, not from `./marker.js` directly; this test
 * is the regression guard that keeps the barrel in sync if `marker.ts` ever
 * grows a new export.
 */
import { describe, expect, it } from "vitest";

import {
  extractViewport,
  MARKER_REGEX,
  validateMarker,
  type MarkerValidationResult,
  type MarkerViewport,
} from "./index.js";

describe("validate/index.ts re-export barrel", () => {
  it("AC6: re-exports MARKER_REGEX", () => {
    expect(MARKER_REGEX).toBeInstanceOf(RegExp);
    expect(MARKER_REGEX.source).toBe('^<!--\\s*@genie\\s+group="[^"]*"[^>]*-->');
  });

  it("AC6: re-exports a working validateMarker", () => {
    expect(validateMarker("x.html", '<!-- @genie group="actions" -->')).toEqual({ ok: true });
    expect(validateMarker("x.html", "<div/>")).toEqual({
      ok: false,
      code: "MARKER_MISSING",
      path: "x.html",
    });
  });

  it("AC6: re-exports a working extractViewport", () => {
    expect(extractViewport('<!-- @genie group="actions" viewport="400x200" -->')).toEqual({
      width: 400,
      height: 200,
    });
  });

  it("AC6: re-exports the MarkerValidationResult and MarkerViewport types (IDE-only type check)", () => {
    // Copilot review, PR #142: `packages/server/tsconfig.json` excludes
    // `src/**/*.test.ts` (the repo-wide convention every package's tsconfig
    // follows), so `pnpm --filter @genie/server typecheck` never type-checks
    // this file — these assignments are only checked by an editor's TS
    // language server, not any CI gate. The runtime assertions are this
    // test's actual (and only enforced) regression guard: if a future change
    // dropped these type re-exports from the barrel, the import above would
    // start failing at the *type* level in an IDE, but this test would still
    // pass at runtime since the values themselves are untouched — so this is
    // a best-effort IDE nudge, not a CI-backed check.
    const ok: MarkerValidationResult = { ok: true };
    const viewport: MarkerViewport = { width: 1, height: 1 };
    expect(ok.ok).toBe(true);
    expect(viewport.width).toBe(1);
  });
});
