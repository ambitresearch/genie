/**
 * Shared kit-file helpers — MIME classification, SRI hashing, and the
 * default/`.genieignore` exclusion matcher.
 *
 * These were previously split across `tools/read_file.ts` (MIME + binary
 * detection) and `tools/list_files.ts` (SHA-256 SRI hashing, ignore matching).
 * DRO-540 re-plumbs those verbs onto the `KitStore` interface, so the pure
 * logic moves here to be shared by BOTH the `LocalFsKitStore` and
 * `GitHostKitStore` implementations of `readFile`/`listFiles` — a `read_file`
 * or `list_files` result is then byte-identical whichever adapter backs it.
 *
 * Nothing here touches the filesystem or the network; it operates on paths and
 * bytes the adapters supply.
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";
import { lookup } from "mime-types";

import type { FileEncoding } from "./interface.js";

// ─── MIME resolution + text/binary classification ────────────────────────────

/**
 * Extensions that `mime-types` either misidentifies (e.g. `.ts` → `video/mp2t`)
 * or doesn't know at all (`.tsx`, `.mts`, `.cts`). All are source-code text.
 */
const TEXT_EXT_OVERRIDES: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".svelte": "text/x-svelte",
  ".vue": "text/x-vue",
  ".mdx": "text/mdx",
};

/**
 * MIME types (beyond the `text/*` family) that are textual and should be
 * returned as utf-8 rather than base64. `mime-types` labels several source
 * formats with an `application/*` type (e.g. `.cjs` → `application/node`,
 * `.toml` → `application/toml`), so we treat a curated allow-list as text.
 */
const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/node",
  "application/toml",
  "application/yaml",
  "application/x-yaml",
  "application/graphql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/sql",
  "application/manifest+json",
]);

/**
 * Resolve the MIME type for a file path.
 * Prefers our overrides for extensions that `mime-types` misidentifies.
 */
export function resolveMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return TEXT_EXT_OVERRIDES[ext] ?? (lookup(filePath) || "application/octet-stream");
}

/**
 * True when a MIME type is textual (returned as utf-8); everything else is
 * returned as base64. Any MIME parameters (e.g. a `; charset=utf-8` suffix)
 * are stripped before matching.
 */
export function isTextMime(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("text/")) return true;
  if (base.endsWith("+json")) return true;
  if (base.endsWith("+xml")) return true;
  if (base.endsWith("+yaml")) return true;
  return TEXT_APPLICATION_MIMES.has(base);
}

/**
 * Classify raw file bytes into the `{ content, encoding, mimeType }` shape
 * `KitStore.readFile` returns. Text files (by MIME) are decoded to utf-8;
 * everything else is base64-encoded. The MIME type is derived from `path`.
 */
export function classifyFileContent(
  path: string,
  bytes: Buffer,
): { content: string; encoding: FileEncoding; mimeType: string } {
  const mimeType = resolveMime(path);
  if (isTextMime(mimeType)) {
    return { content: bytes.toString("utf-8"), encoding: "utf-8", mimeType };
  }
  return { content: bytes.toString("base64"), encoding: "base64", mimeType };
}

// ─── SRI hashing ─────────────────────────────────────────────────────────────

/**
 * Compute a Subresource-Integrity hash (`sha256-<base64>`) over `bytes` — the
 * exact form `list_files` reports and the M4 viewer's CSP references.
 */
export function sriSha256(bytes: Buffer | string): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

// ─── Default + .genieignore exclusion ────────────────────────────────────────

/** A predicate over a kit-root-relative, forward-slash path. */
export type IgnoreMatcher = (path: string) => boolean;

/**
 * Directories genie always hides from a kit listing regardless of
 * `.genieignore`. `.genie-tmp` is `write_files`' atomic-rename scratch space —
 * excluded so a listing taken mid-write (or after a crash that orphaned a
 * subdir) never surfaces genie's own bookkeeping as kit content.
 */
const DEFAULT_IGNORED_SEGMENTS = ["node_modules", ".git", "dist", ".genie-tmp"];

/**
 * Build a matcher that returns true for any path that should be excluded from a
 * kit listing: the default-ignored dirs plus every `.genieignore` pattern.
 */
export function buildIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const matchers: IgnoreMatcher[] = [
    ...DEFAULT_IGNORED_SEGMENTS.map(segmentMatcher),
    ...patterns.map(patternMatcher),
  ];
  return (path) => matchers.some((matcher) => matcher(path));
}

/**
 * Parse a `.genieignore` file body into its active pattern lines (trimmed,
 * blank + `#`-comment lines dropped). Kept here so both adapters read the same
 * ignore semantics from whatever source (a file on disk, a git-host blob).
 */
export function parseGenieignore(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function segmentMatcher(segment: string): IgnoreMatcher {
  return (path) => path.split("/").includes(segment);
}

function patternMatcher(rawPattern: string): IgnoreMatcher {
  const pattern = rawPattern.replace(/^\/+/, "");
  if (pattern.endsWith("/")) {
    const dir = pattern.replace(/\/+$/, "");
    return (path) => path === dir || path.startsWith(`${dir}/`);
  }
  if (!pattern.includes("*")) {
    return (path) => path === pattern || path.startsWith(`${pattern}/`);
  }
  const regex = globPatternToRegex(pattern);
  return (path) => regex.test(path);
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") return "[^/]*";
      return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}
