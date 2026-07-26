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
 * This is the shared kitId rule and it is the correct INPUT gate. It is not
 * `KIT_ID_PATTERN` (`tools/get_kit.ts`), which is a *shape* rule describing the
 * ids `create_kit` mints; `KitId` is an opaque, adapter-assigned string and
 * `list_kits` promises what it returns is valid input everywhere, so gating
 * input on the mint shape makes an imported kit like `My_Kit.2` visible but
 * unusable.
 *
 * A `kitId` names a single directory (LocalFs) or repo (git host) directly
 * under the store's kits root. This is a CONTAINMENT-AND-IDENTITY rule, not a
 * containment rule. It refuses two different kinds of id: those that would let
 * a caller escape that namespace, and those that stay inside it but do not
 * SPELL the kit they open. The second kind is easy to miss precisely because a
 * `join`-based containment check passes it — see the sibling sub-case below.
 *
 * The invariant, stated once: every accepted id is its own Win32 path-component
 * NORMALIZATION, so it names the directory it opens on every platform. It does
 * not, and cannot cheaply, collapse filesystem name-EQUIVALENCE — see "NOT in
 * scope" below for where that line falls and why.
 *
 * It returns false for:
 *
 *   - the empty string — `join(kitsRoot, "")` is the kits ROOT itself, so an
 *     empty kitId plus a crafted `path` (e.g. `other-kit/secret.txt`) would
 *     read across sibling kits; it names no kit and is rejected;
 *   - `.` or `..` exactly — the traversal aliases for "this dir" / "the parent",
 *     which also resolve to the root or above it;
 *   - any id containing a path separator (`/` or `\`), which could introduce a
 *     nested or absolute path;
 *   - any id ENDING in a dot or an ASCII space (`" "`, `".. "`, `"victim.."`,
 *     `"victim "`). Win32 strips the trailing run of spaces and dots from a
 *     path component at the syscall boundary, so such an id is a live alias for
 *     a DIFFERENT name. Node's `path` module does not perform that trim — it
 *     reports `root\.. ` verbatim — so a `join`-based containment check sees a
 *     contained path while the OS resolves it elsewhere. Two sub-cases, both
 *     refused by the one check:
 *       · trims away to nothing (`" "`, `". "`, `".. "`) → aliases the kits
 *         ROOT itself, or its PARENT — a containment escape;
 *       · trims to another non-empty name (`"victim.."` → `"victim"`) → aliases
 *         a SIBLING kit. This one stays under the kits root, so it is not a
 *         containment escape, but it still breaks the promise above: a plan for
 *         `victim..` mutates or deletes `victim`, because `writeFiles` and
 *         `deleteFile` resolve through the unsafe `kitDir` with this predicate
 *         as their only guard.
 *     Refusing costs nothing on the platform where the alias is live: Windows
 *     applies the same trim in `mkdir`, so a directory named `victim..` cannot
 *     exist there. Such an id can only ever alias; it can never name a kit.
 *
 * Ids that merely EMBED or LEAD with dots (`my..kit`, `..kit`, `. kit`) survive
 * unchanged through the Win32 trim — it only touches the trailing run — so they
 * stay a literal, unambiguous child of the root and are allowed; they simply
 * resolve to a not-found kit if absent. This is deliberately looser than the
 * pre-unification `read_file` guard (`kitId.includes("..")`), which
 * over-rejected `my..kit` yet — crucially — MISSED both `""` and `.` (neither
 * contains `..`), the exact holes that enabled the cross-kit read this rule
 * closes.
 *
 * NOT in scope, deliberately. The dividing line is whether an id CAN name a
 * real directory. A trailing-[ .] id cannot — Windows applies the same trim in
 * `mkdir` — so it has no possible referent and can ONLY alias; refusing it
 * costs nothing. Each case below CAN, so refusing it would be exactly the
 * over-rejection this unification exists to remove:
 *
 *   - case-insensitive collision (`Victim` vs `victim` on Windows/macOS).
 *     Refusing uppercase is the original defect: `Design-System` is a
 *     legitimate git-host kit;
 *   - NTFS DOS 8.3 short names (`VICTIM~1` standing in for `Victim Component`
 *     on a volume with 8.3 generation enabled). `mkdir "VICTIM~1"` succeeds on
 *     every platform, and where a literal `VICTIM~1` exists NTFS gives the
 *     long-named kit `VICTIM~2` instead, so the two never collide. `~` is also
 *     legal in a POSIX directory name, so blanket-refusing it would make a
 *     `my~kit` kit listable and unusable — this rule's own defect, re-created;
 *   - Win32 reserved device names (`CON`, `NUL`, `COM1`), which resolve to a
 *     device rather than to another kit. CVE-2025-27210 let a device name walk
 *     `path.join` OUT of a base directory, but only as a
 *     segment FOLLOWED BY traversal segments (`..\CON\..\..\etc\passwd`).
 *     Refusing separators makes an accepted id a single component, and the
 *     trailing-dot/space rule removes the only separator-free way to end in a
 *     traversal segment, so no accepted id has that shape (locked in
 *     `kit-files.test.ts`). The `path` argument of `readFile`/`writeFiles` does
 *     take separators, so the published `engines.node` ranges exclude every
 *     unpatched release for that surface — per release line, since the fix
 *     landed separately in 20.19.4, 22.17.1 and 24.4.1.
 *
 * The first two are alternate SPELLINGS of one real directory, resolvable in
 * both directions, so there is no hidden second kit to cross into; the third
 * reaches a device instead of a kit, which fails the operation rather than
 * redirecting it at another kit. All three are name-equivalence properties
 * rather than gate holes: a caller who can name a kit two ways still reaches
 * exactly one kit. Collapsing them needs the resolved path canonicalised
 * (`realpath`) and compared against the request — a store-layer change, not a
 * predicate one, and not something a denylist of characters can ever finish.
 *
 * A predicate (not a throwing helper) on purpose: each caller raises its own
 * error type/code (`ListFilesError` / `McpError` / `NotFoundError`) — only the
 * RULE is centralised here, not the error shape.
 */
export function isSafeKitId(kitId: string): boolean {
  if (kitId.length === 0) return false;
  if (kitId === "." || kitId === "..") return false;
  if (kitId.includes("/") || kitId.includes("\\")) return false;
  // Win32 trims the trailing run of spaces and dots from a path component, so
  // any id ending in one normalizes to a DIFFERENT name — the kits root, its
  // parent, or a sibling kit. See the two sub-cases above.
  if (/[ .]$/u.test(kitId)) return false;
  // A NUL byte is neither a traversal nor a Win32 alias — it is a path no
  // filesystem call can express. Node rejects any path containing one with
  // `ERR_INVALID_ARG_VALUE`, not `ENOENT`, so an id carrying one (MCP arguments
  // are JSON, which encodes `\u0000` verbatim) would clear this gate and raise a
  // raw argument TypeError from inside the store instead of the invalid-kit
  // result the tool boundary advertises. NUL only: the other control characters
  // are legal POSIX directory names, and refusing them would make a
  // legitimately-named kit unusable.
  if (kitId.includes("\u0000")) return false;
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
  "kitId must name a single kit: it cannot be empty, `.`, `..`, end in a dot or a space, " +
  "or contain a path separator or a NUL byte.";

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
