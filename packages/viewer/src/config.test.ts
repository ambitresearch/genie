/**
 * Tests for M4-02 (DRO-264) — the `@ambitresearch/genie-viewer` Vite multi-page config
 * (`packages/viewer/src/config.ts`).
 *
 * The config logic lives in a pure factory (`createViewerConfig`) plus helpers
 * (`collectPreviewEntries`, `previewEntryKey`, `parseViewerPortEnv`,
 * `noStoreHtmlPlugin`) rather than inline in `vite.config.ts`, precisely so it
 * is unit-testable WITHOUT booting a real dev server: every AC below is
 * asserted against the returned config object or a fake node req/res, no port
 * binding, no network. The thin root `vite.config.ts` reads env
 * (`GENIE_KIT_ROOT`, `GENIE_VIEWER_PORT`) and calls the factory; its
 * env-parsing is covered two ways — `parseViewerPortEnv` directly (the
 * "parseViewerPortEnv" block) and the assembled default export end-to-end (the
 * "vite.config.ts integration" block, which sets env and dynamically imports
 * the shim).
 *
 * The fixture kit under `test/fixtures/kit/` mirrors the real on-disk kit
 * layout (RFC §14 / PRD FR kit tree): a root `index.html`, two
 * `components/<group>/<Name>/preview.html` cards, plus `styles.css`,
 * `tokens/`, and `_vendor/` so AC5's "serve kit statics at the same path"
 * can be exercised against a realistic tree. `empty-kit/` has only
 * `index.html` so AC2 (root entry always present) is provable with zero
 * component previews.
 *
 * AC coverage map:
 *   - AC1 — rollupOptions.input has one key per globbed
 *           `components/**\/preview.html`, keyed by a filesystem-safe slug.
 *   - AC2 — `index.html` is always in the input, even for an empty kit.
 *   - AC3 — server.port defaults to 5173, is overridable, host is 127.0.0.1.
 *   - AC4 — build.target is "es2022".
 *   - AC5 — config.root is the kit dir, so tokens/ styles.css _vendor/ serve
 *           at the same paths (asserted structurally + the plugin does not
 *           steal them).
 *   - AC6 — the no-store plugin forces `Cache-Control: no-store` on HTML dev
 *           responses (unit-tested against a fake ServerResponse).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it, afterEach, vi } from "vitest";
import type { UserConfig } from "vite";

import {
  BUILD_TARGET,
  collectPreviewEntries,
  createViewerConfig,
  DEFAULT_HOST,
  DEFAULT_VIEWER_PORT,
  noStoreHtmlPlugin,
  noViteClientPlugin,
  parseViewerPortEnv,
  previewEntryKey,
  stripViteClientScript,
} from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "../test/fixtures/kit");
const EMPTY_KIT = resolve(HERE, "../test/fixtures/empty-kit");

/** Minimal stand-in for node's ServerResponse used to drive the AC6 plugin. */
interface FakeRes {
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
}

function createFakeRes(): FakeRes {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name, value) {
      // Mirror node's case-insensitive header semantics: last write wins,
      // keyed by lowercased name.
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
  };
}

describe("previewEntryKey", () => {
  it("slugifies a nested preview path into a filesystem-safe rollup key", () => {
    expect(previewEntryKey("components/actions/Button/preview.html")).toBe(
      "components_actions_Button_preview_html",
    );
  });

  it("normalises Windows-style separators to the same slug", () => {
    expect(previewEntryKey("components\\actions\\Button\\preview.html")).toBe(
      previewEntryKey("components/actions/Button/preview.html"),
    );
  });

  it("produces distinct keys for distinct component paths", () => {
    expect(previewEntryKey("components/a/X/preview.html")).not.toBe(
      previewEntryKey("components/b/X/preview.html"),
    );
  });
});

describe("collectPreviewEntries (AC1)", () => {
  it("globs every components/**/preview.html under the kit root", () => {
    const entries = collectPreviewEntries(KIT);
    expect(entries).toEqual(
      expect.arrayContaining([
        "components/actions/Button/preview.html",
        "components/surfaces/Card/preview.html",
      ]),
    );
    expect(entries).toHaveLength(2);
  });

  it("returns POSIX-style relative paths (forward slashes) regardless of OS", () => {
    for (const entry of collectPreviewEntries(KIT)) {
      expect(entry).not.toContain("\\");
      expect(entry.startsWith("components/")).toBe(true);
    }
  });

  it("returns a stable (sorted) order so the config snapshot is deterministic", () => {
    const entries = collectPreviewEntries(KIT);
    expect(entries).toEqual([...entries].sort());
  });

  it("returns an empty list for a kit with no component previews", () => {
    expect(collectPreviewEntries(EMPTY_KIT)).toEqual([]);
  });
});

describe("createViewerConfig", () => {
  it("AC1: populates rollupOptions.input with one key per preview.html", () => {
    const config = createViewerConfig({ root: KIT });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input).toBeTypeOf("object");
    expect(input.components_actions_Button_preview_html).toBe(
      resolve(KIT, "components/actions/Button/preview.html"),
    );
    expect(input.components_surfaces_Card_preview_html).toBe(
      resolve(KIT, "components/surfaces/Card/preview.html"),
    );
  });

  it("AC1: input values are absolute paths resolved against the kit root", () => {
    const config = createViewerConfig({ root: KIT });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    for (const value of Object.values(input)) {
      expect(resolve(value)).toBe(value); // already absolute
      expect(value.startsWith(KIT)).toBe(true);
    }
  });

  it("AC2: index.html is always the root entry, even with component previews", () => {
    const config = createViewerConfig({ root: KIT });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input.main).toBe(resolve(KIT, "index.html"));
  });

  it("AC2: index.html is still present for an empty kit (no components)", () => {
    const config = createViewerConfig({ root: EMPTY_KIT });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input).toEqual({ main: resolve(EMPTY_KIT, "index.html") });
  });

  it("AC3: defaults the dev server port to 5173", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.server?.port).toBe(DEFAULT_VIEWER_PORT);
    expect(DEFAULT_VIEWER_PORT).toBe(5173);
  });

  it("AC3: honours an explicit --port override", () => {
    const config = createViewerConfig({ root: KIT, port: 4321 });
    expect(config.server?.port).toBe(4321);
  });

  it("AC3: binds host 127.0.0.1 (no LAN exposure) by default", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.server?.host).toBe("127.0.0.1");
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("AC3: does not force strictPort — port fallback is M4-08's job", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.server?.strictPort).toBe(false);
  });

  it("M4-04: disables Vite's built-in HMR transport", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.server?.hmr).toBe(false);
  });

  it("AC4: builds for the ES2022 target", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.build?.target).toBe("es2022");
    expect(BUILD_TARGET).toBe("es2022");
  });

  it("AC5: sets root to the kit dir so tokens/, styles.css, _vendor/ serve at the same paths", () => {
    const config = createViewerConfig({ root: KIT });
    expect(config.root).toBe(KIT);
  });

  it("AC5: does not hijack publicDir (would shadow kit-root statics)", () => {
    // Leaving publicDir at Vite's default (<root>/public) means the kit's own
    // tokens/ styles.css _vendor/ resolve as ordinary root-relative statics.
    // Setting it to the kit root itself would double-serve and is a smell.
    const config = createViewerConfig({ root: KIT });
    expect(config.publicDir).not.toBe(KIT);
  });

  it("AC6: registers the no-store HTML plugin", () => {
    const config = createViewerConfig({ root: KIT });
    const names = (config.plugins ?? [])
      .flat()
      .map((p) => (p && typeof p === "object" && "name" in p ? p.name : undefined));
    expect(names).toContain("genie-viewer:no-store-html");
  });

  it("M4-04 (DRO-266): registers the per-card HMR plugin", () => {
    // The HMR bridge (WebSocket on /__genie_hmr) is a serve-only plugin wired
    // in alongside the no-store one; assert it's present by name so a
    // regression that drops it from the plugins array trips here rather than
    // silently disabling live per-card refresh.
    const config = createViewerConfig({ root: KIT });
    const names = (config.plugins ?? [])
      .flat()
      .map((p) => (p && typeof p === "object" && "name" in p ? p.name : undefined));
    expect(names).toContain("genie-viewer:hmr");
  });

  it("M4-04: registers the post-transform that removes Vite's reload client", () => {
    const config = createViewerConfig({ root: KIT });
    const names = (config.plugins ?? [])
      .flat()
      .map((p) => (p && typeof p === "object" && "name" in p ? p.name : undefined));
    expect(names).toContain("genie-viewer:no-vite-client");
  });

  it("is JSON-serialisable in its data-only shape (config snapshot)", () => {
    // The DoD asks for a "config snapshot test". Snapshot the serialisable
    // core (paths made root-relative so the snapshot is host-independent);
    // plugins/functions are asserted separately above.
    const config = createViewerConfig({ root: KIT });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    const relInput = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v.slice(KIT.length + 1)]),
    );
    expect({
      rootIsKit: config.root === KIT,
      appType: config.appType,
      server: {
        host: config.server?.host,
        port: config.server?.port,
        strictPort: config.server?.strictPort,
      },
      build: { target: config.build?.target },
      input: relInput,
    }).toMatchInlineSnapshot(`
      {
        "appType": "mpa",
        "build": {
          "target": "es2022",
        },
        "input": {
          "components_actions_Button_preview_html": "components/actions/Button/preview.html",
          "components_surfaces_Card_preview_html": "components/surfaces/Card/preview.html",
          "main": "index.html",
        },
        "rootIsKit": true,
        "server": {
          "host": "127.0.0.1",
          "port": 5173,
          "strictPort": false,
        },
      }
    `);
  });

  describe("noViteClientPlugin", () => {
    it("removes Vite's injected client while preserving card markup", () => {
      const html =
        '<!doctype html><head><script type="module" src="/@vite/client"></script>' +
        "</head><body>Card</body>";
      expect(stripViteClientScript(html)).toBe("<!doctype html><head></head><body>Card</body>");
    });

    it("uses a post HTML transform so it runs after Vite injection", () => {
      const plugin = noViteClientPlugin();
      expect(plugin.transformIndexHtml).toMatchObject({ order: "post" });
    });
  });
});

describe("noStoreHtmlPlugin (AC6)", () => {
  /**
   * The plugin wraps `res.setHeader` so that whenever Vite's send() helper
   * sets `Content-Type: text/html` (default cache is `no-cache`), the value is
   * coerced to `no-store`. We simulate that exact call order against a fake
   * res: install the wrapper, then replay Vite's own setHeader sequence.
   */
  function runMiddleware(res: FakeRes, url = "/components/actions/Button/preview.html"): void {
    const plugin = noStoreHtmlPlugin();
    const server = {
      middlewares: {
        stack: [] as Array<{ handle: (req: unknown, res: unknown, next: () => void) => void }>,
        use(handle: (req: unknown, res: unknown, next: () => void) => void) {
          this.stack.push({ handle });
          return this;
        },
      },
    };
    // Vite calls configureServer(server); the plugin registers a middleware.
    (plugin.configureServer as (s: typeof server) => void)(server);
    expect(server.middlewares.stack).toHaveLength(1);
    let nexted = false;
    server.middlewares.stack[0]!.handle({ url }, res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true); // middleware must always call next()
  }

  it("forces Cache-Control: no-store once the response is typed text/html", () => {
    const res = createFakeRes();
    runMiddleware(res);
    // Replay Vite's send(): Content-Type first, then its default Cache-Control.
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-cache");
    expect(res.getHeader("Cache-Control")).toBe("no-store");
  });

  it("coerces no-store even when Content-Type carries a charset", () => {
    const res = createFakeRes();
    runMiddleware(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    expect(res.getHeader("Cache-Control")).toBe("no-store");
  });

  it("leaves Cache-Control untouched for non-HTML responses (JS modules)", () => {
    const res = createFakeRes();
    runMiddleware(res, "/components/actions/Button/preview.html?import");
    res.setHeader("Content-Type", "text/javascript");
    res.setHeader("Cache-Control", "no-cache");
    expect(res.getHeader("Cache-Control")).toBe("no-cache");
  });

  it("still sets no-store when Cache-Control is set before Content-Type", () => {
    // Header order is an implementation detail of whatever writes the response;
    // the guarantee must hold regardless of which header lands first.
    const res = createFakeRes();
    runMiddleware(res);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/html");
    expect(res.getHeader("Cache-Control")).toBe("no-store");
  });

  it("does not invent a Cache-Control header when none is HTML-typed", () => {
    const res = createFakeRes();
    runMiddleware(res);
    res.setHeader("Content-Type", "application/json");
    expect(res.getHeader("Cache-Control")).toBeUndefined();
  });
});

describe("parseViewerPortEnv (AC3 — env shim)", () => {
  it("parses a valid numeric port string", () => {
    expect(parseViewerPortEnv("4321")).toBe(4321);
  });

  it("returns undefined when unset (so the factory default applies)", () => {
    expect(parseViewerPortEnv(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-numeric value (degrades, does not throw)", () => {
    expect(parseViewerPortEnv("not-a-port")).toBeUndefined();
    expect(parseViewerPortEnv("3000abc")).toBeUndefined();
  });

  it("returns undefined for an empty / whitespace value (Number('') is 0, rejected)", () => {
    // Guarding the real-world `GENIE_VIEWER_PORT=` (set-but-empty) case, which
    // must NOT collapse to port 0.
    expect(parseViewerPortEnv("")).toBeUndefined();
    expect(parseViewerPortEnv("   ")).toBeUndefined();
  });

  it("returns undefined for a non-integer value", () => {
    expect(parseViewerPortEnv("3000.5")).toBeUndefined();
  });

  it("returns undefined for out-of-range ports (<=0 or >65535)", () => {
    expect(parseViewerPortEnv("0")).toBeUndefined();
    expect(parseViewerPortEnv("-1")).toBeUndefined();
    expect(parseViewerPortEnv("65536")).toBeUndefined();
  });

  it("accepts the boundary ports 1 and 65535", () => {
    expect(parseViewerPortEnv("1")).toBe(1);
    expect(parseViewerPortEnv("65535")).toBe(65535);
  });
});

describe("vite.config.ts integration (env shim → factory)", () => {
  /**
   * Drives the real root `vite.config.ts` — the file AC1 names — end to end:
   * sets `GENIE_KIT_ROOT` / `GENIE_VIEWER_PORT`, dynamically imports the shim
   * (Vite's `defineConfig` returns its argument untouched, so the default
   * export is the assembled `UserConfig`), and asserts the env actually flows
   * into the config. `vi.resetModules()` guarantees a fresh evaluation per
   * case, since the shim reads `process.env` at module-eval time.
   */
  const REAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...REAL_ENV };
    vi.resetModules();
  });

  async function loadViteConfig(): Promise<UserConfig> {
    vi.resetModules();
    const mod = (await import("../vite.config.js")) as { default: UserConfig };
    return mod.default;
  }

  it("threads GENIE_KIT_ROOT into config.root and globs that kit's previews", async () => {
    process.env.GENIE_KIT_ROOT = KIT;
    delete process.env.GENIE_VIEWER_PORT;
    const config = await loadViteConfig();
    expect(config.root).toBe(KIT);
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input.main).toBe(resolve(KIT, "index.html"));
    expect(input.components_actions_Button_preview_html).toBe(
      resolve(KIT, "components/actions/Button/preview.html"),
    );
  });

  it("threads a valid GENIE_VIEWER_PORT into server.port", async () => {
    process.env.GENIE_KIT_ROOT = KIT;
    process.env.GENIE_VIEWER_PORT = "4321";
    const config = await loadViteConfig();
    expect(config.server?.port).toBe(4321);
  });

  it("falls back to the 5173 default when GENIE_VIEWER_PORT is malformed", async () => {
    process.env.GENIE_KIT_ROOT = KIT;
    process.env.GENIE_VIEWER_PORT = "not-a-port";
    const config = await loadViteConfig();
    expect(config.server?.port).toBe(DEFAULT_VIEWER_PORT);
  });

  it("defaults kit root to process.cwd() when GENIE_KIT_ROOT is unset", async () => {
    delete process.env.GENIE_KIT_ROOT;
    delete process.env.GENIE_VIEWER_PORT;
    const config = await loadViteConfig();
    expect(config.root).toBe(resolve(process.cwd()));
  });
});
