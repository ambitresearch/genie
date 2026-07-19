#!/usr/bin/env node
/**
 * Postbuild step — mirror the byte-identical viewer shell into the server
 * package so `ui://genie/grid` remains executable without a runtime
 * `@ambitresearch/genie-viewer` installation. The local Vite booter stays optional; only the
 * three self-contained MCP App assets are packaged here.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "viewer", "static");
const outDir = join(here, "..", "dist", "ui", "viewer-static");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(srcDir, outDir, { recursive: true });
process.stdout.write(`copy-viewer-assets: mirrored ${srcDir} -> ${outDir}\n`);
