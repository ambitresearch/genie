#!/usr/bin/env node
/**
 * Postbuild step (M2-03, AC5) — copies the versioned LLM system prompts
 * (`src/llm/prompts/*.md`) into `dist/llm/prompts/`, so the compiled server can
 * `readFileSync` them at runtime resolved relative to `import.meta.url`.
 *
 * `tsc` only emits `.js`/`.d.ts` from `.ts` sources — it never copies
 * non-TypeScript assets — so without this step the `*.system.md` prompts
 * `prompts.ts` loads would be absent from `dist/` and `conjure` would throw at
 * first call in a built (non-`tsx`) deployment. Under `tsx`/dev the loader reads
 * straight from `src/llm/prompts/`, so this only matters for the packaged build,
 * which is exactly when it runs (chained after `tsc` in package.json's `build`).
 *
 * Deliberately dependency-free (plain `node:fs`) and idempotent: it mirrors
 * every file under `src/llm/prompts/` into `dist/llm/prompts/`, overwriting.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "llm", "prompts");
const outDir = join(here, "..", "dist", "llm", "prompts");

await mkdir(outDir, { recursive: true });
// `recursive` copies the whole prompts tree (*.system.md + CHANGELOG.md);
// harmless extra files (the changelog) travel along, which is fine.
await cp(srcDir, outDir, { recursive: true });
process.stdout.write(`copy-prompts: mirrored ${srcDir} -> ${outDir}\n`);
