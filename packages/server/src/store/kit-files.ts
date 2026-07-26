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

/** Strict base64 validation shared by tool-boundary and generated-file checks. */
export function isValidBase64Content(data: string): boolean {
  if (data.length === 0) return true;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0;
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

// ─── kitId traversal safety ──────────────────────────────────────────────────

/**
 * The ONE kitId-safety rule shared by EVERY kit-taking tool AND both `KitStore`
 * adapters, so their traversal defenses cannot silently drift apart (DRO-509 /
 * DRO-581 unification). Lives here — not in a tool module — because the store
 * layer (post-#114) also needs it, and `store/*` must not import from `tools/*`.
 *
 * This is the *containment* rule and it is the correct INPUT gate. It is not
 * `KIT_ID_PATTERN` (`tools/get_kit.ts`), which is a *shape* rule describing the
 * ids `create_kit` mints; `KitId` is an opaque, adapter-assigned string and
 * `list_kits` promises what it returns is valid input everywhere, so gating
 * input on the mint shape makes an imported kit like `My_Kit.2` visible but
 * unusable.
 *
 * A `kitId` names a single directory (LocalFs) or repo (git host) directly
 * under the store's kits root. `isSafeKitId` returns false for exactly the ids
 * that would let a caller escape that single-kit namespace:
 *
 *   - the empty string — `join(kitsRoot, "")` is the kits ROOT itself, so an
 *     empty kitId plus a crafted `path` (e.g. `other-kit/secret.txt`) would
 *     read across sibling kits; it names no kit and is rejected;
 *   - `.` or `..` exactly — the traversal aliases for "this dir" / "the parent",
 *     which also resolve to the root or above it;
 *   - any id containing a path separator (`/` or `\`), which could introduce a
 *     nested or absolute path.
 *
 * Ids that merely EMBED dots (`my..kit`, `..kit`, `kit..`) stay a literal child
 * of the root and are allowed — they simply resolve to a not-found kit if
 * absent. This is deliberately looser than the pre-unification `read_file`
 * guard (`kitId.includes("..")`), which over-rejected `my..kit` yet — crucially
 * — MISSED both `""` and `.` (neither contains `..`), the exact holes that
 * enabled the cross-kit read this rule closes.
 *
 * A predicate (not a throwing helper) on purpose: each caller raises its own
 * error type/code (`ListFilesError` / `McpError` / `NotFoundError`) — only the
 * RULE is centralised here, not the error shape.
 */
export function isSafeKitId(kitId: string): boolean {
  if (kitId.length === 0) return false;
  if (kitId === "." || kitId === "..") return false;
  if (kitId.includes("/") || kitId.includes("\\")) return false;
  return true;
}

/**
 * The user-facing wording for an `isSafeKitId` rejection, co-located with the
 * rule so the two cannot drift. Callers that surface the rule through a Zod
 * schema pass this as the `.refine()` message; callers that raise their own
 * error type still choose their own code and class (see the note above — only
 * the RULE and its WORDING are centralised here, never the error shape). A
 * plain string, so this module still needs no `zod` dependency.
 */
export const KIT_ID_SAFETY_MESSAGE =
  "kitId must name a single kit: it cannot be empty, `.`, `..`, or contain a path separator.";

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
