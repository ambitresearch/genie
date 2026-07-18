import { readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";

const bundlePath = process.argv[2];
if (!bundlePath) throw new Error("Usage: pack-ts-morph-runtime.mjs <runtime.mjs>");

const source = await readFile(bundlePath);
await writeFile(
  `${bundlePath}.br`,
  brotliCompressSync(source, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }),
);

const loader = [
  'import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";',
  'import { tmpdir } from "node:os";',
  'import { join } from "node:path";',
  'import { brotliDecompressSync } from "node:zlib";',
  'import { fileURLToPath, pathToFileURL } from "node:url";',
  'const payloadPath = fileURLToPath(new URL("./runtime.mjs.br", import.meta.url));',
  'const runtimeDir = await mkdtemp(join(tmpdir(), "genie-ts-morph-"));',
  'const runtimePath = join(runtimeDir, "runtime.mjs");',
  "await writeFile(runtimePath, brotliDecompressSync(await readFile(payloadPath)));",
  "let runtime;",
  "try {",
  "  runtime = await import(pathToFileURL(runtimePath).href);",
  "} finally {",
  "  await rm(runtimeDir, { recursive: true, force: true });",
  "}",
  "export const Project = runtime.Project;",
  "export const ts = runtime.ts;",
  "",
].join("\n");

await writeFile(bundlePath, loader);
