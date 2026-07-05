/**
 * Tests for the empty-manifest seed (DRO-764 AC3) — `buildEmptyManifest` /
 * `serializeEmptyManifest`.
 *
 * Three things this module's own header promises, each pinned by a test here:
 *   1. The envelope shape is byte-shape-identical to what `compileManifest`
 *      (`../manifest/compiler.ts`) emits for a kit with no `components/`
 *      directory yet — proven by an actual `compileManifest` run against an
 *      empty temp dir, not just an inline literal a future edit could drift
 *      from.
 *   2. `../store/manifest.ts`'s `selectComponents` — the SAME reader
 *      `list_components` and `GitHostKitStore.listComponents` use — can parse
 *      the serialized bytes back out without throwing `ManifestParseError`,
 *      and reports zero components (AC8-shaped: an empty kit is a valid,
 *      parseable "no components yet", not corruption).
 *   3. `serializeEmptyManifest` uses the SAME 2-space-indent JSON.stringify
 *      shape `compiler.ts`'s `writeManifestAtomic` uses, so a seeded manifest
 *      and a freshly-compiled empty one diverge by nothing but the
 *      `generatedAt` timestamp.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileManifest } from "../manifest/compiler.js";
import { selectComponents } from "./manifest.js";
import { buildEmptyManifest, serializeEmptyManifest } from "./empty-manifest.js";

describe("buildEmptyManifest", () => {
  it("produces version 1, empty groups/components, and the given name", () => {
    const manifest = buildEmptyManifest("My Kit");
    expect(manifest).toMatchObject({
      version: 1,
      name: "My Kit",
      groups: [],
      components: [],
    });
  });

  it("stamps generatedAt as a real ISO-8601 timestamp", () => {
    const manifest = buildEmptyManifest("Timestamp Kit");
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it("is byte-shape-identical to compileManifest's own empty-kit output", async () => {
    // The actual compiler, run against a kit with no components/ dir at all —
    // not a hand-copied literal that could silently drift from the real thing.
    const root = await mkdtemp(join(tmpdir(), "genie-empty-manifest-parity-"));
    try {
      const { manifest: compiled } = await compileManifest(root);
      const seeded = buildEmptyManifest(compiled.name);

      // Same shape modulo the two fields that are legitimately per-call
      // (name — the compiler derives it from the dir basename, the seed takes
      // it from create_kit's own `name` param — and generatedAt, a timestamp).
      expect(seeded.version).toBe(compiled.version);
      expect(seeded.groups).toEqual(compiled.groups);
      expect(seeded.components).toEqual(compiled.components);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("serializeEmptyManifest", () => {
  it("serializes as 2-space-indented JSON — matching compiler.ts's writeManifestAtomic shape", () => {
    const raw = serializeEmptyManifest("Formatting Kit");
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2));
    // A literal spot-check that indentation is really 2 spaces, not just that
    // re-stringifying with `null, 2` happens to round-trip (which a minified
    // single-line JSON would also satisfy trivially).
    expect(raw).toContain('\n  "version": 1');
  });

  it("round-trips through JSON.parse into the same shape buildEmptyManifest returned", () => {
    const built = buildEmptyManifest("Roundtrip Kit");
    const parsed = JSON.parse(serializeEmptyManifest("Roundtrip Kit")) as unknown;
    // generatedAt is stamped independently by each call (Date.now() moves
    // between them), so compare everything else field-by-field instead of a
    // whole-object deep-equal.
    expect(parsed).toMatchObject({
      version: built.version,
      name: built.name,
      groups: built.groups,
      components: built.components,
    });
  });

  it("selectComponents parses the serialized bytes back out as zero components, never ManifestParseError", () => {
    // The exact reader `list_components` (LocalFs) and GitHostKitStore.
    // listComponents both go through — proves a seeded manifest is a REAL,
    // valid manifest to every consumer, not a viewer-only special case.
    const raw = serializeEmptyManifest("Selectable Kit");
    expect(() => selectComponents("selectable-kit", raw)).not.toThrow();
    expect(selectComponents("selectable-kit", raw)).toEqual([]);
  });

  it("selectComponents with an explicit group filter still returns [] (AC8 shape, never throws)", () => {
    const raw = serializeEmptyManifest("Filtered Kit");
    expect(selectComponents("filtered-kit", raw, "actions")).toEqual([]);
  });
});
