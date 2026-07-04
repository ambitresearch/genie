/**
 * Tests for M3-03's manifest compiler (`packages/server/src/manifest/compiler.ts`),
 * tracking issue DRO-259 (spec `docs/github/issues/M3-03-manifest-compiler.md`).
 *
 * ── Schema note ───────────────────────────────────────────────────────────────
 * The issue's own AC4 literal text says the root key is `cards` with an object
 * `viewport`. This suite asserts the RECONCILED shape instead (root key
 * `components`, string `viewport`) — see the schema-reconciliation note atop
 * `compiler.ts` and the plan comment on DRO-259: the already-shipped, merged
 * `../store/manifest.ts` (backing the M1-15 `list_components` tool) requires
 * `components` + string `viewport`, and emitting `cards` would silently break
 * that live P0 tool. Every other AC4 field (`version`, `generatedAt`, `groups`,
 * per-card `name`/`group`/`path`/`viewport`/`hash`/`lastModified`/`subtitle`/
 * `tags`) is asserted as specified.
 *
 * Covers:
 *   - AC1 — `compileManifest(projectRoot): Promise<Manifest>` is exported and callable.
 *   - AC2 — walks `components/**\/*.html`; reads first line; extracts group + viewport.
 *   - AC3 — joins a sibling `meta.json` for `subtitle`/`tags` when present.
 *   - AC4 — output shape (reconciled — see above).
 *   - AC5 — hash is `sha256-<base64>` SRI of the HTML file's bytes.
 *   - AC6 — atomic write: no partial file ever observable at the destination path.
 *   - AC7 — compiles a 50-component kit fast (generous, CI-safe bound).
 *   - Marker-missing files are skipped, not fatal (RFC §6.8 failure mode), and
 *     reported back via `skipped`.
 *   - `_groups.json` group-order pin (Impl Notes).
 *   - Empty kit → `{ components: [], groups: [] }`, no throw.
 *   - `../store/manifest.ts`'s `selectComponents` can read the compiler's own
 *     output back out without throwing `ManifestParseError` — the actual
 *     end-to-end proof the reconciled schema is correct, not just asserted.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileManifest } from "./compiler.js";
import { MANIFEST_PATH, selectComponents } from "../store/manifest.js";

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-manifest-"));
}

/** Write one component's `<Name>.html` (+ optional `meta.json`) under
 * `components/<group>/<Name>/`. */
async function writeComponent(
  root: string,
  group: string,
  name: string,
  opts: {
    markerExtra?: string; // extra attrs appended after group="…" in the marker
    noMarker?: boolean;
    meta?: Record<string, unknown>;
    html?: string; // full override of the html body after the marker line
  } = {},
): Promise<string> {
  const dir = join(root, "components", group, name);
  await mkdir(dir, { recursive: true });
  const marker = opts.noMarker
    ? ""
    : `<!-- @genie group="${group}"${opts.markerExtra ? ` ${opts.markerExtra}` : ""} -->\n`;
  const body = opts.html ?? `<div class="card">${name}</div>`;
  const htmlPath = join(dir, `${name}.html`);
  await writeFile(htmlPath, marker + body);
  if (opts.meta) {
    await writeFile(join(dir, "meta.json"), JSON.stringify(opts.meta));
  }
  return htmlPath;
}

describe("compileManifest", () => {
  let root: string;

  beforeEach(async () => {
    root = await tempProjectRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ─── AC1 — basic callable contract ─────────────────────────────────────────

  it("AC1: is exported and returns a Manifest for a project with components", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="320x96"' });
    const { manifest } = await compileManifest(root);
    expect(manifest.version).toBe(1);
    expect(manifest.components).toHaveLength(1);
  });

  // ─── Empty kit ──────────────────────────────────────────────────────────────

  it("returns { components: [], groups: [] } for a kit with no components/ dir at all", async () => {
    const { manifest, skipped } = await compileManifest(root);
    expect(manifest.components).toEqual([]);
    expect(manifest.groups).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("returns { components: [], groups: [] } for an existing but empty components/ dir", async () => {
    await mkdir(join(root, "components"), { recursive: true });
    const { manifest } = await compileManifest(root);
    expect(manifest.components).toEqual([]);
    expect(manifest.groups).toEqual([]);
  });

  // ─── AC2 — walk + group/viewport extraction ────────────────────────────────

  it("AC2: walks nested components/**/*.html and extracts group from the marker", async () => {
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "forms-inputs", "TextField");
    const { manifest } = await compileManifest(root);
    const groups = manifest.components.map((c) => c.group).sort();
    expect(groups).toEqual(["actions", "forms-inputs"]);
  });

  it("AC2: extracts a WxH viewport token verbatim", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="400x200"' });
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.viewport).toBe("400x200");
  });

  it("AC2: extracts a named (non-numeric) viewport token verbatim, not silently dropped", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="desktop"' });
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.viewport).toBe("desktop");
  });

  it("uses an empty string viewport when the marker has no viewport attribute", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.viewport).toBe("");
  });

  it("records the AC4 path as project-root-relative with forward slashes", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.path).toBe("components/actions/Button/Button.html");
  });

  it("derives name from the filename (<Name>.html -> <Name>)", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.name).toBe("Button");
  });

  // ─── marker-missing: skipped, not fatal ────────────────────────────────────

  it("skips a file with no @genie marker rather than throwing, and reports it in `skipped`", async () => {
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "actions", "Broken", { noMarker: true });
    const { manifest, skipped } = await compileManifest(root);
    expect(manifest.components.map((c) => c.name)).toEqual(["Button"]);
    expect(skipped).toEqual([
      { path: "components/actions/Broken/Broken.html", reason: "MARKER_MISSING" },
    ]);
  });

  it("does not match Anthropic's @dsCard shape as a valid genie marker (CLAUDE.md hard rule 1)", async () => {
    const dir = join(root, "components", "actions", "Fake");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Fake.html"), '<!-- @dsCard group="actions" -->\n<div/>');
    const { manifest, skipped } = await compileManifest(root);
    expect(manifest.components).toEqual([]);
    expect(skipped).toEqual([
      { path: "components/actions/Fake/Fake.html", reason: "MARKER_MISSING" },
    ]);
  });

  // ─── AC3 — meta.json join ───────────────────────────────────────────────────

  it("AC3: joins subtitle + tags from a sibling meta.json when present", async () => {
    await writeComponent(root, "actions", "Button", {
      meta: { subtitle: "Primary action", tags: ["cta", "primary"] },
    });
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.subtitle).toBe("Primary action");
    expect(manifest.components[0]?.tags).toEqual(["cta", "primary"]);
  });

  it("AC3: omits subtitle/tags entirely (not null/undefined-valued keys) when meta.json is absent", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]).not.toHaveProperty("subtitle");
    expect(manifest.components[0]).not.toHaveProperty("tags");
  });

  it("tolerates a malformed meta.json (degrades to no extra metadata, does not fail the compile)", async () => {
    const dir = join(root, "components", "actions", "Button");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Button.html"), '<!-- @genie group="actions" -->\n<div/>');
    await writeFile(join(dir, "meta.json"), "{ not valid json");
    const { manifest } = await compileManifest(root);
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0]).not.toHaveProperty("subtitle");
  });

  it("ignores non-string tags entries in meta.json rather than crashing", async () => {
    await writeComponent(root, "actions", "Button", {
      meta: { tags: ["ok", 5, null] },
    });
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]).not.toHaveProperty("tags");
  });

  // ─── AC4 — full output shape ────────────────────────────────────────────────

  it("AC4: top-level shape is { version: 1, name, generatedAt, groups: [], components: [] }", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="320x96"' });
    const before = new Date().toISOString();
    const { manifest } = await compileManifest(root);
    expect(manifest).toMatchObject({
      version: 1,
      groups: ["actions"],
    });
    expect(typeof manifest.name).toBe("string");
    expect(manifest.generatedAt >= before).toBe(true);
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it("AC4: per-card required shape has exactly the six ComponentEntry fields when no meta.json exists", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="320x96"' });
    const { manifest } = await compileManifest(root);
    const card = manifest.components[0]!;
    expect(Object.keys(card).sort()).toEqual(
      ["group", "hash", "lastModified", "name", "path", "viewport"].sort(),
    );
  });

  it("`name` is the project root's directory basename", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.name).toBe(root.split("/").pop());
  });

  // ─── AC5 — hash format + stability ──────────────────────────────────────────

  it("AC5: hash is a sha256-<base64> SRI string", async () => {
    await writeComponent(root, "actions", "Button");
    const { manifest } = await compileManifest(root);
    expect(manifest.components[0]?.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it("AC5: hash is stable across re-compiles of byte-identical content", async () => {
    await writeComponent(root, "actions", "Button");
    const first = await compileManifest(root);
    const second = await compileManifest(root);
    expect(second.manifest.components[0]?.hash).toBe(first.manifest.components[0]?.hash);
  });

  it("AC5: hash changes when the HTML file's bytes change", async () => {
    const htmlPath = await writeComponent(root, "actions", "Button");
    const first = await compileManifest(root);
    await writeFile(htmlPath, '<!-- @genie group="actions" -->\n<div>changed</div>');
    const second = await compileManifest(root);
    expect(second.manifest.components[0]?.hash).not.toBe(first.manifest.components[0]?.hash);
  });

  // ─── Sort order ─────────────────────────────────────────────────────────────

  it("sorts components by group ASC, then name ASC, then path ASC (store/manifest.ts's compareComponents)", async () => {
    await writeComponent(root, "forms-inputs", "TextField");
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "actions", "Alert");
    const { manifest } = await compileManifest(root);
    expect(manifest.components.map((c) => `${c.group}/${c.name}`)).toEqual([
      "actions/Alert",
      "actions/Button",
      "forms-inputs/TextField",
    ]);
  });

  // ─── _groups.json order pin ─────────────────────────────────────────────────

  it("orders groups alphabetically by default", async () => {
    await writeComponent(root, "forms-inputs", "TextField");
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "data-display", "Avatar");
    const { manifest } = await compileManifest(root);
    expect(manifest.groups).toEqual(["actions", "data-display", "forms-inputs"]);
  });

  it("honours an explicit _groups.json order pin over alphabetical (Impl Notes)", async () => {
    await writeComponent(root, "forms-inputs", "TextField");
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "data-display", "Avatar");
    await writeFile(
      join(root, "_groups.json"),
      JSON.stringify(["forms-inputs", "actions", "data-display"]),
    );
    const { manifest } = await compileManifest(root);
    expect(manifest.groups).toEqual(["forms-inputs", "actions", "data-display"]);
  });

  it("appends any discovered group missing from an incomplete _groups.json pin, alphabetically, rather than dropping it", async () => {
    await writeComponent(root, "forms-inputs", "TextField");
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "zeta-group", "Widget");
    await writeFile(join(root, "_groups.json"), JSON.stringify(["forms-inputs"]));
    const { manifest } = await compileManifest(root);
    expect(manifest.groups).toEqual(["forms-inputs", "actions", "zeta-group"]);
  });

  it("ignores a malformed _groups.json and falls back to alphabetical", async () => {
    await writeComponent(root, "forms-inputs", "TextField");
    await writeComponent(root, "actions", "Button");
    await writeFile(join(root, "_groups.json"), "not valid json");
    const { manifest } = await compileManifest(root);
    expect(manifest.groups).toEqual(["actions", "forms-inputs"]);
  });

  // ─── AC6 — atomic write ─────────────────────────────────────────────────────

  it("AC6: writes the manifest to .genie/manifest.json", async () => {
    await writeComponent(root, "actions", "Button");
    await compileManifest(root);
    const raw = await readFile(join(root, MANIFEST_PATH), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.components).toHaveLength(1);
  });

  // AC6's "never leaves a partially-written manifest if the rename fails"
  // fault-injection case lives in its own file (compiler.atomic-write.test.ts)
  // — vi.mock at module scope would otherwise affect every other test in this
  // file, the same reasoning write_files.rollback.test.ts documents for its
  // own fault-injected rm() mock.

  it("AC6: cleans up its .genie-tmp staging directory after a successful compile", async () => {
    await writeComponent(root, "actions", "Button");
    await compileManifest(root);
    const { readdir } = await import("node:fs/promises");
    const staged = await readdir(join(root, ".genie-tmp")).catch(() => []);
    expect(staged).toEqual([]);
  });

  // ─── AC7 — performance (generous, CI-safe bound; see plan comment) ─────────

  it("AC7: compiles a 50-component kit well within a CI-safe bound", async () => {
    const groups = ["actions", "forms-inputs", "feedback", "navigation", "data-display"];
    for (let i = 0; i < 50; i++) {
      const group = groups[i % groups.length]!;
      await writeComponent(root, group, `Comp${String(i).padStart(3, "0")}`, {
        markerExtra: 'viewport="320x96"',
        meta: { subtitle: `card ${i}` },
      });
    }
    const start = performance.now();
    const { manifest } = await compileManifest(root);
    const elapsedMs = performance.now() - start;
    expect(manifest.components).toHaveLength(50);
    // The issue's own AC7 target is <100ms on a 2025 laptop; CI disk I/O can be
    // slower/noisier than a dev laptop, so this asserts a generous multiple of
    // that target rather than the exact literal bound — proving "compiles
    // fast" without making the suite flaky on a loaded CI box (same rationale
    // `llm/retry.test.ts`'s own timing assertions use elsewhere in this repo).
    expect(elapsedMs).toBeLessThan(2000);
  });

  // ─── End-to-end proof the reconciled schema round-trips through the ────────
  // ─── already-shipped store/manifest.ts reader (M1-15's own dependency).────

  it("round-trips through store/manifest.ts's selectComponents without throwing ManifestParseError", async () => {
    await writeComponent(root, "actions", "Button", { markerExtra: 'viewport="320x96"' });
    await writeComponent(root, "forms-inputs", "TextField", { markerExtra: 'viewport="400x120"' });
    await compileManifest(root);
    const raw = await readFile(join(root, MANIFEST_PATH), "utf-8");
    const entries = selectComponents("test-kit", raw);
    expect(entries.map((e) => e.name).sort()).toEqual(["Button", "TextField"]);
  });

  it("round-trips group-filtered selectComponents against the compiler's own output", async () => {
    await writeComponent(root, "actions", "Button");
    await writeComponent(root, "forms-inputs", "TextField");
    await compileManifest(root);
    const raw = await readFile(join(root, MANIFEST_PATH), "utf-8");
    const entries = selectComponents("test-kit", raw, "actions");
    expect(entries.map((e) => e.name)).toEqual(["Button"]);
  });
});
