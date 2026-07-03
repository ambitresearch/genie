/**
 * Emit `dist/schemas/component.schema.json` from the compiled COMPONENT_SCHEMA
 * (M2-02 AC7).
 *
 * Runs as the `postbuild` step so it happens exactly once per `pnpm build`,
 * after `tsc` has produced `dist/llm/schema.js` — that compiled module is the
 * one source of truth for the shape (the same one `conjure`/M2-07 import at
 * runtime), so re-serialising it here guarantees the on-disk JSON file
 * cannot drift from what the server actually validates against.
 *
 * Design notes:
 *   - Written in plain Node ESM (not tsx) so it runs from `dist/` without
 *     needing tsx as a runtime dep.
 *   - Idempotent: overwrites the file on every run.
 *   - Non-zero exit on failure so a broken build fails CI instead of
 *     silently shipping an empty package.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Emitting from the built module — NOT the .ts source — so this script sees
// exactly the shape the server ships. The relative hop matches the layout
// `tsc -p tsconfig.json` produces (`packages/server/dist/llm/schema.js`).
const here = dirname(fileURLToPath(import.meta.url));
const compiledSchemaModule = resolve(here, "..", "dist", "llm", "schema.js");

const { COMPONENT_SCHEMA } = /** @type {{ COMPONENT_SCHEMA: unknown }} */ (
  await import(compiledSchemaModule)
);

const outDir = resolve(here, "..", "dist", "schemas");
const outFile = resolve(outDir, "component.schema.json");

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify(COMPONENT_SCHEMA, null, 2) + "\n", "utf-8");

process.stdout.write(`emit-component-schema: wrote ${outFile}\n`);
