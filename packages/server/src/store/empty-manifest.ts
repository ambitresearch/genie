/**
 * Empty-manifest seed for `createKit` (DRO-764 AC3).
 *
 * A freshly created kit has zero components — the M3-03 compiler
 * (`../manifest/compiler.ts`) hasn't run yet, and won't until a watcher
 * cycle or an explicit call walks the kit's `components` tree. But the viewer's
 * `file://` and localhost-Vite vehicles (unlike `ui://genie/grid`, which
 * calls `compileManifest` live per request — see `../ui/grid-resource.ts`)
 * only ever `fetch(".genie/manifest.json")` off disk (`static/viewer.js`'s
 * `boot()`). A missing file there is a REJECTED fetch (browsers do not
 * synthesize a 404 Response for a nonexistent `file://` resource — a
 * network error is a rejected promise), which `boot()`'s `.catch` turns
 * into the `.ds-error` "run the genie MCP server against this kit first"
 * message — not the `.ds-empty` "no components yet" state AC3 requires.
 *
 * `create_kit` therefore seeds a valid, empty manifest at creation time —
 * `{version: 1, name, generatedAt, groups: [], components: []}`, BYTE-SHAPE
 * IDENTICAL to what `compileManifest` itself would produce for a kit whose
 * `components/` directory doesn't exist yet (see
 * `manifest/compiler.test.ts`'s "AC4: top-level shape" and "empty
 * components/ dir" cases) — so this is a real, valid manifest snapshot, not
 * a viewer-only special case, and the M3-03 compiler transparently
 * overwrites it the moment any component is actually added.
 *
 * A tiny standalone literal builder — not a call into
 * `../manifest/compiler.ts`'s `compileManifest` — deliberately: that
 * function's job is walking the kit's `components` tree off disk, which for a
 * brand-new kit (no such directory yet) is strictly more IO than a
 * `createKit` call needs to pay just to learn "there are no components",
 * and would introduce a `store/*` → `manifest/*` import direction with no
 * corresponding need elsewhere in this file. Both branches are asserted
 * byte-shape-identical by `empty-manifest.test.ts`, so they cannot silently
 * drift apart.
 */

/** The exact empty-manifest envelope shape `compileManifest` emits for a kit
 * with no `components/` directory yet (`manifest/compiler.ts`'s `Manifest`). */
export interface EmptyManifest {
  version: 1;
  name: string;
  generatedAt: string;
  groups: never[];
  components: never[];
}

/**
 * Build the empty-manifest envelope for a newly created kit (AC3). `name`
 * should be the kit's own name (the same string `createKit` already
 * received) — purely descriptive metadata: `static/viewer.js` never reads
 * this top-level `name` field (only each card's own `name`), so its exact
 * value has no rendering effect; it exists only so a manifest read back off
 * disk looks like a normal compiler snapshot, not a hand-wired special case.
 */
export function buildEmptyManifest(name: string): EmptyManifest {
  return {
    version: 1,
    name,
    generatedAt: new Date().toISOString(),
    groups: [],
    components: [],
  };
}

/** `buildEmptyManifest`, serialized exactly as `compiler.ts`'s
 * `writeManifestAtomic` serializes a real compiled manifest (2-space
 * indent, UTF-8) — so a byte-diff between a seeded and a freshly-compiled
 * empty manifest is whitespace-only. */
export function serializeEmptyManifest(name: string): string {
  return JSON.stringify(buildEmptyManifest(name), null, 2);
}
