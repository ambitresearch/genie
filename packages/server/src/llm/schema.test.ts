/**
 * Tests for M2-02's `COMPONENT_SCHEMA` (`packages/server/src/llm/schema.ts`).
 *
 * Covers every AC:
 *   - AC1 — module exports `COMPONENT_SCHEMA` (implicitly exercised by every
 *     test below importing it).
 *   - AC2 — Draft 7 only: no `anyOf`/`oneOf`, and the schema's only `$ref` is
 *     a single level deep.
 *   - AC3 — top-level shape.
 *   - AC4 — `path` pattern.
 *   - AC5 — at least one `<Name>.html` file required.
 *   - AC6 — `manifestEntry.viewport` required; `subtitle`/`tags` optional.
 *   - AC7 — `ValidatedComponent` (the `FromSchema`-inferred type) type-checks
 *     against a real fixture, and the schema is also emitted as JSON
 *     (`scripts/emit-component-schema.mjs`, exercised by its own test below).
 *
 * Validation itself runs through Ajv with `{ strict: true, allErrors: true }`
 * — the same configuration M2-07's `validateComponent` will use — so this
 * suite also proves the schema *compiles* under strict mode (a schema with
 * an ambiguous/unknown keyword throws at `ajv.compile()` time under
 * `strict: true`, before any data is even validated).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { describe, expect, it, beforeAll, afterEach } from "vitest";

import { COMPONENT_SCHEMA, type ValidatedComponent } from "./schema.js";
import { emitComponentSchemaJson } from "../../scripts/emit-component-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A minimal, fully valid fixture — the "known-good" case every AC is checked against. */
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

describe("COMPONENT_SCHEMA", () => {
  let validate: ValidateFunction;

  // AC2 (partial) / general soundness — this is the same Ajv configuration
  // M2-07's validateComponent will use (`{ strict: true, allErrors: true }`).
  // Compiling under `strict: true` throws at compile time (not validation
  // time) if the schema uses an ambiguous or unknown keyword, so a
  // beforeAll that doesn't throw is itself a passing assertion about the
  // schema's Draft-7 cleanliness — every test below additionally validates
  // *data* against the already-compiled function.
  beforeAll(() => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    validate = ajv.compile(COMPONENT_SCHEMA);
  });

  function errorsOf(fn: ValidateFunction): ErrorObject[] {
    return fn.errors ?? [];
  }

  // ─── AC1 — the export exists and is a plain object ────────────────────────

  it("AC1: exports COMPONENT_SCHEMA as a plain object", () => {
    expect(COMPONENT_SCHEMA).toBeTypeOf("object");
    expect(COMPONENT_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  // ─── AC2 — Draft 7 only ────────────────────────────────────────────────────

  it("AC2: declares the Draft 7 $schema URI", () => {
    expect(COMPONENT_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("AC2: contains no anyOf/oneOf discriminator keyword anywhere in the schema", () => {
    const serialized = JSON.stringify(COMPONENT_SCHEMA);
    const parsed: unknown = JSON.parse(serialized);
    expect(hasKeyDeep(parsed, "anyOf")).toBe(false);
    expect(hasKeyDeep(parsed, "oneOf")).toBe(false);
  });

  it("AC2: has exactly one $ref, and it resolves to a top-level (single-level) definition", () => {
    const serialized = JSON.stringify(COMPONENT_SCHEMA);
    const refs = [...serialized.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toEqual(["#/definitions/Viewport"]);
    // The referenced definition itself contains no further $ref (i.e. this
    // is a single hop, not a chain).
    expect(COMPONENT_SCHEMA.definitions.Viewport).not.toHaveProperty("$ref");
  });

  it("AC2: compiles cleanly under Ajv strict mode (no ambiguous/unknown keywords)", () => {
    // If beforeAll's ajv.compile(COMPONENT_SCHEMA) had thrown, this whole
    // suite would already have failed during setup. This test exists to make
    // that guarantee an explicit, readable assertion in the suite itself
    // rather than an implicit side effect of every other test happening to
    // still run.
    expect(validate).toBeTypeOf("function");
  });

  // ─── AC3 — top-level shape ─────────────────────────────────────────────────

  it("AC3: accepts a fully valid { componentName, group, files, manifestEntry } fixture", () => {
    const ok = validate(goodFixture());
    expect(errorsOf(validate)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("AC3: requires componentName, group, files, and manifestEntry", () => {
    expect(COMPONENT_SCHEMA.required).toEqual(["componentName", "group", "files", "manifestEntry"]);
    for (const key of ["componentName", "group", "files", "manifestEntry"] as const) {
      const fixture = goodFixture() as Record<string, unknown>;
      delete fixture[key];
      expect(validate(fixture), `expected rejection when "${key}" is missing`).toBe(false);
    }
  });

  it("AC3: rejects an unknown top-level property", () => {
    const fixture = { ...goodFixture(), extra: "not allowed" };
    expect(validate(fixture)).toBe(false);
    expect(errorsOf(validate).some((e) => e.keyword === "additionalProperties")).toBe(true);
  });

  // ─── AC4 — path pattern ────────────────────────────────────────────────────

  it("AC4: matches the literal pattern from the issue", () => {
    expect(COMPONENT_SCHEMA.properties.files.items.properties.path.pattern).toBe(
      "^components/[a-z0-9-]+/[A-Z][A-Za-z0-9]+/[A-Za-z0-9._-]+$",
    );
  });

  it.each([
    "components/actions/Button/Button.tsx",
    "components/actions/Button/Button.d.ts",
    "components/actions/Button/Button.prompt.md",
    "components/actions/Button/Button.html",
    "components/actions/Button/meta.json",
    "components/forms-inputs/TextField/TextField.jsx",
  ])("AC4: accepts a well-formed path %s", (path) => {
    // Paired with a valid Button.html so this case exercises ONLY AC4's
    // items.path pattern, not AC5's separate "at least one <Name>.html"
    // `contains` requirement — a bare single non-html file would fail AC5
    // regardless of whether its own path is well-formed, which would make
    // this test a false negative for the thing it's actually checking.
    const fixture = goodFixture();
    fixture.files = [
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->',
        mimeType: "text/html",
      },
      { path, content: "x", mimeType: "text/plain" },
    ];
    expect(validate(fixture), JSON.stringify(errorsOf(validate))).toBe(true);
  });

  it.each([
    ["missing components/ prefix", "actions/Button/Button.tsx"],
    ["uppercase group segment", "components/Actions/Button/Button.tsx"],
    ["lowercase component dir", "components/actions/button/button.tsx"],
    ["path traversal", "components/actions/Button/../../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["missing Name segment", "components/actions/Button.tsx"],
  ])("AC4: rejects a malformed path (%s): %s", (_label, path) => {
    const fixture = goodFixture();
    fixture.files = [
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->',
        mimeType: "text/html",
      },
      { path, content: "x", mimeType: "text/plain" },
    ];
    expect(validate(fixture)).toBe(false);
  });

  // ─── AC5 — at least one <Name>.html file ──────────────────────────────────

  it("AC5: rejects a file set with no <Name>.html entry", () => {
    const fixture = goodFixture();
    fixture.files = [
      {
        path: "components/actions/Button/Button.tsx",
        content: "export default function Button() {}",
        mimeType: "text/tsx",
      },
    ];
    expect(validate(fixture)).toBe(false);
    expect(errorsOf(validate).some((e) => e.keyword === "contains")).toBe(true);
  });

  it("AC5: rejects an HTML file whose name doesn't match its own directory", () => {
    const fixture = goodFixture();
    fixture.files = [
      {
        path: "components/actions/Button/Wrong.html",
        content: '<!-- @genie group="actions" -->\n<button>Click</button>',
        mimeType: "text/html",
      },
    ];
    expect(validate(fixture)).toBe(false);
  });

  it("AC5: accepts when the <Name>.html entry is present alongside other files", () => {
    const ok = validate(goodFixture());
    expect(ok).toBe(true);
  });

  // ─── AC6 — manifestEntry.viewport required; subtitle/tags optional ───────

  it("AC6: manifestEntry requires viewport with numeric width/height", () => {
    const fixture = goodFixture();
    // @ts-expect-error deliberately testing runtime rejection of a missing required field
    fixture.manifestEntry = { subtitle: "no viewport" };
    expect(validate(fixture)).toBe(false);
  });

  it("AC6: manifestEntry accepts viewport alone (subtitle/tags are optional)", () => {
    const fixture = goodFixture();
    fixture.manifestEntry = { viewport: { width: 100, height: 100 } };
    expect(validate(fixture), JSON.stringify(errorsOf(validate))).toBe(true);
  });

  it("AC6: rejects a non-integer or out-of-range viewport dimension", () => {
    for (const viewport of [
      { width: 0, height: 100 },
      { width: 100, height: 0 },
      { width: 4097, height: 100 },
      { width: 1.5, height: 100 },
    ]) {
      const fixture = goodFixture();
      fixture.manifestEntry = { viewport };
      expect(validate(fixture), JSON.stringify(viewport)).toBe(false);
    }
  });

  it("AC6: rejects an unknown manifestEntry property", () => {
    const fixture = goodFixture();
    // @ts-expect-error deliberately testing runtime rejection of an unknown field
    fixture.manifestEntry = { viewport: { width: 1, height: 1 }, unknownField: true };
    expect(validate(fixture)).toBe(false);
  });

  // ─── Other per-file fields ─────────────────────────────────────────────────

  it("rejects a file with a non-string / empty content", () => {
    const fixture = goodFixture();
    fixture.files = [
      { path: "components/actions/Button/Button.html", content: "", mimeType: "text/html" },
    ];
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a file with a malformed mimeType", () => {
    const fixture = goodFixture();
    fixture.files = [
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->',
        mimeType: "not-a-mime-type",
      },
    ];
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a file missing a required field (path/content/mimeType)", () => {
    for (const key of ["path", "content", "mimeType"] as const) {
      const fixture = goodFixture();
      const file = { ...fixture.files[1] } as Record<string, unknown>;
      delete file[key];
      fixture.files = [file as ValidatedComponent["files"][number]];
      expect(validate(fixture), `expected rejection when file.${key} is missing`).toBe(false);
    }
  });

  it("enforces the files array's minItems/maxItems bounds", () => {
    const empty = { ...goodFixture(), files: [] };
    expect(validate(empty)).toBe(false);

    const tooMany = {
      ...goodFixture(),
      files: Array.from({ length: 13 }, (_, i) =>
        i === 0
          ? {
              path: "components/actions/Button/Button.html",
              content: '<!-- @genie group="actions" -->',
              mimeType: "text/html",
            }
          : {
              path: `components/actions/Button/File${i}.tsx`,
              content: "x",
              mimeType: "text/tsx",
            },
      ),
    };
    expect(validate(tooMany)).toBe(false);
  });

  // ─── componentName / group field patterns ─────────────────────────────────

  it.each(["Button", "IconButton2", "Aa"])(
    "accepts a valid PascalCase componentName %s",
    (componentName) => {
      const fixture = { ...goodFixture(), componentName };
      expect(validate(fixture), JSON.stringify(errorsOf(validate))).toBe(true);
    },
  );

  it.each(["button", "2Button", "", "B", "Button Name", "A" + "a".repeat(64)])(
    "rejects an invalid componentName %s",
    (componentName) => {
      const fixture = { ...goodFixture(), componentName };
      expect(validate(fixture)).toBe(false);
    },
  );

  it.each(["actions", "forms-inputs", "a"])("accepts a valid kebab-case group %s", (group) => {
    const fixture = { ...goodFixture(), group };
    expect(validate(fixture), JSON.stringify(errorsOf(validate))).toBe(true);
  });

  it.each(["Actions", "actions_inputs", "", "a".repeat(33)])(
    "rejects an invalid group %s",
    (group) => {
      const fixture = { ...goodFixture(), group };
      expect(validate(fixture)).toBe(false);
    },
  );

  // ─── DoD: "validates a known-good fixture; rejects 3 known-bad fixtures" ──
  // (see also the AC-specific tests above, which already cover this several
  // times over — these three are the literal DoD checklist items, kept as
  // their own named cases for an unambiguous per-AC audit trail.)

  it("DoD: validates the known-good fixture", () => {
    expect(validate(goodFixture())).toBe(true);
  });

  it("DoD known-bad #1: missing manifestEntry", () => {
    const fixture = goodFixture() as Record<string, unknown>;
    delete fixture.manifestEntry;
    expect(validate(fixture)).toBe(false);
  });

  it("DoD known-bad #2: no html file present", () => {
    const fixture = goodFixture();
    fixture.files = fixture.files.filter((f) => !f.path.endsWith(".html"));
    expect(validate(fixture)).toBe(false);
  });

  it("DoD known-bad #3: componentName is lowercase", () => {
    const fixture = { ...goodFixture(), componentName: "button" };
    expect(validate(fixture)).toBe(false);
  });

  // ─── AC7 — type-level check ────────────────────────────────────────────────

  it("AC7: ValidatedComponent accepts the good fixture at the type level (compile-time proof)", () => {
    // This assignment is itself the assertion: if `ValidatedComponent`
    // (FromSchema<typeof COMPONENT_SCHEMA>) drifted out of sync with the
    // runtime schema shape, `goodFixture()`'s declared return type would fail
    // to typecheck and `tsc`/`vitest run --typecheck` would fail the build,
    // not this line.
    const fixture: ValidatedComponent = goodFixture();
    expect(fixture.componentName).toBe("Button");
  });
});

describe("component.schema.json (AC7 JSON export)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("emitComponentSchemaJson writes a JSON file byte-equivalent to COMPONENT_SCHEMA", async () => {
    // Calls the real emit function (the same one `scripts/emit-component-schema.mjs`
    // runs as `pnpm build`'s postbuild step) directly against `schema.ts` —
    // NOT against a prior `tsc` build's `dist/llm/schema.js`. This matters
    // because CI's `test` and `build` matrix legs run as independent jobs
    // from separate fresh checkouts (see `.github/workflows/ci.yml`): a
    // version of this test that only compared against `dist/` would have
    // zero real coverage in the `test` leg (no `dist/` exists there) and
    // would have needed a skip-if-missing escape hatch, silently passing
    // without ever having exercised AC7's JSON-export requirement. Importing
    // `schema.ts` directly (vitest transforms TS on the fly, same as every
    // other import in this file) keeps the assertion real under both
    // execution orders while still exercising the actual shared function the
    // production postbuild step calls — not a re-implementation of it.
    const schemaModulePath = fileURLToPath(new URL("./schema.ts", import.meta.url));
    const outDir = await mkdtemp(join(tmpdir(), "emit-component-schema-test-"));
    tmpDirs.push(outDir);
    const outFile = join(outDir, "component.schema.json");

    const returned = await emitComponentSchemaJson(schemaModulePath, outFile);
    expect(returned).toBe(outFile);

    const written = JSON.parse(await readFile(outFile, "utf-8"));
    expect(written).toEqual(JSON.parse(JSON.stringify(COMPONENT_SCHEMA)));
  });

  it("emitComponentSchemaJson creates missing parent directories", async () => {
    const schemaModulePath = fileURLToPath(new URL("./schema.ts", import.meta.url));
    const outDir = await mkdtemp(join(tmpdir(), "emit-component-schema-test-"));
    tmpDirs.push(outDir);
    const outFile = join(outDir, "nested", "deeper", "component.schema.json");

    await emitComponentSchemaJson(schemaModulePath, outFile);
    expect(JSON.parse(await readFile(outFile, "utf-8")).title).toBe("GenieComponent");
  });

  it("emitComponentSchemaJson throws a clear error when the module has no COMPONENT_SCHEMA export", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "emit-component-schema-test-"));
    tmpDirs.push(outDir);
    // schema.test.ts itself has no COMPONENT_SCHEMA export — a convenient
    // real module to import that exercises the "missing export" branch
    // without hand-rolling a throwaway fixture file on disk.
    const notASchemaModule = fileURLToPath(import.meta.url);
    const outFile = join(outDir, "component.schema.json");

    await expect(emitComponentSchemaJson(notASchemaModule, outFile)).rejects.toThrow(
      /did not import as an object/,
    );
  });

  it("the real CLI entrypoint (scripts/emit-component-schema.mjs) runs standalone and matches", async () => {
    // Complements the direct emitComponentSchemaJson() calls above (which
    // prove the shared logic against the real schema) with one real
    // subprocess spawn of the actual file `pnpm build` invokes, args and all
    // — so a mistake in the CLI-argument-parsing / import.meta.url
    // entrypoint-guard wiring at the bottom of emit-component-schema.mjs
    // (which none of the direct calls above exercise, since they import the
    // function and skip the guard entirely) would still be caught here.
    //
    // Targets a plain-.mjs fixture (shaped like real `tsc` output) rather
    // than schema.ts itself: the real postbuild step only ever runs this
    // script against already-compiled JS (see package.json's `build`
    // script), never against a .ts source, and a plain `node` subprocess
    // (unlike vitest's own transform) would need Node's own TS type-stripping
    // to import schema.ts directly — not a version floor this repo relies on
    // elsewhere (the `dev` script uses `tsx` for exactly that reason).
    const scriptPath = join(__dirname, "..", "..", "scripts", "emit-component-schema.mjs");
    const fixtureModulePath = join(
      __dirname,
      "..",
      "..",
      "test",
      "fixtures",
      "component-schema",
      "fake-compiled-schema.mjs",
    );
    const outDir = await mkdtemp(join(tmpdir(), "emit-component-schema-test-"));
    tmpDirs.push(outDir);
    const outFile = join(outDir, "component.schema.json");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(process.execPath, [
      scriptPath,
      fixtureModulePath,
      outFile,
    ]);

    expect(stdout).toContain("wrote");
    const written = JSON.parse(await readFile(outFile, "utf-8"));
    expect(written).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "GenieComponentFixture",
      type: "object",
      properties: {
        componentName: { type: "string" },
      },
    });
  });
});

/** Recursively search a parsed JSON value for an object key, at any depth. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, key));
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) return true;
      if (hasKeyDeep(v, key)) return true;
    }
  }
  return false;
}
