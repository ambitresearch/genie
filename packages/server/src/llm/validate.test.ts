/**
 * Tests for M2-07's `validateComponent` (`packages/server/src/llm/validate.ts`).
 *
 * Covers every AC on DRO-254:
 *   - AC1 — the module exports `validateComponent(unknown) → ValidatedComponent`.
 *   - AC2 — Ajv is `{ strict: true, allErrors: true }` (asserted by observing
 *     that a payload with N distinct problems produces N errors, not 1).
 *   - AC3 — failure throws {@link SchemaValidationError} with `errors:
 *     ErrorObject[]` populated.
 *   - AC4 — the `@genie` first-line regex cross-check fires on every
 *     `<Name>/<Name>.html` preview file in the payload.
 *   - AC5 — the schema compiles once at module load (asserted by measuring
 *     that a second call is O(µs), not O(ms) — see the "compile-once" test).
 *   - AC6 — fixture matrix: 3 valid + 5 invalid, one row per failure mode
 *     enumerated in the issue (missing field, wrong type, bad path pattern,
 *     missing `@genie` marker, `manifestEntry` without `viewport`).
 *
 * The schema itself has its own exhaustive test in `schema.test.ts`; this
 * suite exercises the *wrapper* — throw shape, error typing, marker cross-
 * check, and the compile-once contract — not the schema's field rules.
 */

import { describe, expect, it } from "vitest";

import {
  MARKER_REGEX_M2_07,
  SchemaValidationError,
  validateComponent,
  type ValidatedComponent,
} from "./validate.js";

/**
 * Base valid fixture. Every "invalid" test mutates a fresh copy of this
 * (rather than reusing the same instance across tests) so a failed test can't
 * leak state into the next one via shared object references.
 */
function goodFixture(): ValidatedComponent {
  return {
    componentName: "Button",
    group: "actions",
    files: [
      {
        path: "components/actions/Button/Button.tsx",
        content: "export default function Button() { return null; }",
        mimeType: "text/tsx",
      },
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->\n<button>Click me</button>',
        mimeType: "text/html",
      },
      {
        path: "components/actions/Button/meta.json",
        content: '{"group":"actions","viewport":{"width":400,"height":200}}',
        mimeType: "application/json",
      },
    ],
    manifestEntry: {
      viewport: { width: 400, height: 200 },
      subtitle: "Primary action button",
      tags: ["actions", "core"],
    },
  };
}

describe("validateComponent (M2-07)", () => {
  // ─── AC1 — surface ────────────────────────────────────────────────────────

  it("AC1: exports a callable validateComponent(unknown) → ValidatedComponent", () => {
    expect(validateComponent).toBeTypeOf("function");
    // The function is unary — Ajv's own `.length` on the compiled validator is 1,
    // but we care about the *wrapper's* arity: exactly one `output: unknown`.
    expect(validateComponent.length).toBe(1);
  });

  // ─── AC6 — 3 valid fixtures ───────────────────────────────────────────────

  it("AC6: valid #1 — minimal manifestEntry (viewport only, no subtitle/tags)", () => {
    const fixture = goodFixture();
    fixture.manifestEntry = { viewport: { width: 320, height: 240 } };
    // Return-value contract: the exact same object identity comes back
    // (no reshape, no clone) so `write_files` downstream can consume it
    // without an extra allocation per LLM completion.
    const returned = validateComponent(fixture);
    expect(returned).toBe(fixture);
  });

  it("AC6: valid #2 — full manifestEntry with subtitle + tags", () => {
    const fixture = goodFixture();
    const returned = validateComponent(fixture);
    expect(returned.manifestEntry.subtitle).toBe("Primary action button");
    expect(returned.manifestEntry.tags).toEqual(["actions", "core"]);
  });

  it("AC6: valid #3 — multi-suffix file set (.tsx + .html + .json + .prompt.md + .d.ts)", () => {
    const fixture: ValidatedComponent = {
      componentName: "TextField",
      group: "forms-inputs",
      files: [
        {
          path: "components/forms-inputs/TextField/TextField.tsx",
          content: "export default function TextField() {}",
          mimeType: "text/tsx",
        },
        {
          path: "components/forms-inputs/TextField/TextField.d.ts",
          content: "declare function TextField(): JSX.Element;",
          mimeType: "text/typescript",
        },
        {
          path: "components/forms-inputs/TextField/TextField.prompt.md",
          content: "# TextField\nMultiline input prompt.",
          mimeType: "text/markdown",
        },
        {
          path: "components/forms-inputs/TextField/TextField.html",
          content: '<!-- @genie group="forms-inputs" viewport="600x120" -->\n<input>',
          mimeType: "text/html",
        },
        {
          path: "components/forms-inputs/TextField/meta.json",
          content: '{"group":"forms-inputs"}',
          mimeType: "application/json",
        },
      ],
      manifestEntry: {
        viewport: { width: 600, height: 120 },
        tags: ["forms"],
      },
    };
    expect(() => validateComponent(fixture)).not.toThrow();
  });

  // ─── AC6 — 5 invalid fixtures, one per enumerated failure mode ───────────

  it("AC6: invalid #1 (missing field) — top-level `componentName` absent", () => {
    const fixture = goodFixture() as Record<string, unknown>;
    delete fixture.componentName;
    expect(() => validateComponent(fixture)).toThrow(SchemaValidationError);
    try {
      validateComponent(fixture);
    } catch (e) {
      // AC3 — errors is an ErrorObject[] with the failing path identified.
      expect(e).toBeInstanceOf(SchemaValidationError);
      const err = e as SchemaValidationError;
      expect(err.errors.length).toBeGreaterThan(0);
      // Ajv's `required` violation surfaces on the parent's `instancePath`
      // with `params.missingProperty` = "componentName".
      expect(
        err.errors.some(
          (o) =>
            o.keyword === "required" &&
            (o.params as { missingProperty?: string }).missingProperty === "componentName",
        ),
      ).toBe(true);
    }
  });

  it("AC6: invalid #2 (wrong type) — `files` is a string, not an array", () => {
    const fixture = { ...goodFixture(), files: "not-an-array" };
    expect(() => validateComponent(fixture)).toThrow(SchemaValidationError);
    try {
      validateComponent(fixture);
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err.errors.some((o) => o.keyword === "type")).toBe(true);
    }
  });

  it("AC6: invalid #3 (bad path pattern) — `files[0].path` uses uppercase group", () => {
    const fixture = goodFixture();
    fixture.files[0]!.path = "components/Actions/Button/Button.tsx";
    expect(() => validateComponent(fixture)).toThrow(SchemaValidationError);
    try {
      validateComponent(fixture);
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err.errors.some((o) => o.keyword === "pattern")).toBe(true);
    }
  });

  it("AC6: invalid #4 (missing @genie) — Button.html present but first line isn't a marker", () => {
    const fixture = goodFixture();
    // Replace the good `<!-- @genie ... -->\n<button>` first line with a
    // plausible-but-wrong opener (no marker comment).
    fixture.files[1]!.content = "<button>Click me — but I forgot my marker</button>";
    expect(() => validateComponent(fixture)).toThrow(SchemaValidationError);
    try {
      validateComponent(fixture);
    } catch (e) {
      const err = e as SchemaValidationError;
      // Marker failures use the synthetic `@genie-marker` keyword so the
      // retry prompt can distinguish them from schema failures.
      expect(err.errors.some((o) => o.keyword === "@genie-marker")).toBe(true);
      expect(err.errors[0]!.instancePath).toBe("/files/1/content");
    }
  });

  it("AC6: invalid #5 (manifestEntry without viewport) — {} passed for manifestEntry", () => {
    const fixture = goodFixture();
    fixture.manifestEntry = {} as ValidatedComponent["manifestEntry"];
    expect(() => validateComponent(fixture)).toThrow(SchemaValidationError);
    try {
      validateComponent(fixture);
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(
        err.errors.some(
          (o) =>
            o.keyword === "required" &&
            (o.params as { missingProperty?: string }).missingProperty === "viewport",
        ),
      ).toBe(true);
    }
  });

  // ─── AC2 — allErrors: true is actually on ────────────────────────────────

  it("AC2: allErrors:true — a payload with THREE distinct failures surfaces >= 3 errors", () => {
    // Missing componentName + wrong-type group + bad file path all at once.
    // If `allErrors` were false, Ajv would short-circuit after the first,
    // and `err.errors.length` would be 1.
    const fixture: Record<string, unknown> = {
      // componentName intentionally missing.
      group: 42, // wrong type — expected string.
      files: [
        {
          path: "not/a/valid/path.tsx", // pattern violation.
          content: "x",
          mimeType: "text/plain",
        },
        // Also missing the required <Name>.html preview — `contains` failure.
      ],
      manifestEntry: { viewport: { width: 100, height: 100 } },
    };
    try {
      validateComponent(fixture);
      throw new Error("validateComponent should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
      const err = e as SchemaValidationError;
      expect(err.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  // ─── AC3 — SchemaValidationError shape ───────────────────────────────────

  it("AC3: SchemaValidationError has stable .name, is Error-shaped, and errors[] is copied not aliased", () => {
    const fixture = goodFixture() as Record<string, unknown>;
    delete fixture.componentName;
    try {
      validateComponent(fixture);
      throw new Error("validateComponent should have thrown");
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SchemaValidationError);
      // `.name` set explicitly so cross-realm code can key on it without
      // relying on `instanceof` (which breaks across ESM realm boundaries).
      expect(err.name).toBe("SchemaValidationError");
      expect(err.message).toMatch(/COMPONENT_SCHEMA validation/);
      expect(Array.isArray(err.errors)).toBe(true);
      // Defensive-copy contract: mutating the exposed array must not corrupt
      // Ajv's internal validator state for the *next* call.
      const originalLength = err.errors.length;
      err.errors.length = 0;
      // A subsequent call with the SAME broken fixture should still yield
      // errors — proving `.errors` was a copy, not a live handle into Ajv.
      try {
        validateComponent(fixture);
      } catch (e2) {
        const err2 = e2 as SchemaValidationError;
        expect(err2.errors.length).toBe(originalLength);
      }
    }
  });

  // ─── AC4 — @genie cross-check details ────────────────────────────────────

  it('AC4: marker regex is exactly the canonical /^<!--\\s*@genie\\s+group="[^"]*"[^>]*-->/', () => {
    expect(MARKER_REGEX_M2_07.source).toBe('^<!--\\s*@genie\\s+group="[^"]*"[^>]*-->');
  });

  it("AC4: marker check tolerates additional attributes after `group` (viewport/name/subtitle)", () => {
    const fixture = goodFixture();
    fixture.files[1]!.content =
      '<!-- @genie group="actions" viewport="400x200" name="Button" -->\n<button>x</button>';
    expect(() => validateComponent(fixture)).not.toThrow();
  });

  it("AC4: marker check runs on EVERY <Name>/<Name>.html file in the payload, not just the first", () => {
    // Two preview files: one good, one bad. `contains` in the schema only
    // needs at least one match, so the schema pass is fine — but the cross-
    // check pass must still flag the second file's missing marker.
    const fixture: ValidatedComponent = {
      componentName: "Button",
      group: "actions",
      files: [
        {
          path: "components/actions/Button/Button.html",
          content: '<!-- @genie group="actions" -->\n<button>ok</button>',
          mimeType: "text/html",
        },
        // A second preview file — synthetic, but a real fixture the LLM
        // might produce if asked for size variants. Its marker is missing.
        {
          path: "components/actions/Icon/Icon.html",
          content: "<svg>no marker</svg>",
          mimeType: "text/html",
        },
      ],
      manifestEntry: { viewport: { width: 100, height: 100 } },
    };
    try {
      validateComponent(fixture);
      throw new Error("validateComponent should have thrown");
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err.errors.length).toBe(1);
      expect(err.errors[0]!.keyword).toBe("@genie-marker");
      expect(err.errors[0]!.instancePath).toBe("/files/1/content");
      expect((err.errors[0]!.params as { path: string }).path).toBe(
        "components/actions/Icon/Icon.html",
      );
    }
  });

  it("AC4: marker check is scoped to <Name>/<Name>.html — a non-preview .html filename is not marker-checked", () => {
    // Contrived: the schema's file-path pattern permits any [A-Za-z0-9._-]+
    // basename under `<group>/<Name>/`, so a file at
    // `components/actions/Button/notes.html` is shape-legal but is NOT the
    // preview file. Marker-checking it would over-fire — the point of AC4 is
    // "the preview card carries the marker so M3-01 can register it," not
    // "every .html asset must be a marker file." Test that the scoping
    // pattern (same `<Name>/<Name>.html` self-reference the schema uses)
    // excludes this case.
    const fixture: ValidatedComponent = {
      componentName: "Button",
      group: "actions",
      files: [
        {
          path: "components/actions/Button/Button.html",
          content: '<!-- @genie group="actions" -->\n<button>ok</button>',
          mimeType: "text/html",
        },
        {
          path: "components/actions/Button/notes.html",
          // Deliberately no marker — this file isn't a preview, so it's exempt.
          content: "<p>internal notes, not a card</p>",
          mimeType: "text/html",
        },
      ],
      manifestEntry: { viewport: { width: 100, height: 100 } },
    };
    expect(() => validateComponent(fixture)).not.toThrow();
  });

  // ─── AC5 — schema compiled once at module load ───────────────────────────

  it("AC5: schema compiled once at module load — the 2nd call is essentially free (µs, not ms)", () => {
    // Ajv `.compile()` runs O(ms) on a schema this size (measured ~5-15ms
    // locally); a compiled `validate()` call runs O(µs) (<100µs). If the
    // wrapper accidentally re-compiled per call, the 2nd validation would
    // still take milliseconds. We call it many times to smooth out timer
    // noise and assert the amortised per-call cost is well below 1ms.
    const fixture = goodFixture();
    // Warm up once (any lazy paths in Ajv's runtime, GC, etc.).
    validateComponent(fixture);
    const N = 200;
    const start = performance.now();
    for (let i = 0; i < N; i++) validateComponent(fixture);
    const elapsedMs = performance.now() - start;
    const perCallMs = elapsedMs / N;
    // 1ms/call is a generous ceiling — real numbers should be one or two
    // orders of magnitude below this. Anything at or above 1ms/call means
    // we're recompiling.
    expect(perCallMs).toBeLessThan(1);
  });

  // ─── ergonomics for M2-03/M2-04 retry path ───────────────────────────────

  it("returns the exact same object identity on success (no reshape)", () => {
    const fixture = goodFixture();
    const returned = validateComponent(fixture);
    expect(returned).toBe(fixture);
    // Type narrowing: the return is typed as ValidatedComponent, so this
    // property access is now compile-checked (a smoke check that AC7's
    // FromSchema typing from schema.ts flowed through correctly).
    expect(returned.componentName).toBe("Button");
  });

  it("rejects a completely non-object payload with a structured error, not a TypeError", () => {
    for (const junk of [null, undefined, 42, "a string", [], true]) {
      // Every one of these should route through the SchemaValidationError
      // path, NOT bubble a TypeError from Ajv's internals — the retry loop
      // catches SchemaValidationError narrowly, so a leaked TypeError would
      // crash the completion instead of triggering a retry.
      expect(() => validateComponent(junk)).toThrow(SchemaValidationError);
    }
  });
});
