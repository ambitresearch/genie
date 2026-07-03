/**
 * COMPONENT_SCHEMA (M2-02) — the JSON Schema that {@link import("./client.js").createChatCompletion}
 * callers hand to the LLM as `response_format: { type: "json_schema", json_schema: COMPONENT_SCHEMA }`
 * from `conjure` (M2-03) and against which M2-07 validates the returned
 * message content before genie writes anything to disk.
 *
 * Draft 7 only (AC2): no `anyOf` discriminator pattern, no `$ref` chains
 * beyond a single hop, no `unevaluatedProperties` / `dependentSchemas`
 * (Draft 2019-09+). LiteLLM's structured-output passthrough to Anthropic
 * via tool-use is historically fragile on those shapes, and Anthropic's own
 * JSON-mode is Draft 7 flavoured — RFC §3.2 explicitly calls out the "may
 * not handle deep $ref chains" caveat.
 *
 * Top-level shape (AC3):
 *
 *   {
 *     componentName: string,           // e.g. "Button"      — PascalCase
 *     group: string,                    // e.g. "actions"    — kebab-case
 *     files: Array<{
 *       path: string,                   // components/<group>/<Name>/<file>  (AC4)
 *       content: string,                // the file body
 *       mimeType: string,               // "text/html", "text/x-tsx", …
 *     }>,
 *     manifestEntry: ManifestEntry,     // AC6
 *   }
 *
 * At least one entry in `files` must be a `<Name>.html` (AC5). The stricter
 * "content begins with `<!-- @genie group=\"…\" -->`" check is deliberately
 * NOT expressed in the schema — the M2-02 spec says "validated post-hoc by
 * M3-01". Two reasons: (1) Draft 7 pattern matching on a multi-line string
 * body against a marker anchored to line 1 gets unreadable fast, and (2)
 * the marker regex is M3-01's contract, not the LLM's — keeping it out of
 * this schema means the LLM sees the simpler shape it can most reliably
 * produce, and validation failures point at the right owner (M3-01) rather
 * than confusing "schema" errors that are really marker errors.
 *
 * ManifestEntry mirrors the fields the M3-03 manifest compiler ultimately
 * writes into `.genie/manifest.json`: `viewport: {width, height}` required
 * (AC6), `subtitle?: string`, `tags?: string[]`.
 *
 * Note on RFC §7.5 drift: the RFC captured an earlier iteration of this
 * shape (top-level `name`/`framework`, `viewport` and `subtitle` hoisted
 * out of manifestEntry, framework enum). The M2-02 issue's AC3/AC6 are
 * the newer, authoritative shape — this file follows the ACs; the RFC
 * update in this PR notes that §7.5 now defers to this module.
 */

import type { JSONSchema7 } from "json-schema";
import type { FromSchema } from "json-schema-to-ts";

// ─── Path pattern (AC4) ──────────────────────────────────────────────────────

/**
 * Regex source string constraining `files[].path` (AC4). Exported so tests
 * — and later the manifest compiler / write_files guard — can share the same
 * one pattern rather than re-typing it, which is exactly how the earlier
 * `@genie` marker regex ended up subtly different in two places before we
 * caught the drift.
 *
 *   components/<group>/<Name>/<filename>
 *   - <group> is kebab-case: `[a-z0-9-]+`
 *   - <Name>  is PascalCase: `[A-Z][A-Za-z0-9]+`
 *   - <filename> allows dots, underscores, dashes: `[A-Za-z0-9._-]+`
 */
export const COMPONENT_FILE_PATH_PATTERN =
  "^components/[a-z0-9-]+/[A-Z][A-Za-z0-9]+/[A-Za-z0-9._-]+$";

/**
 * Regex source string used inside the schema's `contains` clause to enforce
 * AC5's "at least one `<Name>.html`" — deliberately less specific than the
 * full path pattern above because Draft 7 has no way to reference a sibling
 * property (componentName) from inside `contains`. Any `<Pascal>.html`
 * satisfies it; that the filename matches `componentName` exactly is
 * covered by M3-01's post-hoc marker/name check, not the schema.
 */
export const COMPONENT_HTML_FILE_PATH_PATTERN =
  "^components/[a-z0-9-]+/[A-Z][A-Za-z0-9]+/[A-Z][A-Za-z0-9]+\\.html$";

// ─── Schema (AC1) ────────────────────────────────────────────────────────────

/**
 * The JSON Schema `conjure` demands from the model (AC1).
 *
 * Written as `as const satisfies JSONSchema7` so:
 *   1. `satisfies` gives us a compile-time guarantee this literal really is
 *      a valid Draft 7 schema shape (AC1/AC2), catching typos like
 *      `minimun` before they ship.
 *   2. `as const` narrows every string/number to its literal type, which is
 *      what {@link FromSchema} needs to infer the {@link GeneratedComponent}
 *      TS type below (AC7) — without it, `type: "object"` widens to `string`
 *      and FromSchema resolves to `unknown`.
 */
export const COMPONENT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://genie.local/schemas/component.schema.json",
  title: "GeneratedComponent",
  description:
    "The bundle a single conjure call must produce: componentName + group + files + manifestEntry.",
  type: "object",
  additionalProperties: false,
  required: ["componentName", "group", "files", "manifestEntry"],
  properties: {
    componentName: {
      type: "string",
      pattern: "^[A-Z][A-Za-z0-9]{0,63}$",
      description: "PascalCase component identifier — becomes the <Name> segment in files[].path.",
    },
    group: {
      type: "string",
      pattern: "^[a-z0-9-]{1,32}$",
      description: 'kebab-case grouping bucket, e.g. "actions", "forms".',
    },
    files: {
      type: "array",
      minItems: 1,
      // A component with 16+ files is almost certainly the model hallucinating
      // — bounded here (rather than deferred to a downstream size check) so
      // structured-output rejection triggers a retry before we've written
      // anything.
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "mimeType"],
        properties: {
          path: {
            type: "string",
            pattern: COMPONENT_FILE_PATH_PATTERN,
            minLength: 1,
            maxLength: 256,
            description: "Kit-root-relative path (AC4). Always begins components/<group>/<Name>/.",
          },
          content: {
            type: "string",
            minLength: 1,
            // 64 KiB per file — the same cap the RFC §7.5 draft used; well
            // above any realistic single component file, small enough that a
            // rogue mega-string can't blow the plan snapshot.
            maxLength: 65536,
          },
          mimeType: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: 'IANA media type, e.g. "text/html", "text/x-tsx".',
          },
        },
      },
      // AC5: at least one .html file. See COMPONENT_HTML_FILE_PATH_PATTERN
      // for why this is looser than "must equal componentName".
      contains: {
        type: "object",
        properties: {
          path: {
            type: "string",
            pattern: COMPONENT_HTML_FILE_PATH_PATTERN,
          },
        },
        required: ["path"],
      },
    },
    manifestEntry: {
      // AC6: viewport required; subtitle + tags optional. `additionalProperties: false`
      // so the LLM can't invent fields the manifest compiler wouldn't know
      // what to do with — extending this shape is a schema change, not a
      // silent contract widen.
      type: "object",
      additionalProperties: false,
      required: ["viewport"],
      properties: {
        viewport: {
          type: "object",
          additionalProperties: false,
          required: ["width", "height"],
          properties: {
            // Bounds match RFC §7.5's earlier draft — a viewport under
            // 200×100 or over 1600×1200 is a mistake, not a legitimate
            // component surface, so schema-rejecting it costs one retry
            // instead of a broken card in the grid.
            width: { type: "integer", minimum: 200, maximum: 1600 },
            height: { type: "integer", minimum: 100, maximum: 1200 },
          },
        },
        subtitle: { type: "string", maxLength: 256 },
        tags: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 32 },
          maxItems: 16,
        },
      },
    },
  },
} as const satisfies JSONSchema7;

// ─── Derived TS type (AC7) ───────────────────────────────────────────────────

/**
 * The TypeScript type for a valid COMPONENT_SCHEMA payload (AC7).
 *
 * Derived from the schema literal via `json-schema-to-ts`'s {@link FromSchema}
 * so the runtime schema and the compile-time type CANNOT drift apart — the
 * one thing that would otherwise silently break M2-07's "validate this typed
 * payload against this schema" contract.
 */
export type GeneratedComponent = FromSchema<typeof COMPONENT_SCHEMA>;
