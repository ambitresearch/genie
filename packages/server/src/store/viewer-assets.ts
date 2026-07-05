/**
 * Viewer-asset scaffolding for `createKit` (DRO-764).
 *
 * `create_kit` (M1-06) mints a new kit directory but historically wrote only
 * `.kit.json` — never the viewer's static shell. Neither storage adapter nor
 * any other tool filled the gap (the viewer CLI only *validates* a kit dir,
 * it never scaffolds one; no sync tool exists), so a freshly created kit had
 * no `index.html`/`viewer.js`/`viewer.css` and none of RFC G-5's three
 * mandated vehicles (`file://` / `localhost` Vite / `ui://genie/grid`) had
 * anything to render for it. This module is the fix's shared read half: it
 * loads the three files' bytes from `@genie/viewer`'s `static/` directory so
 * both `LocalFsKitStore.createKit` and `GitHostKitStore.createKit` can copy
 * them into a new kit's root as part of creation.
 *
 * ── Optional-peer pattern (mirrors `preview.ts` / `validate/render.ts`) ──────
 * `@genie/viewer` is a workspace devDependency of `@genie/server`, not a
 * runtime dependency — the server core must stay independent of the preview
 * framework (CLAUDE.md; RFC §4). Resolution goes through `import.meta.resolve`
 * with a NON-LITERAL specifier (so `tsc` never hard-resolves it at build) and
 * degrades to an EMPTY array — never throws — when the package can't be
 * found: a kit-creation call must not hard-fail just because the viewer
 * package happens to be absent from a given install (e.g. a pruned production
 * `node_modules`). The gap this fixes is real but non-fatal to the rest of
 * `create_kit`'s contract (the kit itself is still created); a caller that
 * cares can inspect the returned array's length.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One viewer static asset's kit-relative destination path + file bytes. */
export interface ViewerAsset {
  /** Destination path, relative to the kit root (e.g. "index.html"). */
  path: string;
  /** The file's raw bytes, read from `@genie/viewer`'s `static/` directory. */
  content: Buffer;
}

/**
 * The exact three files a kit needs at its root for every RFC G-5 vehicle to
 * have something to render (AC1). Order matches the DRO-764 issue body.
 */
const VIEWER_STATIC_FILES = ["index.html", "viewer.js", "viewer.css"] as const;

/**
 * Structured stderr log — never stdout (see `preview.ts`'s identical rule: on
 * the stdio transport, stdout carries the JSON-RPC frames).
 */
function logStderr(payload: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(payload) + "\n");
}

/**
 * Resolve `@genie/viewer`'s `static/` directory via its `package.json`
 * (rather than a hardcoded `../../../viewer/static` relative climb), so
 * resolution is correct whether this runs under `tsx` (monorepo source) or a
 * packaged `dist/` build where the two packages may not share the same
 * relative layout. Returns `undefined` if `@genie/viewer` cannot be resolved
 * (not installed, pruned, etc.) rather than throwing — the caller degrades to
 * "no viewer assets to copy," not a hard failure.
 */
function resolveViewerStaticDir(): string | undefined {
  // Non-literal specifier: keeps `tsc` from resolving the optional dep at
  // build time, exactly as `preview.ts`'s `defaultViewerBooter` does for the
  // same package.
  const specifier = "@genie/viewer/package.json";
  try {
    const pkgJsonUrl = import.meta.resolve(specifier);
    return join(dirname(fileURLToPath(pkgJsonUrl)), "static");
  } catch (error) {
    logStderr({
      event: "create_kit.viewer_assets.unavailable",
      reason: "viewer-package-not-installed",
      error: String(error),
    });
    return undefined;
  }
}

/**
 * Load the viewer's three static files (AC1) as `{path, content}` pairs ready
 * for a store's write primitive. Reads directly off disk (not through
 * `KitStore`, which doesn't exist yet for a kit that isn't created). Returns
 * `[]` — never throws — when `@genie/viewer` cannot be resolved, or if any
 * individual file is unexpectedly unreadable (a corrupt/partial install):
 * scaffolding is best-effort sugar on top of kit creation, not a precondition
 * for it, matching `preview.ts`'s "boot fails → fall back" degradation
 * philosophy rather than turning a viewer-packaging hiccup into a hard
 * `create_kit` failure.
 */
export async function loadViewerAssets(): Promise<ViewerAsset[]> {
  const staticDir = resolveViewerStaticDir();
  if (staticDir === undefined) return [];

  const assets: ViewerAsset[] = [];
  for (const path of VIEWER_STATIC_FILES) {
    try {
      const content = await readFile(join(staticDir, path));
      assets.push({ path, content });
    } catch (error) {
      logStderr({
        event: "create_kit.viewer_assets.read_failed",
        path,
        error: String(error),
      });
      return []; // Partial scaffolding would be worse than none — all or nothing.
    }
  }
  return assets;
}
