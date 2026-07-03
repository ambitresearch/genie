#!/usr/bin/env node
/**
 * Postbuild step (M2-02, AC7) — emits the compiled `COMPONENT_SCHEMA` as a
 * standalone JSON file at `dist/schemas/component.schema.json`, so a
 * downstream consumer that isn't a TypeScript/Node importer of this package
 * (e.g. a docs generator, a curl-based smoke test, another language's Ajv
 * client) can read the schema without evaluating any JS.
 *
 * Runs *after* `tsc` (see package.json's `build` script) against the
 * compiled `dist/llm/schema.js`, not the `src/` TypeScript source — `tsc`
 * already stripped `COMPONENT_SCHEMA` down to a plain JS object literal by
 * that point, so this script only needs to import and re-serialize it, no
 * TS tooling required here.
 *
 * Accepts two optional CLI args (`<schemaModulePath> <outFilePath>`) so
 * `schema.test.ts` can point `emitComponentSchemaJson` at a small hand-built
 * fixture module instead of the real `dist/` tree — proving the actual
 * read → validate → write logic without depending on `pnpm build` having
 * already run in this process (CI's `test` and `build` matrix legs run as
 * independent jobs from separate fresh checkouts; see `.github/workflows/ci.yml`
 * — `dist/` from one job is never visible to another). The real `build`
 * script (and any local run of this file with no args) still targets the
 * real `dist/llm/schema.js` → `dist/schemas/component.schema.json` pair.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Import `COMPONENT_SCHEMA` from `schemaModulePath` and write it as
 * pretty-printed JSON to `outFilePath` (creating parent directories as
 * needed). Exported so `schema.test.ts` can call it directly against a
 * fixture module, rather than only being able to exercise this logic via a
 * full `node scripts/emit-component-schema.mjs` subprocess spawn.
 */
export async function emitComponentSchemaJson(schemaModulePath, outFilePath) {
  const { COMPONENT_SCHEMA } = await import(pathToFileURL(schemaModulePath).href);

  if (!COMPONENT_SCHEMA || typeof COMPONENT_SCHEMA !== "object") {
    throw new Error(
      `emit-component-schema: COMPONENT_SCHEMA did not import as an object from ${schemaModulePath}`,
    );
  }

  await mkdir(dirname(outFilePath), { recursive: true });
  await writeFile(outFilePath, JSON.stringify(COMPONENT_SCHEMA, null, 2) + "\n", "utf-8");
  return outFilePath;
}

// Only run as a CLI when invoked directly (`node emit-component-schema.mjs`),
// not when `schema.test.ts` imports `emitComponentSchemaJson` from it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const schemaModulePath = process.argv[2] ?? join(here, "..", "dist", "llm", "schema.js");
  const outFilePath =
    process.argv[3] ?? join(here, "..", "dist", "schemas", "component.schema.json");

  const written = await emitComponentSchemaJson(schemaModulePath, outFilePath);
  process.stdout.write(`emit-component-schema: wrote ${written}\n`);
}
