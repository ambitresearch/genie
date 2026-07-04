/**
 * M2-07 — strict Ajv validation for the structured LLM output that conjure
 * (M2-03) and refine (M2-04) receive from the configured OpenAI-compatible
 * endpoint via `response_format: { type: "json_schema", ... }`.
 *
 * The single public entry point is {@link validateComponent}. It's called
 * once per LLM completion, on the deserialised JSON payload the client got
 * back. On success it returns the payload typed as {@link ValidatedComponent}
 * (a compile-time re-typing — no reshape at runtime). On failure it throws
 * {@link SchemaValidationError} carrying the full Ajv `errors: ErrorObject[]`
 * so the retry path in M2-03/M2-04 can append the failure to the next prompt
 * and give the model exactly one chance to self-correct.
 *
 * Two-pass design (AC3 + AC4):
 *   1. Ajv strict-mode structural validation against `COMPONENT_SCHEMA`
 *      (M2-02). Catches missing fields, wrong types, bad path patterns, the
 *      "no <Name>.html preview" case, and the `manifestEntry.viewport`
 *      requirement.
 *   2. `@genie` first-line marker cross-check on every `<Name>/<Name>.html`
 *      preview file the (now shape-valid) payload contains. This is
 *      intentionally *not* modelled in the JSON Schema itself — a regex-on-a-
 *      sibling-field is exactly the kind of cross-field constraint Draft 7
 *      can't express, and pushing it into JSON Schema would force the same
 *      shallow-`$ref` shape M2-02 was carefully written to avoid (see
 *      `schema.ts` AC2 note).
 *
 * The schema is compiled exactly once, at module load (AC5) — Ajv compilation
 * is measurable per call and every LLM completion goes through this function,
 * so caching pays for itself immediately.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { COMPONENT_SCHEMA, type ValidatedComponent } from "./schema.js";
import { MARKER_REGEX } from "../validate/marker.js";

export type { ValidatedComponent } from "./schema.js";
export type { ErrorObject } from "ajv";

/**
 * AC4 — the canonical `@genie` first-line marker regex from
 * `docs/plan/00-decisions.md` §D-B. Every generated `<Name>.html` preview
 * must open with a comment matching this pattern so the manifest compiler
 * (M3-03) and the validate tool (M3-04) can register / verify the card
 * without re-parsing the component's JSX.
 *
 * M3-01 (DRO-257) landed the single source of truth for this pattern at
 * `packages/server/src/validate/marker.ts`'s `MARKER_REGEX`; this is now a
 * re-export alias, kept under its original M2-07 name for backwards
 * compatibility with existing consumers (this module's own cross-check
 * below, plus `packages/e2e/test/m2-generation.test.ts`) rather than forcing
 * every call site to rename in the same change that removes the duplicate
 * literal.
 */
export const MARKER_REGEX_M2_07 = MARKER_REGEX;

/**
 * Same selector as `COMPONENT_SCHEMA.properties.files.items.contains.pattern`
 * — the `<group>/<Name>/<Name>.html` self-consistency shape ("preview file
 * whose basename matches its containing directory"). Kept here as a compiled
 * `RegExp` so the cross-check pass in {@link validateComponent} doesn't
 * re-compile the pattern on every file iteration.
 *
 * The backreference `\1` locks the basename to the same PascalCase segment
 * as the enclosing directory — this is what makes `Button/Wrong.html` fail
 * schema-level AC5 but still lets `Button/Button.html` through. We reuse the
 * exact shape here so the schema's `contains` guarantee (at least one file
 * matches) and this cross-check (every matching file also has the `@genie`
 * marker) can never disagree about which files are "preview files".
 *
 * Exported (Copilot review, PR #136) so consumers outside this module that
 * need to identify "which files are actually preview files" — e.g.
 * `m2-generation.test.ts`'s AC5 assertions — share this exact definition
 * instead of re-deriving a looser one (`files[].path` also legally permits
 * non-preview `.html` basenames like `dark-mode.html` per `schema.ts`'s
 * `PATH_PATTERN`, which a naive `.endsWith(".html")` filter would wrongly
 * subject to the marker rule).
 */
export const NAMED_HTML_PATH = /^components\/[a-z0-9-]+\/([A-Z][A-Za-z0-9]{1,63})\/\1\.html$/;

/**
 * `Error` subclass thrown by {@link validateComponent} on structural or
 * marker-cross-check failure. Callers in M2-03/M2-04 catch this narrowly and
 * append `error.errors` to the next prompt — the retry loop is exactly one
 * round-trip, per DRO-254's "Out of Scope: auto-repair" note.
 *
 * `name` is set explicitly so `error.name === "SchemaValidationError"` works
 * even after ESM module boundaries strip the class identity (defensive
 * against `instanceof` foot-guns in vitest / workers).
 */
export class SchemaValidationError extends Error {
  /** Ajv-style structured errors; always non-empty when this is thrown. */
  readonly errors: ErrorObject[];

  constructor(message: string, errors: ErrorObject[]) {
    super(message);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

/**
 * AC2 + AC5 — one Ajv instance, compiled once, at module load. The `strict:
 * true` flag turns every unknown/ambiguous keyword into a *compile-time*
 * throw, so if `schema.ts` ever grows a typo (e.g. `additionalProperty`
 * instead of `additionalProperties`) the server refuses to boot rather than
 * silently letting malformed output through at runtime. `allErrors: true`
 * asks Ajv to keep validating past the first failure and return every
 * problem — critical for the "append failures to the prompt" retry loop,
 * which can only fix errors the model actually sees.
 */
const ajv = new Ajv({ strict: true, allErrors: true });
const validate: ValidateFunction<ValidatedComponent> =
  ajv.compile<ValidatedComponent>(COMPONENT_SCHEMA);

/**
 * AC1 — the module's sole export contract. Validates `output` against
 * `COMPONENT_SCHEMA` (M2-02) and the `@genie` marker convention (AC4). On
 * success returns `output` cast to {@link ValidatedComponent} — an assertion
 * of type, not a copy: callers get the exact same object identity back so
 * downstream `write_files` (M1-08) can pass it through without an extra
 * allocation per completion.
 *
 * @throws {SchemaValidationError} on any structural or marker failure. The
 *   thrown error's `errors` array holds Ajv `ErrorObject`s (schema-level
 *   failures) and/or synthetic `ErrorObject`s with `keyword: "@genie-marker"`
 *   (marker-level failures). Both live in the same array so M2-03/M2-04's
 *   retry prompt can serialise them uniformly.
 */
export function validateComponent(output: unknown): ValidatedComponent {
  // Pass 1 — Ajv structural validation. `validate` mutates `.errors` on the
  // ValidateFunction itself (Ajv's API quirk); snapshot into a local so a
  // concurrent second call from another async caller can't clobber it before
  // we've thrown.
  if (!validate(output)) {
    const errors = validate.errors ?? [];
    throw new SchemaValidationError(
      `LLM output failed COMPONENT_SCHEMA validation (${errors.length} error${
        errors.length === 1 ? "" : "s"
      }).`,
      // Defensive copy — a caller inspecting `.errors` shouldn't be able to
      // mutate the ValidateFunction's internal buffer through this handle.
      errors.map((e) => ({ ...e })),
    );
  }

  // At this point Ajv has narrowed `output` to `ValidatedComponent` via the
  // typed ValidateFunction type-guard return; `output` is the same object
  // identity the caller passed in.
  const component = output;

  // Pass 2 — @genie marker cross-check (AC4). Ajv can't express "field A
  // matches regex X on field B's first line", so this runs in plain code
  // against the (now shape-valid) file set. Collect every failure so the
  // retry prompt can name all of them at once, mirroring `allErrors: true`.
  const markerErrors: ErrorObject[] = [];
  for (let i = 0; i < component.files.length; i++) {
    const file = component.files[i]!;
    if (!NAMED_HTML_PATH.test(file.path)) {
      // Not a `<Name>/<Name>.html` preview — the schema's `contains`
      // guarantees at least one file *does* match, but non-preview files
      // (e.g. `Button.tsx`, `meta.json`) are exempt from the marker rule.
      continue;
    }
    // First line only (`\n` split limit=1 style, but done via indexOf to
    // avoid allocating the whole `split()` array on files that pass — the
    // vast majority in the steady state).
    const newlineAt = file.content.indexOf("\n");
    const firstLine = newlineAt === -1 ? file.content : file.content.slice(0, newlineAt);
    if (!MARKER_REGEX_M2_07.test(firstLine)) {
      markerErrors.push({
        keyword: "@genie-marker",
        instancePath: `/files/${i}/content`,
        schemaPath: "#/properties/files/items/content",
        params: {
          expected: MARKER_REGEX_M2_07.source,
          path: file.path,
        },
        message:
          `first line of ${file.path} does not match the @genie marker ` +
          `regex ${MARKER_REGEX_M2_07} (required for card registration)`,
      });
    }
  }

  if (markerErrors.length > 0) {
    throw new SchemaValidationError(
      `LLM output has ${markerErrors.length} @genie marker error${
        markerErrors.length === 1 ? "" : "s"
      } (structural schema OK, marker cross-check failed).`,
      markerErrors,
    );
  }

  return component;
}
