/**
 * Tests for M3-01's `@genie` first-line marker validator
 * (`packages/server/src/validate/marker.ts`).
 *
 * Covers every AC on DRO-257:
 *   - AC1 — the module exports `MARKER_REGEX` and `validateMarker(path, content)`.
 *   - AC2 — `MARKER_REGEX.source` is exactly the canonical pattern.
 *   - AC3 — fixture matrix: at least 5 good, 5 bad first lines.
 *   - AC4 — `validateMarker` returns `{ ok: true }` or `{ ok: false, code:
 *     "MARKER_MISSING", path }`.
 *   - AC5 — `extractViewport` parses `viewport="WxH"` into `{ width, height }`
 *     integers, and returns `undefined` when absent or non-numeric.
 *   - AC6 — covered by `index.test.ts` (the public re-export barrel).
 */
import { describe, expect, it } from "vitest";

import { extractViewport, MARKER_REGEX, validateMarker } from "./marker.js";

describe("MARKER_REGEX", () => {
  it('AC2: is exactly the canonical /^<!--\\s*@genie\\s+group="[^"]*"[^>]*-->/ pattern', () => {
    expect(MARKER_REGEX.source).toBe('^<!--\\s*@genie\\s+group="[^"]*"[^>]*-->');
  });

  it("matches the reference example from the design mock (ref-genie-card.svg)", () => {
    // docs/designs/design-6/ref-genie-card.svg's own annotated marker line —
    // the exact text the "@genie anatomy" reference card shows next to this
    // regex. Pinning it here ties the implementation directly back to the
    // Design Reference the issue names, without needing a rendered screenshot
    // (this module has no UI surface of its own to screenshot).
    expect(MARKER_REGEX.test('<!-- @genie group="actions" viewport="320x96" -->')).toBe(true);
  });
});

describe("validateMarker", () => {
  // ─── AC3/AC4 — good first lines (≥ 5) ───────────────────────────────────

  it.each([
    ["minimal marker", '<!-- @genie group="actions" -->'],
    [
      "marker with viewport + extra attrs after group",
      '<!-- @genie group="forms-inputs" viewport="400x200" name="TextField" -->',
    ],
    ["no space after the comment-open token", '<!--@genie group="actions"-->'],
    [
      "extra internal whitespace between @genie and group",
      '<!--   @genie    group="ui-kit-nav" -->',
    ],
    ["empty (but present) group value", '<!-- @genie group="" -->'],
    ["marker followed by markup on the same line", '<!-- @genie group="cards" --><div>x</div>'],
    [
      "marker is the first line; markup follows on subsequent lines",
      '<!-- @genie group="cards" -->\n<div class="card">hi</div>',
    ],
  ])("accepts: %s", (_label, content) => {
    expect(validateMarker("components/actions/Button/Button.html", content)).toEqual({
      ok: true,
    });
  });

  // ─── AC3/AC4 — bad first lines (≥ 5) ────────────────────────────────────

  it.each([
    ["no marker at all", "<div>no marker</div>"],
    [
      // CLAUDE.md hard rule 1 / AGENTS.md hard rule 1: the Anthropic @dsCard
      // shape is interop-only and must NEVER satisfy genie's native marker.
      "Anthropic's @dsCard shape (interop-only, must not match)",
      '<!-- @dsCard group="actions" -->',
    ],
    ["missing the group attribute entirely", "<!-- @genie -->"],
    ["unquoted group value", "<!-- @genie group=actions -->"],
    [
      "marker present but not on the first line",
      '<!doctype html>\n<!-- @genie group="actions" -->',
    ],
    ["missing the opening <!-- comment token", '@genie group="actions" -->'],
    ["empty file content", ""],
    ["missing the closing --> token", '<!-- @genie group="actions"'],
  ])("rejects: %s", (_label, content) => {
    expect(validateMarker("components/actions/Button/Button.html", content)).toEqual({
      ok: false,
      code: "MARKER_MISSING",
      path: "components/actions/Button/Button.html",
    });
  });

  // ─── AC4 — result shape / path passthrough ──────────────────────────────

  it("AC4: echoes the exact path back on failure, for a batch caller to report", () => {
    const result = validateMarker("components/forms-inputs/TextField/TextField.html", "<div/>");
    expect(result).toEqual({
      ok: false,
      code: "MARKER_MISSING",
      path: "components/forms-inputs/TextField/TextField.html",
    });
  });

  it("AC4: success result carries no extra fields beyond { ok: true }", () => {
    const result = validateMarker("x.html", '<!-- @genie group="g" -->');
    expect(Object.keys(result)).toEqual(["ok"]);
  });

  // ─── Edge cases beyond the AC3 minimum ──────────────────────────────────

  it("only inspects the first line — a bad second line does not fail a good first line", () => {
    const content = '<!-- @genie group="actions" -->\n<!-- @dsCard group="actions" -->';
    expect(validateMarker("x.html", content)).toEqual({ ok: true });
  });

  it("tolerates a CRLF line ending on the marker line", () => {
    const content = '<!-- @genie group="actions" -->\r\n<button>Click</button>';
    expect(validateMarker("x.html", content)).toEqual({ ok: true });
  });

  it("rejects a marker preceded by a byte-order mark (no longer the true first byte)", () => {
    const content = '﻿<!-- @genie group="actions" -->';
    expect(validateMarker("x.html", content)).toEqual({
      ok: false,
      code: "MARKER_MISSING",
      path: "x.html",
    });
  });
});

describe("extractViewport", () => {
  // ─── AC5 ─────────────────────────────────────────────────────────────────

  it('extracts width/height integers from a viewport="WxH" attribute', () => {
    expect(extractViewport('<!-- @genie group="actions" viewport="400x200" -->')).toEqual({
      width: 400,
      height: 200,
    });
  });

  it("finds viewport regardless of attribute order (after other attrs)", () => {
    expect(
      extractViewport(
        '<!-- @genie group="actions" name="Button" viewport="375x812" subtitle="x" -->',
      ),
    ).toEqual({ width: 375, height: 812 });
  });

  it("returns integers, not strings", () => {
    const viewport = extractViewport('<!-- @genie group="actions" viewport="1024x768" -->');
    expect(viewport?.width).toBe(1024);
    expect(viewport?.height).toBe(768);
    expect(Number.isInteger(viewport?.width)).toBe(true);
    expect(Number.isInteger(viewport?.height)).toBe(true);
  });

  it("returns undefined when there is no viewport attribute", () => {
    expect(extractViewport('<!-- @genie group="actions" -->')).toBeUndefined();
  });

  it("returns undefined for a non-numeric (named) viewport token", () => {
    expect(extractViewport('<!-- @genie group="actions" viewport="desktop" -->')).toBeUndefined();
  });

  it("returns undefined when the line has no marker at all", () => {
    expect(extractViewport("<div>no marker</div>")).toBeUndefined();
  });

  it("handles small and large dimension values", () => {
    expect(extractViewport('<!-- @genie group="a" viewport="1x1" -->')).toEqual({
      width: 1,
      height: 1,
    });
    expect(extractViewport('<!-- @genie group="a" viewport="3840x2160" -->')).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it("does not mistake a hyphenated attribute ending in 'viewport' for the real one", () => {
    // A plain \b-bordered match would fire on the hyphen in "data-viewport"
    // too (word boundary before "v"); genie's marker convention has no such
    // attribute, so this must stay undefined, not silently extract 999x999.
    expect(extractViewport('<!-- @genie group="a" data-viewport="999x999" -->')).toBeUndefined();
  });
});
