/**
 * DRO-821 — the compiler ↔ viewer/HMR filename-contract guard.
 *
 * ── Why this test exists (the divergence it locks out) ──────────────────────
 * Every OTHER viewer test hand-authors its cards as `components/<g>/<N>/preview.html`.
 * But the REAL server generation path (`conjure`/`refine` → the manifest compiler)
 * emits a component's preview as `<Name>.html` (e.g. `Button/Button.html`) — a shape
 * FORCED by the LLM `response_format` schema, whose `files[]` `contains` constraint is
 * `^components/[a-z0-9-]+/([A-Z][A-Za-z0-9]{1,63})/\1\.html$` (`server/src/llm/schema.ts`).
 * The model literally cannot emit `preview.html`.
 *
 * So against a real kit the viewer's original `components/**\/preview.html` Vite glob
 * matched ZERO entries (grid rendered empty) and the HMR classifier's `…/preview\.html$`
 * regex never fired for a real card (AC2/AC3 silently no-op'd end-to-end). The fixtures
 * masked it. This test runs the ACTUAL `compileManifest` against a server-shaped
 * `<Name>.html` kit and asserts the THREE surfaces that must agree are byte-identical:
 *
 *   1. the compiled `.genie/manifest.json` card `path`   (→ the grid iframe's `data-path`)
 *   2. the Vite preview entry the dev server would serve  (`collectPreviewEntries` / `input`)
 *   3. the HMR `card.changed` broadcast path              (`classifyHmrPath`)
 *
 * If any of the three drifts from the compiler's real output again, this fails — a
 * hand-authored `preview.html` fixture can no longer hide the divergence (AC3).
 *
 * ── Why this lives in @ambitresearch/genie-e2e (not packages/viewer/test) ─────────────────
 * It is the only test that spans BOTH packages — the server's `compileManifest`
 * AND the viewer's `collectPreviewEntries`/`classifyHmrPath` — so it belongs in the
 * cross-package integration package (`@ambitresearch/genie-e2e`, which declares `@ambitresearch/genie` +
 * `@ambitresearch/genie-viewer`), matching every other `../../<pkg>/src/…` monorepo-test import in
 * the repo and, unlike `packages/viewer/test/**` (excluded from viewer's tsconfig),
 * getting typechecked by `@ambitresearch/genie-e2e typecheck`. The server's and viewer's own
 * transitive deps (zod, mime-types, fast-glob, vite) resolve from each package's own
 * `node_modules`; this is a vitest-only test (nothing is bundled), so the reach across
 * the boundary stays test-scoped.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileManifest } from "../../server/src/manifest/compiler.js";
import { collectPreviewEntries, createViewerConfig } from "../../viewer/src/config.js";
import { classifyHmrPath } from "../../viewer/src/hmr-plugin.js";

/**
 * The EXACT filename the real conjure/refine path emits (schema-forced
 * `<Name>/<Name>.html`), NOT the `preview.html` every other viewer fixture uses.
 */
const CARD_REL = "components/actions/Button/Button.html";

/** A minimal but valid server-shaped card: a `@genie` marker line + markup. */
const CARD_MARKUP = [
  '<!-- @genie group="actions" viewport="480x240" name="Primary button" -->',
  "<!doctype html>",
  '<button class="btn" type="button">Click</button>',
  "",
].join("\n");

describe("DRO-821 — viewer/HMR agree with the compiler-produced <Name>.html", () => {
  let kitRoot: string;

  beforeEach(async () => {
    kitRoot = await mkdtemp(join(tmpdir(), "genie-dro821-"));
    await mkdir(join(kitRoot, "components/actions/Button"), { recursive: true });
    await writeFile(join(kitRoot, CARD_REL), CARD_MARKUP, "utf-8");
    // A well-formed viewer target always has a root index.html (the `main` entry).
    await writeFile(join(kitRoot, "index.html"), "<!doctype html><title>kit</title>", "utf-8");
  });

  afterEach(async () => {
    await rm(kitRoot, { recursive: true, force: true });
  });

  it("the real compiler cards the <Name>.html preview (server contract)", async () => {
    const { manifest, skipped } = await compileManifest(kitRoot);
    expect(skipped).toEqual([]);
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0]?.name).toBe("Button");
    expect(manifest.components[0]?.path).toBe(CARD_REL);
  });

  it("the compiled card path is a Vite preview entry — the grid would render it (AC1)", async () => {
    const { manifest } = await compileManifest(kitRoot);
    const cardPath = manifest.components[0]?.path;
    expect(cardPath).toBe(CARD_REL);

    // The bug in one assertion: with the old `components/**/preview.html` glob this
    // was `[]`, so a real kit had zero Vite entries and the grid was empty.
    expect(collectPreviewEntries(kitRoot)).toContain(cardPath);

    // …and it actually reaches the Vite `rollupOptions.input` the dev server builds.
    const input = createViewerConfig({ root: kitRoot }).build?.rollupOptions?.input as Record<
      string,
      string
    >;
    expect(input.components_actions_Button_Button_html).toBe(join(kitRoot, CARD_REL));
  });

  it("editing the compiled card fires exactly one matching card.changed (AC2/AC3)", async () => {
    const { manifest } = await compileManifest(kitRoot);
    const cardPath = manifest.components[0]?.path as string;

    // Fed the same absolute path Vite's watcher reports on a save, the HMR
    // classifier must return a `card` whose `path` === the manifest card path
    // === the grid iframe's `data-path`, so the client's plain `===` match is true.
    // (Old `…/preview\.html$` classifier returned `undefined` here → no broadcast.)
    expect(classifyHmrPath(kitRoot, join(kitRoot, cardPath))).toEqual({
      kind: "card",
      path: cardPath,
    });
  });

  it("a co-located non-preview .html classifies but never matches a card (harmless over-match)", async () => {
    // The broadened glob/classifier is a path-level superset, so a marker-less,
    // co-located `.html` (not a manifest card) can classify as a "card" path — but
    // the compiler never cards it, so no grid iframe carries that `data-path` and
    // `viewer.js`'s reloadCardByPath reloads zero iframes. Prove the compiler skips it.
    const strayRel = "components/actions/Button/notes.html";
    await writeFile(join(kitRoot, strayRel), "<p>scratch, no @genie marker</p>\n", "utf-8");

    const { manifest, skipped } = await compileManifest(kitRoot);
    const cardPaths = manifest.components.map((c) => c.path);
    expect(cardPaths).toEqual([CARD_REL]); // the stray is NOT a card…
    expect(skipped.map((s) => s.path)).toContain(strayRel); // …it's reported skipped.
  });

  it("still cards a DesignSync-compat preview.html too (backward-compatible superset)", async () => {
    // Nothing that worked before regresses: a hand-authored `preview.html` (the shape
    // every prior fixture uses) still compiles, globs, and classifies.
    const rel = "components/surfaces/Card/preview.html";
    await mkdir(join(kitRoot, "components/surfaces/Card"), { recursive: true });
    await writeFile(
      join(kitRoot, rel),
      '<!-- @genie group="surfaces" viewport="480x320" -->\n<div class="card">card</div>\n',
      "utf-8",
    );

    const { manifest } = await compileManifest(kitRoot);
    const paths = manifest.components.map((c) => c.path);
    expect(paths).toContain(CARD_REL);
    expect(paths).toContain(rel);
    expect(collectPreviewEntries(kitRoot)).toEqual(expect.arrayContaining([CARD_REL, rel]));
    expect(classifyHmrPath(kitRoot, join(kitRoot, rel))).toEqual({ kind: "card", path: rel });
  });
});
