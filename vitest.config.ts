import { defineConfig } from "vitest/config";

// AC8 (M1-14 / DRO-240): emit a JUnit XML report so CI can upload the M1
// conformance run as a build artefact. Gated on an env flag so a normal local
// `pnpm test` keeps vitest's readable default reporter and writes no files;
// CI (and anyone who wants the file) opts in by setting `VITEST_JUNIT=1`
// (the `ci.yml` `test` job does exactly this before archiving `reports/`).
const junitEnabled = process.env.VITEST_JUNIT === "1" || process.env.CI === "true";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Keep the default console reporter for humans; add `junit` (a vitest
    // built-in, no extra dependency) only when the report is wanted, so its
    // `outputFile` never clutters a local working tree.
    reporters: junitEnabled ? ["default", "junit"] : ["default"],
    outputFile: junitEnabled ? { junit: "reports/junit.xml" } : undefined,
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
