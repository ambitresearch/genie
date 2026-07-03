/**
 * Manifest reader — the `.genie/manifest.json` compiled card index (decision D-D).
 *
 * `list_components` (M1-15) READS this artefact; the M3-03 manifest compiler
 * WRITES it from `@genie` markers. M1-15 therefore *defines* the on-disk shape
 * the compiler must later emit — the dependency runs list_components → M3-03,
 * not the other way round (see the issue's "Blocks: M3-03" line).
 *
 * The module is pure I/O-free logic: each KitStore adapter fetches the raw file
 * bytes its own way (local FS read vs. git-host contents API) and hands them
 * here, so both adapters get byte-identical filtering and ordering semantics —
 * which is exactly the shared-abstraction guarantee AC9 asks for.
 */

import { z } from "zod";
import type { ComponentEntry } from "./interface.js";

/** Kit-root-relative path of the compiled card index (decision D-D). */
export const MANIFEST_PATH = ".genie/manifest.json";

/** Thrown when a manifest file exists but is not valid genie manifest JSON. */
export class ManifestParseError extends Error {
  constructor(
    public readonly kitId: string,
    public readonly reason: string,
  ) {
    super(`Manifest for kit "${kitId}" is malformed: ${reason}`);
    this.name = "ManifestParseError";
  }
}

/**
 * One compiled component card. `viewport` is the raw token string the M3-01
 * `@genie` regex captures from the preview's first-line marker (e.g. "desktop"
 * or "375x812") — kept as a string per AC5, not decomposed into {width,height}.
 */
const manifestComponentSchema = z
  .object({
    name: z.string(),
    group: z.string(),
    path: z.string(),
    viewport: z.string(),
    hash: z.string(),
    lastModified: z.string(),
  })
  // Tolerate forward-compatible extra keys the compiler may add (renderer
  // hints, asset deps — explicitly v2 per the issue's Out of Scope) rather
  // than rejecting the whole manifest; we only surface the six AC5 fields.
  .passthrough();

/**
 * Manifest envelope. `version` lets M3-03 evolve the format without silently
 * mis-parsing; `components` is the card array. Unknown top-level keys are
 * tolerated for the same forward-compat reason.
 */
const manifestSchema = z
  .object({
    version: z.number().int().optional(),
    components: z.array(manifestComponentSchema),
  })
  .passthrough();

/** The three fields that define a component's total sort order (AC6). */
export type ComponentSortKey = Pick<ComponentEntry, "group" | "name" | "path">;

/**
 * Deterministic component comparator (AC6): group ASC, then name ASC, ties
 * broken by path ASC. Comparison is by UTF-16 code unit (`<`/`>`), NOT
 * `localeCompare` — locale collation would make ordering depend on the host's
 * `LANG`, defeating the "deterministic" guarantee the manifest compiler (M3-03)
 * and the grid renderer (M4-03) both rely on for a stable seed list.
 */
export function compareComponents(a: ComponentSortKey, b: ComponentSortKey): number {
  return byCodeUnit(a.group, b.group) || byCodeUnit(a.name, b.name) || byCodeUnit(a.path, b.path);
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The full pure pipeline behind `KitStore.listComponents`: parse raw manifest
 * bytes, filter by group, sort deterministically.
 *
 *   - `raw === undefined` (no manifest file yet) → `[]` (AC8: no components).
 *   - `group` provided (incl. "") → only exact-match entries; a filter that
 *     matches nothing → `[]` (AC8), never null/error.
 *   - malformed JSON or shape → {@link ManifestParseError} (corruption must
 *     surface, not masquerade as an empty kit).
 */
export function selectComponents(
  kitId: string,
  raw: string | undefined,
  group?: string,
): ComponentEntry[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    throw new ManifestParseError(kitId, e instanceof Error ? e.message : "invalid JSON");
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ManifestParseError(kitId, parsed.error.issues[0]?.message ?? "schema mismatch");
  }

  const entries: ComponentEntry[] = parsed.data.components.map((c) => ({
    name: c.name,
    group: c.group,
    path: c.path,
    viewport: c.viewport,
    hash: c.hash,
    lastModified: c.lastModified,
  }));

  // Explicit `!== undefined` so an empty-string group filter is honoured
  // literally (matches components whose group is "") rather than treated as
  // "no filter".
  const filtered = group !== undefined ? entries.filter((c) => c.group === group) : entries;

  // Copy before sort — never mutate the parsed array's order in place.
  return [...filtered].sort(compareComponents);
}
