/**
 * Kit type discriminator.
 *
 * `GENIE_KIT` is the native type for genie UI kits.
 * The interop adapter maps Anthropic's `PROJECT_TYPE_DESIGN_SYSTEM`
 * to/from this value when round-tripping — see D0 in the RFC.
 */
export const KIT_TYPE_GENIE = "GENIE_KIT" as const;

/**
 * Summary returned by `KitStore.listKits()`.
 *
 * Matches the research-report §3.1 shape:
 *   `{ id, name, owner, updatedAt, canEdit }`
 */
export interface KitSummary {
  id: string;
  name: string;
  owner: string;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
  canEdit: boolean;
  /** Discriminator — only `GENIE_KIT` records are surfaced by `list_kits`. */
  type: string;
}

/**
 * Minimal kit-store contract required by the M1-02 `list_kits` tool.
 *
 * The full `KitStore` interface (read, write, plan, etc.) is defined
 * in M1-01; this subset is all `list_kits` needs.
 */
export interface KitStore {
  /**
   * Return every kit the current user has access to, unfiltered.
   * Callers (e.g. the `list_kits` tool) filter by `type` themselves.
   */
  listKits(): Promise<KitSummary[]>;
}
