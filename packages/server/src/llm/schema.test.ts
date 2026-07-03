/**
 * Tests for COMPONENT_SCHEMA (M2-02).
 *
 * The schema is only useful if BOTH sides — LLM-produced good payloads and
 * LLM-produced bad payloads — round-trip through the same validator
 * `conjure`/M2-07 will run at request time. We therefore validate with the
 * same Ajv Draft-07 setup the runtime will use (rather than eyeballing the
 * schema literal), and use `AC…` tags in test names so a failing test names
 * the acceptance criterion it maps to.
 *
 * The `known-bad` block covers each AC's own rejection surface individually
 * (bad path → AC4, no HTML file → AC5, missing top-level field → AC3, bad
 * viewport → AC6) so a regression that quietly widened any single AC would
 * surface here as one specific failing test — not a mystery in an omnibus.
 */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  COMPONENT_FILE_PATH_PATTERN,
  COMPONENT_HTML_FILE_PATH_PATTERN,
  COMPONENT_SCHEMA,
  type GeneratedComponent,
} from "./schema.js";

// ─── Ajv setup ───────────────────────────────────────────────────────────────

/**
 * Fresh Ajv instance per test file. `strict: false` so the schema's own
 * `$id`/`$schema` keywords don't cause an "unknown format" warning at
 * compile time; `allErrors: true` so assertions can see every reason a bad
 * fixture failed, not just the first one — useful when a single fixture
 * exercises multiple ACs at once.
 */
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(COMPONENT_SCHEMA);

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Canonical known-good payload — the exact shape `conjure` would produce
 * for a minimal Button. Every AC-relevant field is present and legal.
 * Deep-cloned inside each mutator below so tests never share mutation state.
 */
const KNOWN_GOOD: GeneratedComponent = {
  componentName: "Button",
  group: "actions",
  files: [
    {
      path: "components/actions/Button/Button.html",
      content:
        '<!-- @genie group="actions" viewport="desktop" -->\n<button class="btn">Click</button>\n',
      mimeType: "text/html",
    },
    {
      path: "components/actions/Button/Button.tsx",
      content: "export function Button(){return <button/>}\n",
      mimeType: "text/x-tsx",
    },
    {
      path: "components/actions/Button/Button.d.ts",
      content: "export declare function Button(): JSX.Element;\n",
      mimeType: "text/x-typescript",
    },
    {
      path: "components/actions/Button/Button.prompt.md",
      content:
        '{"props":["children","onClick"],"slots":["children"],"events":["onClick"]}\nA simple button.\n',
      mimeType: "text/markdown",
    },
    {
      path: "components/actions/Button/meta.json",
      content: '{"variant":"primary"}\n',
      mimeType: "application/json",
    },
  ],
  manifestEntry: {
    viewport: { width: 1440, height: 900 },
    subtitle: "Primary action button",
    tags: ["clickable", "primary"],
  },
};

/**
 * Deep-clone helper so a test that mutates a nested field (e.g. flipping
 * one `files[0].path` to a bad value) can't accidentally corrupt the shared
 * KNOWN_GOOD constant for subsequent tests. `structuredClone` is Node ≥ 17
 * built-in — this workspace requires Node ≥ 22.
 */
function clone(x: GeneratedComponent): GeneratedComponent {
  return structuredClone(x);
}

// ─── Known-good acceptance (AC1, AC2, AC3, AC5, AC6) ────────────────────────

describe("COMPONENT_SCHEMA — known-good acceptance", () => {
  it("validates a canonical Button payload (AC1, AC3, AC5, AC6)", () => {
    const ok = validate(KNOWN_GOOD);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("accepts manifestEntry with only the required viewport field (subtitle+tags omitted; AC6)", () => {
    // AC6 says subtitle and tags are OPTIONAL — a payload with just the
    // required viewport must validate. Regression guard against someone
    // moving them into `required`.
    const p = clone(KNOWN_GOOD);
    p.manifestEntry = { viewport: { width: 800, height: 600 } };
    expect(validate(p)).toBe(true);
  });

  it("is declared as JSON Schema Draft 7 (AC2)", () => {
    expect(COMPONENT_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("uses no Draft-2019+ keywords (no $ref chains beyond one hop, no anyOf discriminator; AC2)", () => {
    // A stringified-schema scan is cheap and catches the specific shapes
    // AC2 forbids without hand-crafting a Draft version detector.
    const serialised = JSON.stringify(COMPONENT_SCHEMA);
    expect(serialised).not.toContain('"unevaluatedProperties"');
    expect(serialised).not.toContain('"dependentSchemas"');
    expect(serialised).not.toContain('"$dynamicRef"');
    expect(serialised).not.toContain('"$dynamicAnchor"');
    // No `$ref` at all in v1 — every schema hop is inlined. If a future
    // change needs one it must land ≤1 hop deep AND update this test.
    expect(serialised).not.toContain('"$ref"');
    // No `anyOf` discriminator pattern anywhere — the RFC §3.2 caveat.
    expect(serialised).not.toContain('"anyOf"');
  });
});

// ─── Known-bad rejection — three distinct failure modes ─────────────────────

describe("COMPONENT_SCHEMA — known-bad rejection", () => {
  it("rejects a files[].path that violates the AC4 pattern", () => {
    const bad = clone(KNOWN_GOOD);
    // "widgets" isn't "components/…" — off the AC4 pattern entirely.
    bad.files[0]!.path = "widgets/actions/Button/Button.html" as never;
    expect(validate(bad)).toBe(false);
    expect(
      validate.errors?.some((e) => e.keyword === "pattern" && e.instancePath.includes("path")),
    ).toBe(true);
  });

  it("rejects when no <Name>.html file is present (AC5)", () => {
    const bad = clone(KNOWN_GOOD);
    // Strip the only .html entry — the surviving files are all valid
    // individually, so the failure MUST come from the top-level
    // `files.contains` clause (AC5), not from any per-item rule.
    bad.files = bad.files.filter((f) => !f.path.endsWith(".html")) as never;
    expect(validate(bad)).toBe(false);
    expect(
      validate.errors?.some((e) => e.keyword === "contains" && e.instancePath === "/files"),
    ).toBe(true);
  });

  it("rejects a payload missing the top-level componentName (AC3)", () => {
    const bad = clone(KNOWN_GOOD) as Partial<GeneratedComponent>;
    delete bad.componentName;
    expect(validate(bad)).toBe(false);
    expect(
      validate.errors?.some(
        (e) => e.keyword === "required" && e.params["missingProperty"] === "componentName",
      ),
    ).toBe(true);
  });

  // Additional rejection surfaces beyond the 3-fixture minimum in the spec —
  // each pins one AC edge that would otherwise silently widen if regressed.

  it("rejects a manifestEntry viewport whose width is below the minimum (AC6)", () => {
    const bad = clone(KNOWN_GOOD);
    bad.manifestEntry.viewport = { width: 10, height: 900 };
    expect(validate(bad)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "minimum")).toBe(true);
  });

  it("rejects a componentName that isn't PascalCase (AC3)", () => {
    const bad = clone(KNOWN_GOOD);
    bad.componentName = "button" as never; // lowercase leading
    expect(validate(bad)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "pattern")).toBe(true);
  });

  it("rejects unknown top-level properties (additionalProperties: false)", () => {
    // Regression guard: if additionalProperties were widened, the LLM could
    // invent fields the manifest compiler wouldn't know how to consume and
    // we'd silently drop them without warning.
    const bad = clone(KNOWN_GOOD) as GeneratedComponent & Record<string, unknown>;
    bad.hallucinatedField = "surprise";
    expect(validate(bad)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "additionalProperties")).toBe(true);
  });

  it("rejects an empty files array (AC5 implies at least one HTML — so at least one file)", () => {
    const bad = clone(KNOWN_GOOD);
    bad.files = [] as never;
    expect(validate(bad)).toBe(false);
  });
});

// ─── Pattern export self-check ──────────────────────────────────────────────

describe("exported regex sources", () => {
  it("COMPONENT_FILE_PATH_PATTERN matches a canonical good path and rejects one that isn't kit-rooted", () => {
    const good = new RegExp(COMPONENT_FILE_PATH_PATTERN);
    expect(good.test("components/actions/Button/Button.html")).toBe(true);
    expect(good.test("Button.html")).toBe(false);
    expect(good.test("components/Actions/Button/Button.html")).toBe(false); // group must be lowercase
    expect(good.test("components/actions/button/button.html")).toBe(false); // name must be PascalCase
  });

  it("COMPONENT_HTML_FILE_PATH_PATTERN matches any .html under the same prefix, not other extensions", () => {
    const html = new RegExp(COMPONENT_HTML_FILE_PATH_PATTERN);
    expect(html.test("components/actions/Button/Button.html")).toBe(true);
    expect(html.test("components/actions/Button/Button.tsx")).toBe(false);
    expect(html.test("components/actions/Button/index.html")).toBe(false); // filename must be PascalCase
  });
});
