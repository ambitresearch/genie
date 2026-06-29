/**
 * Store interfaces for genie kits and projects.
 *
 * M1-01 defines the full store surface; this file introduces the subset
 * required by M1-04 (list_files). Additional methods (readFile, createKit,
 * openPlan, …) will be added by the M1-01 implementation.
 */

/** A single file entry returned by {@link KitStore.listFiles}. */
export interface FileEntry {
  /** Forward-slash-delimited, kit-root-relative path (never absolute). */
  path: string;
  /** File size in bytes. */
  size: number;
  /**
   * SHA-256 of the file bytes, base64-encoded, prefixed `sha256-`
   * (Subresource Integrity format).
   */
  hash: string;
  /** ISO-8601 last-modified timestamp. */
  lastModified: string;
}

/**
 * Minimal kit store interface (M1-04 subset).
 *
 * The full interface (M1-01) will extend this with listKits, getKit,
 * readFile, createKit, openPlan, commitPlan, closePlan.
 */
export interface KitStore {
  /**
   * List every file in a kit, excluding patterns matched by `.genieignore`.
   *
   * Hidden (dot-prefixed) files are included. `node_modules`, `.git`, and
   * `dist` are excluded by default unless the `.genieignore` says otherwise.
   */
  listFiles(kitId: string): Promise<FileEntry[]>;
}
