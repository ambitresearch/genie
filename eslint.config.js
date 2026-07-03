// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // genie source lives in packages/. Everything else (docs/, scripts,
    // build output, the deliverables junk-drawer) is out of lint scope.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      ".remember/**",
      ".claude/**",
      ".paperclip-runtime/**",
      "**/*.config.js",
      "**/*.config.ts",
      // Build-time tooling that runs against `dist/` under plain Node —
      // needs Node globals (process, etc.) but isn't part of the shipped
      // source we lint. Matches the intent behind the config-file ignore.
      "packages/*/scripts/**",
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
);
