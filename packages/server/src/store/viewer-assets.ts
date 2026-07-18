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
 * loads the three files' bytes from the shell copied into the server package,
 * falling back to `@genie/viewer`'s `static/` directory during source
 * development, so both stores can copy them into a new kit's root.
 *
 * ── Optional-peer pattern (mirrors `preview.ts` / `validate/render.ts`) ──────
 * `@genie/viewer` is a workspace devDependency of `@genie/server`, not a
 * runtime dependency. Production reads `dist/ui/viewer-static`, mirrored by
 * `copy-viewer-assets.mjs`; source development resolves the optional package
 * through `import.meta.resolve` with a non-literal specifier. If neither
 * payload is available, loading degrades to an empty array rather than making
 * kit creation fail.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One viewer static asset's kit-relative destination path + file bytes. */
export interface ViewerAsset {
  /** Destination path, relative to the kit root (e.g. "index.html"). */
  path: string;
  /** The file's raw bytes from the packaged or workspace viewer shell. */
  content: Buffer;
}

/**
 * The exact three files a kit needs at its root for every RFC G-5 vehicle to
 * have something to render (AC1). Order matches the DRO-764 issue body.
 */
const VIEWER_STATIC_FILES = ["index.html", "viewer.js", "viewer.css"] as const;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_STATIC_DIR = join(MODULE_DIR, "..", "ui", "viewer-static");
const IS_PACKAGED_BUILD = basename(join(MODULE_DIR, "..")) === "dist";

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
function resolveViewerPackageStaticDir(): string | undefined {
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
 * `[]` — never throws — when neither shell can be loaded, or if any individual
 * file is unexpectedly unreadable (a corrupt/partial install):
 * scaffolding is best-effort sugar on top of kit creation, not a precondition
 * for it, matching `preview.ts`'s "boot fails → fall back" degradation
 * philosophy rather than turning a viewer-packaging hiccup into a hard
 * `create_kit` failure.
 */
export async function loadViewerAssets(): Promise<ViewerAsset[]> {
  try {
    return await readViewerAssets(BUNDLED_STATIC_DIR);
  } catch (error) {
    if (IS_PACKAGED_BUILD) {
      logStderr({
        event: "create_kit.viewer_assets.read_failed",
        source: "bundled-server",
        staticDir: BUNDLED_STATIC_DIR,
        error: String(error),
      });
    }
    // Source/tsx development has no dist/ui payload; use the workspace package.
  }

  const staticDir = resolveViewerPackageStaticDir();
  if (staticDir === undefined) return [];

  try {
    return await readViewerAssets(staticDir);
  } catch (error) {
    logStderr({
      event: "create_kit.viewer_assets.read_failed",
      source: "optional-viewer-package",
      staticDir,
      error: String(error),
    });
    return [];
  }
}

async function readViewerAssets(staticDir: string): Promise<ViewerAsset[]> {
  const assets: ViewerAsset[] = [];
  for (const path of VIEWER_STATIC_FILES) {
    const content = await readFile(join(staticDir, path));
    assets.push({ path, content });
  }
  return assets;
}
