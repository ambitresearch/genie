/**
 * M3-03 (DRO-259) — the `.genie/manifest.json` writer (client-side compiler).
 *
 * This is genie's substitute for Anthropic's server-side manifest
 * compilation (research report §6): a small, dependency-light walker that
 * recompiles `<projectRoot>/.genie/manifest.json` from the `@genie` markers
 * on disk whenever the M3-02 watcher fires (or on any direct call — this
 * module has no opinion on WHEN it runs, only on producing a correct
 * manifest for a given `projectRoot` snapshot).
 *
 * ── Schema reconciliation (recorded on DRO-259 before this file was written) ──
 * This issue's own AC4 (and the RFC §6.8/§7.1 sketch, and the M4-03 viewer's
 * `fetch` code) describe a root key `cards` with `viewport: {width,height}`
 * as an object. But `../store/manifest.ts` — already merged, backing the
 * shipped/tested M1-15 `list_components` tool, read by BOTH `LocalFsKitStore`
 * and `GitHostKitStore` — has a zod schema that requires the root key
 * `components`, with `viewport` as the raw marker STRING (e.g. `"400x200"`
 * or `"desktop"`), plus `{name, group, path, hash, lastModified}`.
 *
 * Emitting `cards` would silently break `list_components` (a live, shipped
 * P0 tool): its zod parse requires `components` and would throw
 * `ManifestParseError` on a `cards`-shaped file. So this compiler emits
 * `components` with a STRING `viewport`, matching the already-shipped reader
 * contract. `../store/manifest.ts`'s schemas are `.passthrough()`, so the
 * RFC's additional fields are layered on top without conflict: top-level
 * `version: 1`, `generatedAt`, `name` (the kit/project's directory basename),
 * `groups: string[]`; per-card `subtitle`/`tags` when a sibling `meta.json`
 * supplies them. This is additive/forward-compatible per RFC §16.2 ("add a
 * new output field — allowed in minor/patch").
 *
 * Pure-ish orchestration: the only side effects are reading the component
 * tree + sibling `meta.json`/`_groups.json` files and the final atomic write.
 * Marker PRESENCE validation and card sort order are delegated to
 * already-shipped, independently-tested modules (M3-01's `validateMarker`,
 * `store/manifest.ts`'s `compareComponents`); group/viewport extraction is
 * a narrow regex read of the same already-validated marker line (see
 * `extractGroup`/`extractViewportToken` below for why M3-01's own
 * `extractViewport` isn't reused verbatim here).
 */

import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { validateMarker } from "../validate/marker.js";
import { sriSha256 } from "../store/kit-files.js";
import { compareComponents, MANIFEST_PATH } from "../store/manifest.js";

// ─── Public shape ────────────────────────────────────────────────────────────

/**
 * One compiled card (AC2–AC5). Matches `../store/manifest.ts`'s
 * `ComponentEntry` six required fields exactly, plus the two optional
 * `meta.json`-sourced fields already defined by `llm/schema.ts`'s
 * `manifestEntry` (`subtitle`, `tags`).
 */
export interface ManifestCard {
  name: string;
  group: string;
  path: string;
  /** The raw marker token (e.g. "400x200" or "desktop") — AC5 note; not decomposed. */
  viewport: string;
  /** `sha256-<base64>` SRI hash of the HTML file's bytes (AC5). */
  hash: string;
  /** ISO-8601 mtime of the HTML file. */
  lastModified: string;
  subtitle?: string;
  tags?: string[];
}

/** The full compiled manifest (AC4, reconciled — see module doc). */
export interface Manifest {
  version: 1;
  name: string;
  generatedAt: string;
  groups: string[];
  components: ManifestCard[];
}

/**
 * One skipped file the compiler declined to card — surfaced so a caller (the
 * M3-02 watcher's `onChange`, or a future `validate` full-scan) can report
 * `markerMissing` rather than the omission vanishing silently. Mirrors the
 * RFC §6.8 failure mode: "the watcher silently skips it; `validate` surfaces
 * the omission."
 */
export interface ManifestSkip {
  path: string;
  reason: "MARKER_MISSING";
}

/** {@link compileManifest}'s full result: the manifest plus any skips. */
export interface CompileResult {
  manifest: Manifest;
  skipped: ManifestSkip[];
}

// ─── meta.json / _groups.json shapes (best-effort, tolerant parse) ──────────

interface ComponentMeta {
  subtitle?: string;
  tags?: string[];
}

/** Loose runtime guard — a `meta.json` is optional and non-renderable, so a
 * malformed one degrades to "no extra metadata" rather than failing the
 * whole compile (this module owns availability of the manifest; a single
 * bad `meta.json` must not take that down). */
function parseComponentMeta(raw: string): ComponentMeta {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== "object" || json === null) return {};
    const obj = json as Record<string, unknown>;
    const subtitle = typeof obj["subtitle"] === "string" ? obj["subtitle"] : undefined;
    const tags =
      Array.isArray(obj["tags"]) && obj["tags"].every((t) => typeof t === "string")
        ? (obj["tags"] as string[])
        : undefined;
    return { subtitle, tags };
  } catch {
    return {};
  }
}

/** Loose parse of an optional `_groups.json` sibling: an explicit group order
 * (Impl Notes: "Group order: alphabetical unless a `_groups.json` sibling
 * pins it"). Any shape other than a flat string array is treated as absent —
 * this is a purely cosmetic ordering hint, never a hard requirement. */
function parseGroupsOrder(raw: string): string[] | undefined {
  try {
    const json: unknown = JSON.parse(raw);
    if (Array.isArray(json) && json.every((g) => typeof g === "string")) {
      return json as string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Directory walk ──────────────────────────────────────────────────────────

/** One discovered `<Name>.html` preview file, before marker validation. */
interface PreviewFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Forward-slash, projectRoot-relative path (AC4's `path` field). */
  relPath: string;
}

/** ENOENT/ENOTDIR both mean "not there" — the same convention `store/local.ts`
 * and `sync/anchor.ts` use throughout this codebase. */
function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code !== undefined &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

/**
 * Recursively walk `${projectRoot}/components` for `*.html` files (AC2).
 * Returns `[]` when the `components/` directory doesn't exist yet (a brand
 * new kit/project) rather than throwing — an empty manifest is a valid,
 * expected state (mirrors `store/manifest.ts`'s `selectComponents` treating
 * an absent manifest as `[]`, not an error).
 */
async function walkPreviewFiles(
  componentsRoot: string,
  projectRoot: string,
): Promise<PreviewFile[]> {
  let entries;
  try {
    entries = await readdir(componentsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const out: PreviewFile[] = [];
  for (const entry of entries) {
    const absPath = join(componentsRoot, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkPreviewFiles(absPath, projectRoot)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    out.push({ absPath, relPath: relative(projectRoot, absPath).replaceAll("\\", "/") });
  }
  return out;
}

/** Read a sibling file next to `htmlAbsPath` (same directory, given basename).
 * Returns `undefined` on any read failure (missing, EISDIR, etc.) — every
 * sibling here is optional metadata, never load-bearing for the card itself. */
async function readSibling(htmlAbsPath: string, siblingName: string): Promise<string | undefined> {
  return readOptionalFile(join(dirname(htmlAbsPath), siblingName));
}

/** Read a file at an exact absolute path, tolerating absence (or any other
 * read failure) as `undefined` rather than throwing — used for every
 * optional, best-effort sidecar this compiler reads (`meta.json`,
 * `_groups.json`), none of which are load-bearing for the manifest itself. */
async function readOptionalFile(absPath: string): Promise<string | undefined> {
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Extract a card's `group` from the validated `@genie` marker line itself
 * (AC2: "extracts group + viewport via the M3-01 helper") rather than from
 * the directory path — the marker is genie's "registration contract" (M3-01's
 * own module doc), so it is the authoritative source, and reading it directly
 * also cards a preview file correctly even if a kit doesn't follow the
 * `components/<group>/<Name>/<Name>.html` two-level convention `../store/
 * manifest.ts`'s consumers otherwise assume. Safe to assume a match here:
 * every card reaching this function already passed `validateMarker` against
 * `MARKER_REGEX`, whose own pattern requires a `group="[^"]*"` capture.
 */
function extractGroup(firstLine: string): string {
  return /^<!--\s*@genie\s+group="([^"]*)"/.exec(firstLine)?.[1] ?? "";
}

/**
 * Extract a card's `viewport` token verbatim from the marker line (AC2/AC5).
 * `../validate/marker.ts`'s `extractViewport` is deliberately NOT used here:
 * it decomposes a strict `WxH` token into `{width,height}` integers for
 * consumers doing arithmetic on the value, and returns `undefined` for
 * anything else (including a named token like `"desktop"`) — exactly the
 * case `extractViewport`'s own doc comment calls out as "kept as an opaque
 * string" by "list_components/the manifest compiler". Re-serializing the
 * parsed integers back through `${width}x${height}` would also risk silently
 * normalizing a literal marker string (e.g. dropping a leading zero), which
 * this compiler must not do — its job is to mirror the marker byte-for-byte,
 * not reformat it. Returns `""` when the marker has no `viewport` attribute
 * at all (`../store/manifest.ts`'s `viewport` is a plain `z.string()`, so an
 * absent viewport still needs SOME string, and `""` is the same "no value"
 * signal `store/manifest.ts`'s consumers already treat any falsy string as).
 */
function extractViewportToken(firstLine: string): string {
  return /(?:^|\s)viewport="([^"]*)"/.exec(firstLine)?.[1] ?? "";
}

/**
 * Derive a card's `name` from its filename (`<Name>.html` → `<Name>`) — the
 * on-disk convention every M3-03-adjacent module (RFC §7.1, `conjure.ts`'s
 * system prompt) assumes.
 */
function deriveName(relPath: string): string {
  const file = basename(relPath);
  return file.endsWith(".html") ? file.slice(0, -".html".length) : file;
}

// ─── compileManifest (AC1–AC7) ───────────────────────────────────────────────

/**
 * Recompile the manifest for `projectRoot` (AC1) purely from what's on disk
 * right now — no incremental state, no cache. Safe to call as often as the
 * watcher likes; a debounce (M3-02's own 100 ms window) is the caller's
 * concern, not this function's.
 *
 * Steps (AC2/AC3):
 *  1. Walk `${projectRoot}/components/**\/*.html`.
 *  2. For each, validate the `@genie` first line (M3-01). A file that fails
 *     is SKIPPED (not carded) and reported in `skipped` — mirrors the RFC
 *     §6.8 failure mode ("the watcher silently skips it; validate surfaces
 *     the omission").
 *  3. Extract `viewport` from the marker line; join a sibling `meta.json`
 *     for `subtitle`/`tags` when present (AC3).
 *  4. Hash the HTML file's bytes as `sha256-<base64>` SRI (AC5, same format
 *     `list_files`/`.genie/sync.json` use — `store/kit-files.ts`'s
 *     `sriSha256`).
 *  5. Sort groups alphabetically unless a root `_groups.json` sibling pins an
 *     explicit order (Impl Notes); sort cards alphabetically by `name`
 *     within a group, ties broken by `path` (the shared `compareComponents`
 *     from `store/manifest.ts` — AC6-equivalent ordering used everywhere
 *     else a component list is sorted in this codebase).
 *  6. Atomically write `.genie/manifest.json` (AC6): stage under
 *     `${projectRoot}/.genie-tmp/`, then rename over the destination — same
 *     same-filesystem-rename pattern `sync/anchor.ts` and `store/local.ts`
 *     already use, so a crash mid-write leaves the PRIOR manifest (or none)
 *     intact, never a half-written one.
 */
export async function compileManifest(projectRoot: string): Promise<CompileResult> {
  const componentsRoot = join(projectRoot, "components");
  const previews = await walkPreviewFiles(componentsRoot, projectRoot);

  const skipped: ManifestSkip[] = [];
  const cards: ManifestCard[] = [];

  for (const { absPath, relPath } of previews) {
    // Read the file's raw bytes ONCE: sriSha256 hashes these exact bytes
    // (matching store/local.ts's own convention of hashing what was actually
    // read, not a re-encoded string), and the same buffer is decoded to utf-8
    // for marker/content parsing — avoiding a second disk read per file and
    // any lossy-decode edge case a re-read could introduce.
    const bytes = await readFile(absPath);
    const content = bytes.toString("utf-8");
    const validation = validateMarker(relPath, content);
    if (!validation.ok) {
      skipped.push({ path: relPath, reason: validation.code });
      continue;
    }

    const firstLine = content.split("\n", 1)[0] ?? "";
    const group = extractGroup(firstLine);
    const viewportToken = extractViewportToken(firstLine);

    const [stats, metaRaw] = await Promise.all([stat(absPath), readSibling(absPath, "meta.json")]);
    const meta = metaRaw ? parseComponentMeta(metaRaw) : {};

    cards.push({
      name: deriveName(relPath),
      group,
      path: relPath,
      viewport: viewportToken,
      hash: sriSha256(bytes),
      lastModified: stats.mtime.toISOString(),
      ...(meta.subtitle !== undefined ? { subtitle: meta.subtitle } : {}),
      ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    });
  }

  cards.sort(compareComponents);

  const pinnedRaw = await readOptionalFile(join(projectRoot, "_groups.json"));
  const pinnedOrder = pinnedRaw ? parseGroupsOrder(pinnedRaw) : undefined;

  const discoveredGroups = [...new Set(cards.map((c) => c.group))];
  const groups = orderGroups(discoveredGroups, pinnedOrder);

  const manifest: Manifest = {
    version: 1,
    name: basename(projectRoot),
    generatedAt: new Date().toISOString(),
    groups,
    components: cards,
  };

  await writeManifestAtomic(projectRoot, manifest);

  return { manifest, skipped };
}

/**
 * Alphabetical by default; when `pinnedOrder` is supplied (a parsed
 * `_groups.json`), pinned groups come first in their given order, followed by
 * any remaining discovered group NOT in the pin list, alphabetically — so an
 * incomplete pin list never silently drops a group from the manifest.
 */
function orderGroups(discovered: string[], pinnedOrder: string[] | undefined): string[] {
  if (!pinnedOrder || pinnedOrder.length === 0) {
    return [...discovered].sort(byCodeUnit);
  }
  const discoveredSet = new Set(discovered);
  const pinned = pinnedOrder.filter((g) => discoveredSet.has(g));
  const pinnedSet = new Set(pinned);
  const remainder = discovered.filter((g) => !pinnedSet.has(g)).sort(byCodeUnit);
  return [...pinned, ...remainder];
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Atomic write (AC6): stage the serialized manifest under
 * `${projectRoot}/.genie-tmp/` (same filesystem as the `.genie/` destination
 * — `rename()` is only atomic within one filesystem, the same load-bearing
 * reasoning `sync/anchor.ts`'s `writeAnchor` and `store/local.ts`'s
 * `stageAndCommit` already rely on), then rename over
 * `${projectRoot}/.genie/manifest.json`. `.genie-tmp` is already excluded
 * from every kit listing (`store/kit-files.ts`'s `DEFAULT_IGNORED_SEGMENTS`),
 * so a `list_files` call mid-compile never surfaces this staging directory.
 */
async function writeManifestAtomic(projectRoot: string, manifest: Manifest): Promise<void> {
  const destPath = join(projectRoot, MANIFEST_PATH);
  await mkdir(join(projectRoot, ".genie"), { recursive: true });

  const genieTmpRoot = join(projectRoot, ".genie-tmp");
  await mkdir(genieTmpRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(genieTmpRoot, "manifest-"));
  try {
    const stagedPath = join(stagingRoot, "manifest.json");
    await writeFile(stagedPath, JSON.stringify(manifest, null, 2), "utf-8");
    await rename(stagedPath, destPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
