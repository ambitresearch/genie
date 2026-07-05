/**
 * M3-06 (DRO-262) — genie's own `.genie/sync.json` verification anchor.
 *
 * `.genie/sync.json` is the LAST file the atomic sync sequence writes (D-C /
 * `docs/plan/00-decisions.md`): it records the source/render hashes and the
 * `@genie`-validated component list for whatever the sync just wrote, so the
 * *next* sync can diff against it and repair a half-completed prior run. A
 * mid-plan failure must leave this file unwritten (or stale) — never
 * partially written — which is why {@link writeAnchor} always does a
 * temp-file + rename commit (AC7), the same durability pattern
 * `store/local.ts`'s `stageAndCommit` and `plans/index.ts`'s plan snapshots
 * use elsewhere in this codebase.
 *
 * This is genie's **native** anchor shape — NOT the Anthropic `_ds_sync.json`
 * interop shape (CLAUDE.md hard rule 1 / AGENTS.md hard rule 1). An interop
 * adapter may one day map this to `_ds_sync.json`; that mapping is out of
 * scope here.
 *
 * ── Coordination with M3-05 (DRO-261) ───────────────────────────────────────
 * The 5-step atomic orchestrator (M3-05) calls {@link writeAnchor} as its
 * Step 5 (last write). That issue was still unbuilt on `main` as of this PR,
 * so {@link PlanResult} is this module's own minimal seam — "the set of
 * writes a sync touched, plus which components passed validation" — rather
 * than importing a type from a module that doesn't exist yet. Whichever of
 * M3-05 / M3-06 lands second adapts to the other's shape; the signature
 * `writeAnchor(projectRoot, planResult)` itself (AC1) is the stable contract
 * both issues were told to converge on.
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { sriSha256 } from "../store/kit-files.js";

// ─── Public shape (AC2) ──────────────────────────────────────────────────────

/** Kit-root-relative path of genie's verification anchor (D-C). */
export const ANCHOR_PATH = ".genie/sync.json";

/** Env var overriding {@link Anchor.by} (AC6) — for forks of genie. */
export const GENIE_BY_ENV = "GENIE_BY";

/** Default {@link Anchor.by} value when `GENIE_BY` is unset (AC6). */
export const DEFAULT_BY = "genie";

/**
 * Source-file extensions that count toward {@link Anchor.sourceHashes} (AC3).
 * The issue's literal AC3 text says ".tsx/.jsx", written when React was the
 * only shipped framework; Vue landed as a first-class framework in M2-08
 * (merged to `main` the day before this PR) with `.vue` as its canonical
 * single-file-component source (`framework/vue.ts`'s `renderSource` →
 * `<Name>.vue`). Omitting `.vue` here would leave every Vue component's
 * source invisible to the anchor's drift/tamper detection (RFC §10 T-05) —
 * the exact failure mode this file exists to prevent — so the extension list
 * covers both shipped component-source frameworks rather than only the one
 * named in the issue's illustrative example.
 *
 * `.html` is deliberately **not** in this list even though vanilla HTML is now a
 * first-class framework (`HtmlAdapter.renderSource` → `<Name>.html`, DRO-617).
 * For a vanilla-HTML component the source file *is* the browser-ready
 * `<Name>.html` preview — so it is already hash-covered by {@link Anchor.renderHashes}
 * (which hashes every `.html` write, AC4), giving the anchor's drift/tamper
 * detection full coverage of that source with no gap. Adding `.html` here instead
 * would double-count it *and* mislabel every React/Vue `<Name>.html` — which is a
 * *rendered* preview, not source — as `sourceHashes`, so the extension split stays
 * "compiled-source suffixes → sourceHashes, `.html` → renderHashes" and HTML's
 * source rides the render side by construction.
 */
const SOURCE_EXTENSIONS = [".tsx", ".jsx", ".vue"];

/**
 * genie's own `.genie/sync.json` shape (D-C, AC2) — verbatim the schema the
 * issue body specifies:
 *
 * ```json
 * { "version": 1, "writtenAt": "...", "by": "genie",
 *   "sourceHashes": { "components/.../X.tsx": "sha256-..." },
 *   "renderHashes":  { "components/.../X.html": "sha256-..." },
 *   "verified": ["actions/Button", "surfaces/Card"] }
 * ```
 *
 * `sourceHashes`/`renderHashes` map a repo-relative path to its
 * `sha256-<base64>` SRI hash (the same form `list_files`/`manifest.json` use,
 * via the shared {@link sriSha256} helper) — one shared hash format across
 * every genie artifact, per RFC §7.2's existing convention. The `.tsx`
 * example above is illustrative, not exhaustive — see {@link SOURCE_EXTENSIONS}
 * for the full, current set of source extensions `sourceHashes` covers.
 */
export interface Anchor {
  version: 1;
  writtenAt: string; // ISO-8601
  by: string;
  sourceHashes: Record<string, string>;
  renderHashes: Record<string, string>;
  verified: string[]; // "<group>/<Name>" ids
}

/**
 * The minimal "what did this sync touch" input {@link writeAnchor} needs.
 * Deliberately narrow (see the module-doc coordination note above): a plan's
 * writes plus the `<group>/<Name>` ids that passed the M3-04 validator within
 * this sync. `content` is whatever bytes were (or are about to be) written —
 * hashed here so the anchor's hashes are always computed from the exact bytes
 * that landed, not re-read from disk after the fact.
 */
export interface PlanResult {
  writes: Array<{ path: string; content: string | Buffer }>;
  verified: string[];
}

/** Thrown by {@link readAnchor} when `.genie/sync.json` exists but is not valid genie anchor JSON. */
export class AnchorParseError extends Error {
  constructor(
    public readonly projectRoot: string,
    public readonly reason: string,
  ) {
    super(`Anchor at "${projectRoot}/${ANCHOR_PATH}" is malformed: ${reason}`);
    this.name = "AnchorParseError";
  }
}

// ─── Schema (validated on read; see AnchorParseError above) ─────────────────

const anchorSchema = z.object({
  version: z.literal(1),
  writtenAt: z.string(),
  by: z.string(),
  sourceHashes: z.record(z.string(), z.string()),
  renderHashes: z.record(z.string(), z.string()),
  verified: z.array(z.string()),
});

// ─── writeAnchor (AC1, AC3–AC7) ──────────────────────────────────────────────

/**
 * Compute and atomically write `${projectRoot}/.genie/sync.json` (AC1).
 *
 * - `sourceHashes` covers every {@link SOURCE_EXTENSIONS} path in
 *   `planResult.writes` (AC3 — `.tsx`/`.jsx`, plus `.vue` for the shipped Vue
 *   framework); `renderHashes` covers every `.html` path (AC4). A path with
 *   none of those extensions (e.g. `meta.json`) appears in neither map — this
 *   anchor is scoped to source + render provenance, not a general write log.
 * - `verified` is `planResult.verified` verbatim (AC5) — the caller (the
 *   M3-05 orchestrator, or a direct test) is the one that ran the M3-04
 *   validator and knows which `<group>/<Name>` ids passed.
 * - `by` is {@link DEFAULT_BY} unless overridden by `env.GENIE_BY` (AC6).
 * - The write is atomic (AC7): content lands in a temp file staged under
 *   `<projectRoot>/.genie-tmp/` — a different directory from the `.genie/`
 *   destination, but the same filesystem/mount, which is the one guarantee
 *   POSIX `rename()` actually needs — then renamed over the destination. A
 *   crash between the temp write and the rename leaves the PRIOR anchor (or
 *   no anchor) intact — never a half-written one.
 *
 * @param env Injectable environment (defaults to `process.env`), so tests can
 *   assert the `GENIE_BY` override without mutating global state — the same
 *   pattern `write_files.ts`'s `resolveByteCap(env)` uses for
 *   `GENIE_WRITE_BYTE_CAP`.
 */
export async function writeAnchor(
  projectRoot: string,
  planResult: PlanResult,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const anchor: Anchor = {
    version: 1,
    writtenAt: new Date().toISOString(),
    by: env[GENIE_BY_ENV] ?? DEFAULT_BY,
    sourceHashes: hashByExtension(planResult.writes, SOURCE_EXTENSIONS),
    renderHashes: hashByExtension(planResult.writes, [".html"]),
    verified: [...planResult.verified],
  };

  const destPath = join(projectRoot, ANCHOR_PATH);
  await mkdir(join(projectRoot, ".genie"), { recursive: true });

  // Stage under `<projectRoot>/.genie-tmp/` (NOT os.tmpdir()) so the final
  // rename stays on the same filesystem — mirrors the load-bearing reasoning
  // in store/local.ts's stageAndCommit (a kit dir and /tmp are commonly
  // different mounts, and rename() is only atomic within one filesystem; it
  // does NOT require source and destination to share a directory). Reusing
  // `.genie-tmp` (rather than a new `.genie/`-nested
  // staging dir) matters beyond consistency: `store/kit-files.ts`'s
  // `DEFAULT_IGNORED_SEGMENTS` already excludes `.genie-tmp` from every kit
  // listing, so a `list_files` call landing mid-write never surfaces this
  // staging directory — the same guarantee `write_files`' own commit already
  // gets from that shared exclusion.
  const genieTmpRoot = join(projectRoot, ".genie-tmp");
  await mkdir(genieTmpRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(genieTmpRoot, "sync-"));
  try {
    const stagedPath = join(stagingRoot, "sync.json");
    await writeFile(stagedPath, JSON.stringify(anchor, null, 2), "utf-8");
    await rename(stagedPath, destPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Build a `path -> sha256-<base64>` map over every `planResult.writes` entry
 * whose path ends in one of `extensions` (AC3/AC4). Hashes the exact bytes
 * handed in (`sriSha256` accepts either a `Buffer` or a `string`), never a
 * fresh disk read — the anchor vouches for what THIS sync wrote, not
 * whatever happens to be on disk afterward.
 */
function hashByExtension(
  writes: PlanResult["writes"],
  extensions: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { path, content } of writes) {
    if (extensions.some((ext) => path.endsWith(ext))) {
      result[path] = sriSha256(content);
    }
  }
  return result;
}

// ─── readAnchor (AC1, AC8) ────────────────────────────────────────────────────

/**
 * Read + parse `${projectRoot}/.genie/sync.json` (AC1).
 *
 * - Returns `null` — never throws — when the file (or the whole `.genie`
 *   dir, or `projectRoot` itself) does not exist (AC8): a fresh kit with no
 *   prior sync is a normal, expected state, not an error.
 * - Throws {@link AnchorParseError} when the file EXISTS but is not valid
 *   JSON, or is valid JSON that doesn't match the {@link Anchor} shape
 *   (including a `version` other than the literal `1`). This is
 *   deliberately NOT folded into the `null` case: `null` means "no anchor
 *   yet, that's fine"; a corrupt-but-present anchor is a real operability
 *   problem for a file whose entire purpose is verification (RFC §10 T-05
 *   flags anchor tampering) and must surface rather than silently
 *   masquerade as "nothing to verify yet" — the same reasoning
 *   `store/manifest.ts`'s `ManifestParseError` already applies to
 *   `manifest.json`.
 */
export async function readAnchor(projectRoot: string): Promise<Anchor | null> {
  const destPath = join(projectRoot, ANCHOR_PATH);

  let raw: string;
  try {
    raw = await readFile(destPath, "utf-8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new AnchorParseError(projectRoot, describeError(error, "invalid JSON"));
  }

  const parsed = anchorSchema.safeParse(json);
  if (!parsed.success) {
    throw new AnchorParseError(projectRoot, parsed.error.issues[0]?.message ?? "schema mismatch");
  }

  return parsed.data;
}

/** ENOENT (missing file) and ENOTDIR (a parent component is a file) both mean "not there". */
function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
