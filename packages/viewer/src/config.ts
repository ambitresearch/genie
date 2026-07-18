/**
 * M4-02 (DRO-264) — `@ambitresearch/genie-viewer` Vite multi-page dev config.
 *
 * Serves a kit directory (`<kit-dir>`) so that every
 * `components/**\/*.html` preview is its own Vite entry point, in addition to
 * the always-present root `index.html`. Vite supports this natively — "each
 * `index.html` is treated as source code and part of the module graph"
 * (vite.dev/guide) — so all we do is enumerate the previews and hand Rollup
 * the `input` map. (DRO-821: the glob is `*.html`, not `preview.html`, to match
 * the server compiler's real `<Name>.html` output — see {@link PREVIEW_GLOB}.)
 *
 * WHY a factory (`createViewerConfig`) instead of inlining everything in
 * `vite.config.ts`: the config is pure, deterministic data derived from a kit
 * root, and the issue's DoD asks for a "config snapshot test". Keeping the
 * logic here lets `config.test.ts` assert the whole shape — the glob-built
 * input map, the host/port, the ES2022 target, the no-store plugin — WITHOUT
 * binding a port or spawning a server. The root `vite.config.ts` is then a
 * three-line shim that reads env and calls this.
 *
 * SCOPE (this issue is config-only): no dev-server *boot*, port-fallback,
 * auto-open, or Ctrl-C teardown — those are the polished CLI's ACs (M4-08),
 * exactly as the M4-01 scaffold header reserved them. `strictPort` is left
 * `false` here precisely so M4-08 owns the EADDRINUSE → 5174… walk (RFC §14
 * "Port selection") rather than this file failing hard on a busy port.
 */
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import fg from "fast-glob";
import type { Plugin, UserConfig } from "vite";

import { createHmrPlugin } from "./hmr-plugin.js";

/** RFC §6.9 / §14 default dev-server port. Overridable via `--port` (M4-08). */
export const DEFAULT_VIEWER_PORT = 5173;

/**
 * Loopback bind address. AC3 mandates `127.0.0.1` (no LAN exposure) — a kit
 * preview is a single-developer, local-only surface, so we never bind `0.0.0.0`
 * by default. (Vite's own default is `localhost`, which can resolve to an
 * external interface on some setups; pinning the literal IP is deliberate.)
 */
export const DEFAULT_HOST = "127.0.0.1";

/** AC4 — the previews are authored against modern browsers; ship ES2022. */
export const BUILD_TARGET = "es2022";

/**
 * The preview-file glob, relative to the kit root.
 *
 * DRO-821 — this MUST mirror the server manifest compiler's own discovery walk
 * (`packages/server/src/manifest/compiler.ts` → `walkPreviewFiles`), which cards
 * every `components/**\/*.html` that carries a valid `@genie` marker. The real
 * `conjure`/`refine` path emits a component's preview as `<Name>.html` (e.g.
 * `components/actions/Button/Button.html`) — forced by the LLM `response_format`
 * schema's `^…/([A-Z][A-Za-z0-9]{1,63})/\1\.html$` `contains` constraint
 * (`server/src/llm/schema.ts`), so the model literally cannot emit a `preview.html`.
 * AC1's original `components/**\/preview.html` therefore globbed ZERO entries
 * against a real server-generated kit (the grid rendered empty); it only ever
 * worked because every hand-authored fixture used `preview.html`.
 *
 * `*.html` is the tightest superset that can't MISS a real card path: it matches
 * both the native `<Name>.html` AND the DesignSync-compat `preview.html`, exactly
 * as the compiler's walk does. A marker-less `.html` it over-includes becomes an
 * unused Rollup input (never referenced by a manifest card, so never iframed) —
 * harmless. Card *identity* stays owned by `.genie/manifest.json`, whose
 * `components[].path` the grid keys off directly; this glob only decides which
 * files Vite is willing to serve/transform as entries.
 */
const PREVIEW_GLOB = "components/**/*.html";

/**
 * Turns a kit-relative preview path into a Rollup `input` key that is safe as
 * a chunk name: path separators AND dots collapse to underscores, so
 * `components/actions/Button/preview.html` →
 * `components_actions_Button_preview_html`. Dots are folded too (not just
 * slashes as in the RFC sketch) because a dotted input key leaks into Rollup's
 * generated file names.
 */
export function previewEntryKey(previewPath: string): string {
  return previewPath.replace(/[/\\.]/g, "_");
}

/**
 * Globs every `components/**\/*.html` under `kitRoot`, returning
 * kit-relative POSIX paths (forward slashes on every OS — fast-glob
 * guarantees this) in a stable sorted order so the derived config is
 * deterministic (and its snapshot test doesn't flake on FS iteration order).
 * A kit with no component previews yields `[]`; the root `index.html` entry is
 * added by {@link createViewerConfig}, not here. See {@link PREVIEW_GLOB} for
 * why the glob is `*.html` (the server's real preview filename) rather than the
 * hand-authored fixtures' `preview.html`.
 */
export function collectPreviewEntries(kitRoot: string): string[] {
  return fg
    .sync(PREVIEW_GLOB, {
      cwd: kitRoot,
      onlyFiles: true,
      // Kit dirs like `_vendor/` start with `_`, not `.`; the previews we want
      // never live under a dotfile dir, so the default (dot:false) is correct
      // and keeps `.genie/` bookkeeping out of the entry set.
    })
    .sort();
}

/**
 * Parses a `GENIE_VIEWER_PORT`-style env value into a port number, or
 * `undefined` when it is absent or not a usable port so the caller falls back
 * to {@link DEFAULT_VIEWER_PORT}.
 *
 * Deliberately LENIENT (returns `undefined` on garbage rather than throwing):
 * an env var is ambient config, so a malformed value degrades to the default
 * instead of crashing the dev server. This is the opposite of `cli.ts`'s
 * `parsePort`, which throws — an explicit `--port` flag typo SHOULD be a hard
 * error, but a stray env value should not. `Number("")`/`Number("  ")` are `0`
 * (rejected by `> 0`); `Number("3000abc")` is `NaN`; `"3000.5"` is non-integer
 * — all fall through to `undefined`.
 *
 * Extracted here (rather than inlined in `vite.config.ts`) precisely so the
 * env-parsing branches are unit-testable without importing the config shim.
 */
export function parseViewerPortEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return undefined;
}

/** Inputs to {@link createViewerConfig}. `root` is the kit directory to serve. */
export interface ViewerConfigOptions {
  /** Absolute or relative path to the `<kit-dir>` to preview. */
  root: string;
  /** Dev-server port (AC3). Defaults to {@link DEFAULT_VIEWER_PORT}. */
  port?: number;
  /** Bind address (AC3). Defaults to {@link DEFAULT_HOST}. */
  host?: string;
}

/**
 * AC6 — a dev-only plugin that forces `Cache-Control: no-store` on every HTML
 * response. Vite's `send()` helper types HTML and then sets
 * `Cache-Control: no-cache` (browsers may still round-trip a 304 revalidate);
 * for a live card grid we want the browser to NEVER reuse a cached preview, so
 * we coerce it to `no-store`.
 *
 * We key off the response's `Content-Type` (set by whatever serves the HTML)
 * rather than the URL, so it catches `/` (→ index.html), each
 * `.../preview.html`, and any future HTML route uniformly — and never touches
 * JS/CSS module responses. The `setHeader` wrapper handles both header orders
 * (Content-Type before or after Cache-Control), since ordering is an
 * implementation detail of the responder.
 */
export function noStoreHtmlPlugin(): Plugin {
  return {
    name: "genie-viewer:no-store-html",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        (_req: IncomingMessage, res: ServerResponse, next: () => void): void => {
          const setHeader = res.setHeader.bind(res);
          let isHtml = false;
          let cacheControlSeen = false;

          res.setHeader = function patchedSetHeader(
            name: string,
            value: number | string | ReadonlyArray<string>,
          ): ServerResponse {
            const lower = String(name).toLowerCase();

            if (lower === "content-type" && /text\/html/i.test(String(value))) {
              isHtml = true;
              // Content-Type arrived after Cache-Control was already set —
              // retroactively fix the stale no-cache.
              if (cacheControlSeen) {
                setHeader("Cache-Control", "no-store");
              }

              return setHeader(name, value);
            }

            if (lower === "cache-control") {
              cacheControlSeen = true;
              if (isHtml) {
                return setHeader("Cache-Control", "no-store");
              }
            }

            return setHeader(name, value);
          } as typeof res.setHeader;

          next();
        },
      );
    },
  };
}

const VITE_CLIENT_SCRIPT = /<script\b[^>]*\bsrc=(["'])\/@vite\/client\1[^>]*><\/script>\s*/gi;

/** Remove Vite's injected full-reload client; genie owns card refreshes. */
export function stripViteClientScript(html: string): string {
  return html.replace(VITE_CLIENT_SCRIPT, "");
}

/** Run after Vite's built-in HTML transform so the injected client is present. */
export function noViteClientPlugin(): Plugin {
  return {
    name: "genie-viewer:no-vite-client",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler: stripViteClientScript,
    },
  };
}

/**
 * Builds the Vite dev config for a kit directory (see the file header for the
 * why). Pure and deterministic: same `root` in → same config out.
 */
export function createViewerConfig(options: ViewerConfigOptions): UserConfig {
  const root = resolve(options.root);

  // AC1/AC2 — the Rollup input map: the always-present root `index.html`
  // (`main`) plus one entry per globbed component preview.
  const input: Record<string, string> = {
    main: resolve(root, "index.html"),
  };
  for (const entry of collectPreviewEntries(root)) {
    input[previewEntryKey(entry)] = resolve(root, entry);
  }

  return {
    // AC5 — root is the kit dir, so its `tokens/`, `styles.css`, and `_vendor/`
    // are served as ordinary root-relative statics at the same paths a
    // `file://` open would use (RFC G-5 "one artefact, three vehicles").
    // publicDir is intentionally left at Vite's default (<root>/public) — NOT
    // repointed at the kit root, which would double-serve every file.
    root,
    // A kit is a genuine multi-page app: no SPA history fallback (a missing
    // card should 404, not silently return index.html).
    appType: "mpa",
    server: {
      host: options.host ?? DEFAULT_HOST,
      port: options.port ?? DEFAULT_VIEWER_PORT,
      // Port-fallback (EADDRINUSE → next port) is M4-08's CLI concern.
      strictPort: false,
      // Disable Vite's built-in HMR transport. Vite 8 still injects its client
      // script with this flag, so noViteClientPlugin removes that script below.
      hmr: false,
    },
    build: {
      target: BUILD_TARGET,
      rollupOptions: { input },
    },
    // AC6 (M4-02) — never let the browser reuse a cached preview; M4-04 (DRO-266)
    // — the per-card HMR bridge (a WebSocket on `/__genie_hmr`, driven by Vite's
    // own file watcher). All are `apply: "serve"`, so `vite build` never sees
    // them.
    plugins: [noStoreHtmlPlugin(), noViteClientPlugin(), createHmrPlugin()],
  };
}
