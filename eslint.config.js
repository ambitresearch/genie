// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // genie source lives in packages/. Everything else (docs/, scripts,
    // build output, the deliverables junk-drawer) is out of lint scope.
    // `packages/*/scripts/**` (build/postbuild Node CLI scripts, e.g. M2-02's
    // emit-component-schema.mjs) follows the same "scripts" carve-out this
    // comment already names — it just previously only had an instance under
    // docs/github/scripts/, which **/dist/** below doesn't reach.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      "packages/*/scripts/**",
      // Root-level build/packaging CLI scripts (e.g. M5-05's
      // scripts/bundle-mcpb.mjs) — same carve-out as the per-package scripts/
      // above, just at the repo root instead of inside a workspace package.
      "scripts/**",
      ".genie/**",
      ".remember/**",
      ".claude/**",
      ".paperclip-runtime/**",
      "**/*.config.js",
      "**/*.config.ts",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The OIDC provider fixture is a standalone Node ESM entrypoint copied
    // directly into its testcontainer image, outside TypeScript's Node globals.
    files: ["packages/e2e/test/support/oidc-provider-image/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },
  {
    // The viewer's `static/**` assets are browser-native scripts (M4-03 /
    // DRO-265): they ship verbatim to the Vite viewer and the `ui://genie/grid`
    // resource, so they run in a DOM, not Node. `viewer.js` is a CLASSIC
    // script (no `type="module"` — DRO-749: a module's relative-src fetch is
    // rejected under `file://`, breaking RFC G-5), so `sourceType: "script"`
    // here matches its actual runtime — it wraps itself in an IIFE and
    // exposes nothing via `import`/`export`. Declare the handful of browser
    // globals it touches (rather than pulling in the whole `globals`
    // package) so `no-undef` doesn't flag the auto-boot guard's
    // `document`/`fetch`.
    files: ["packages/viewer/static/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        document: "readonly",
        fetch: "readonly",
        window: "readonly",
        console: "readonly",
        Event: "readonly",
        Response: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLIFrameElement: "readonly",
        // M4-04 (DRO-266) — the HMR client touches these browser globals: the
        // live-refresh WebSocket and the polling-fallback timers.
        WebSocket: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
);
