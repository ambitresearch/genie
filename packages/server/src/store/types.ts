/**
 * Store types for genie kits and projects.
 *
 * The KitStore interface defines the contract all storage adapters must
 * satisfy (LocalFsStore, GitHostStore, InMemoryKitStore for tests).
 * Only the subset needed by M1-03 (get_kit) is defined here; the full
 * surface (listFiles, readFile, openPlan, …) will arrive with M1-01.
 */

/** The literal type tag for genie-native UI kits. */
export const GENIE_KIT_TYPE = "GENIE_KIT" as const;

/** Metadata returned for a single UI kit. */
export interface KitMeta {
  id: string;
  name: string;
  type: typeof GENIE_KIT_TYPE | (string & {});
  canEdit: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Minimal KitStore interface covering the operations M1-02 and M1-03 need.
 * Will be extended as later M1 issues land (listFiles, readFile, openPlan, etc.).
 */
export interface KitStore {
  /** Return all kits the user has access to (unfiltered). */
  listKits(): Promise<KitMeta[]>;

  /**
   * Return metadata for a single kit.
   * Returns `undefined` when the kitId does not resolve to anything.
   */
  getKit(kitId: string): Promise<KitMeta | undefined>;
}
