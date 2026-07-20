/**
 * M3-01 (DRO-257) — genie's own first-line `@genie` marker validator.
 *
 * This is genie's **registration contract** for a component preview file:
 * every `<Name>.html` / `preview.html`
 * must open with a comment matching {@link MARKER_REGEX}, e.g.
 *
 *   <!-- @genie group="actions" viewport="400x200" -->
 *
 * A missing or malformed first line fails the build with `MARKER_MISSING`
 * (AC4). The regex intentionally permits arbitrary additional attributes
 * after `group` — `viewport`, `name`, `subtitle`, … — so {@link
 * validateMarker} accepts any of them without needing to enumerate the full
 * attribute set; {@link extractViewport} is the one attribute the manifest
 * compiler (M3-03) and `list_components` (M1-15) need decomposed into
 * `{ width, height }` integers (AC5), so it gets its own narrow helper
 * rather than a general attribute parser.
 *
 * This module is pure and offline — no filesystem, no network — so both
 * `KitStore` adapters (local FS, git host) and the future watcher (M3-02) /
 * manifest compiler (M3-03) / `validate` full-scan facet (M3-04) can call it
 * against whatever bytes they already have in hand.
 *
 * `MARKER_REGEX` is genie's **native** marker — do not substitute Anthropic's
 * `@dsCard` shape here (CLAUDE.md hard rule 1 / AGENTS.md hard rule 1); that
 * regex lives only in a future opt-in interop adapter.
 */

/**
 * AC2 — the canonical `@genie` first-line marker regex. This is the single source of truth for the
 * pattern: `../llm/validate.ts`'s `MARKER_REGEX_M2_07` re-exports this
 * constant (it previously carried its own temporary duplicate literal,
 * shipped ahead of this issue landing) rather than redefining it.
 *
 * Deliberately permissive after `group="…"`: `[^>]*` allows any further
 * attributes (`viewport`, `name`, `subtitle`, …) in any order, so adding a
 * new optional attribute to the marker convention never requires touching
 * this regex.
 */
export const MARKER_REGEX = /^<!--\s*@genie\s+group="[^"]*"[^>]*-->/;

/** Discriminated-union result of {@link validateMarker} (AC4). */
export type MarkerValidationResult =
  | { ok: true }
  | { ok: false; code: "MARKER_MISSING"; path: string };

/**
 * AC1/AC4 — validate that `content`'s first line carries genie's `@genie`
 * marker. `path` is carried through into the failure result (not used for
 * validation itself) so a caller batching many files can report exactly
 * which one failed, matching the `[MARKER_MISSING] <relpath>` build-failure
 * shape the `ERR_MARKER_MISSING` contract describes.
 *
 * Uses `content.split("\n", 1)[0]` per the spec's implementation note — the
 * `limit` argument means `split` stops after producing one element, so this
 * never allocates an array for the rest of the file. A trailing `\r` (CRLF
 * line endings) stays attached to that first element; `MARKER_REGEX` has no
 * trailing anchor, so a `\r` after the marker's `-->` does not affect the
 * match (verified by the CRLF fixture in `marker.test.ts`).
 */
export function validateMarker(path: string, content: string): MarkerValidationResult {
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (MARKER_REGEX.test(firstLine)) {
    return { ok: true };
  }
  return { ok: false, code: "MARKER_MISSING", path };
}

/** Integer `{ width, height }` pair extracted from a marker's `viewport` attribute (AC5). */
export interface MarkerViewport {
  width: number;
  height: number;
}

/**
 * AC5 — optional attribute parse: extract `viewport="WxH"` from a marker
 * line into a structured `{ width, height }` (both integers). Returns
 * `undefined` when the line has no `viewport` attribute, or its value isn't
 * the strict `<digits>x<digits>` shape (e.g. a named token like `"desktop"`
 * — `list_components`/the manifest compiler keep that case as an opaque
 * string rather than a decomposed size).
 *
 * Deliberately independent of {@link validateMarker}: a caller can ask "does
 * this line have a parseable viewport" without first requiring the whole
 * marker to be well-formed, and the manifest compiler (M3-03) needs this
 * extraction on its own, already-validated lines.
 *
 * The `(?:^|\s)` lookbehind-by-alternation requires `viewport` to start a
 * fresh attribute (preceded by whitespace, or the very start of the string)
 * rather than merely `\b`-bordering the previous character — `\b` alone
 * would also fire mid-token on a hyphen (e.g. a hypothetical `data-viewport`
 * attribute), which is not part of genie's marker convention and must not be
 * mistaken for it.
 */
export function extractViewport(firstLine: string): MarkerViewport | undefined {
  const match = /(?:^|\s)viewport="(\d+)x(\d+)"/.exec(firstLine);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}
