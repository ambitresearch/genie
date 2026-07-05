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
    // The viewer's `static/**` assets are browser-native ES modules (M4-03 /
    // DRO-265): they ship verbatim to the Vite viewer and the `ui://genie/grid`
    // resource, so they run in a DOM, not Node. Declare the handful of browser
    // globals they touch (rather than pulling in the whole `globals` package)
    // so `no-undef` doesn't flag the auto-boot guard's `document`/`fetch`.
    files: ["packages/viewer/static/**/*.js"],
    languageOptions: {
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
      },
    },
  },
);
