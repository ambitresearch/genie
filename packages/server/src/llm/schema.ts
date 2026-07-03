/**
 * `COMPONENT_SCHEMA` (M2-02) — the JSON Schema `conjure`/`refine` (M2-03/M2-04)
 * demand from the model via `response_format: { type: "json_schema",
 * json_schema: COMPONENT_SCHEMA }`, and that M2-07's Ajv validation pass
 * (`validateComponent`) compiles against.
 *
 * Draft 7 only (AC2): no `anyOf`/`oneOf` discriminator pattern, and the only
 * `$ref` in the whole schema is a single level deep (`manifestEntry.viewport`
 * → `#/definitions/Viewport`, mirroring the RFC §9.20 shared-`$defs` shape).
 * LiteLLM's structured-output passthrough to Anthropic (via tool-use) is the
 * reason to keep nesting shallow — a deep `$ref` chain is exactly the shape
 * that passthrough has been observed not to handle reliably.
 *
 * `as const satisfies JSONSchema7` (AC1) does two jobs at once: `satisfies`
 * runs the object through `@types/json-schema`'s `JSONSchema7` shape so a
 * typo'd keyword (e.g. `additionalProperty` instead of `additionalProperties`)
 * is a compile error, while `as const` preserves the literal types `FromSchema`
 * (AC7) needs to actually infer `ValidatedComponent` below rather than widening
 * every string field to `string`.
 */

import type { JSONSchema7 } from "json-schema";
import type { FromSchema } from "json-schema-to-ts";

/**
 * AC4 — every `files[].path` must land under `components/<group>/<Name>/`,
 * matching the on-disk layout `write_files` (M1-08) ultimately writes to and
 * the `@genie`-marker registration convention (D-A/D-B). `<group>` is
 * `[a-z0-9-]+` (kebab-case, same shape as the top-level `group` field);
 * `<Name>` is `[A-Z][A-Za-z0-9]+` (PascalCase, same shape as `componentName`);
 * the file's own basename allows the broader `[A-Za-z0-9._-]+` (AC4's own
 * pattern) since it must cover `<Name>.tsx`, `<Name>.d.ts`, `<Name>.prompt.md`,
 * `<Name>.html`, and `meta.json` — five different suffix shapes — rather than
 * repeating `<Name>` a second time in the basename segment.
 */
const PATH_PATTERN = "^components/[a-z0-9-]+/[A-Z][A-Za-z0-9]+/[A-Za-z0-9._-]+$";

/**
 * AC5 — at least one `files[]` entry must be a `<Name>.html` file (the
 * `@genie`-marker carrier M3-01 later validates post-hoc). `contains` is the
 * Draft-7 keyword for "at least one array item matches this sub-schema" — it
 * does not require every item to match, unlike `items`. The pattern captures
 * the directory's `<Name>` segment and backreferences it against the
 * filename (`([A-Z][A-Za-z0-9]+)/\1\.html$`), so `Button/Button.html`
 * matches but a mismatched `Button/Wrong.html` does not — enforcing the same
 * `<Name>/<Name>.html` self-consistency the RFC's file-layout convention
 * assumes throughout (§7.3/§7.4/§9.10). It deliberately does NOT also check
 * the file's `content` for the literal `@genie` marker text — that
 * cross-field, regex-on-a-sibling-field check is exactly what M2-07's
 * `validateComponent` does as a second pass after schema validation (this
 * issue's AC5 note: "validated post-hoc by M3-01, not by the schema").
 */
const HTML_FILE_CONTAINS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      pattern: "^components/[a-z0-9-]+/([A-Z][A-Za-z0-9]{0,63})/\\1\\.html$",
    },
  },
} as const;

export const COMPONENT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://genie.dev/schema/component.schema.json",
  title: "GenieComponent",
  description:
    "The file set + manifest metadata conjure/refine demand from the configured " +
    "LLM endpoint via response_format.json_schema (M2-02).",
  type: "object",
  additionalProperties: false,
  // AC3 — top-level shape: { componentName, group, files, manifestEntry }.
  required: ["componentName", "group", "files", "manifestEntry"],
  // The only $ref in this schema, one level deep (AC2) — mirrors the shared
  // `Viewport` $def in RFC §9.20 rather than inlining width/height twice.
  definitions: {
    Viewport: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: 4096 },
        height: { type: "integer", minimum: 1, maximum: 4096 },
      },
    },
  },
  properties: {
    componentName: {
      type: "string",
      description: 'PascalCase component name, e.g. "Button".',
      // Same shape as the equivalent `name` field in RFC §7.1/§7.5
      // (manifest.json cards / the RFC's own COMPONENT_SCHEMA draft) — a
      // 1-64 char PascalCase identifier.
      pattern: "^[A-Z][A-Za-z0-9]{0,63}$",
    },
    group: {
      type: "string",
      description: 'Kebab-case UI-kit group/category, e.g. "actions".',
      pattern: "^[a-z0-9-]{1,32}$",
    },
    files: {
      type: "array",
      description:
        "The component's file set (e.g. <Name>.jsx, <Name>.tsx, <Name>.d.ts, " +
        "<Name>.prompt.md, <Name>.html, meta.json) — at least one must be a " +
        "<Name>.html preview file (AC5).",
      minItems: 1,
      maxItems: 12,
      contains: HTML_FILE_CONTAINS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "mimeType"],
        properties: {
          path: {
            type: "string",
            description: "Kit-relative path under components/<group>/<Name>/.",
            pattern: PATH_PATTERN,
          },
          content: {
            type: "string",
            description:
              "Full file contents (AC5: an <Name>.html entry's content " +
              "must begin with the @genie marker — checked post-hoc by M3-01/M2-07, " +
              "not by this schema).",
            minLength: 1,
            maxLength: 65536,
          },
          mimeType: {
            type: "string",
            description: 'MIME type of `content`, e.g. "text/html".',
            pattern: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$",
          },
        },
      },
    },
    manifestEntry: {
      type: "object",
      description:
        "Metadata the manifest compiler (M3-03) needs to add this card to " +
        ".genie/manifest.json without re-deriving it from the files themselves.",
      additionalProperties: false,
      // AC6 — viewport is required; subtitle/tags are optional.
      required: ["viewport"],
      properties: {
        viewport: { $ref: "#/definitions/Viewport" },
        subtitle: { type: "string", maxLength: 256 },
        tags: { type: "array", items: { type: "string" }, maxItems: 16 },
      },
    },
  },
} as const satisfies JSONSchema7;

/**
 * AC7 — TypeScript type inferred from {@link COMPONENT_SCHEMA} via
 * `json-schema-to-ts`, so the schema (not a hand-maintained interface) is the
 * single source of truth `conjure`/`refine`/`validateComponent` (M2-03/04/07)
 * import against.
 */
export type ValidatedComponent = FromSchema<typeof COMPONENT_SCHEMA>;
