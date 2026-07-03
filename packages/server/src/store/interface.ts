/**
 * Storage abstraction for genie kits and projects.
 *
 * All M1 tools are implemented against these interfaces, not against `fs`
 * directly. Two adapters ship with M1:
 *   - LocalFsStore  — solo dev; kit/project = directory on local FS
 *   - GitHostStore  — shared; kit/project = git-tracked tree on any git host
 */

// ─── Shared types ────────────────────────────────────────────────────────────

/** Immutable type discriminator stamped on every kit record. */
export const KIT_TYPE = "GENIE_KIT" as const;

/** Unique identifier for a kit (opaque string, adapter-assigned). */
export type KitId = string;

/** Unique identifier for a project (opaque string, adapter-assigned). */
export type ProjectId = string;

/**
 * A plan is a staging area for multi-file edits before they are committed.
 * In LocalFsStore it maps to a temp directory; in GitHostStore it maps to a
 * branch (`plan/${planId}`).
 */
export type PlanId = string;

/** Metadata returned when listing or getting a kit. */
export interface KitMeta {
  id: KitId;
  name: string;
  type: typeof KIT_TYPE;
  createdAt: string; // ISO-8601
}

/** Metadata returned when listing or getting a project. */
export interface ProjectMeta {
  id: ProjectId;
  name: string;
  kitId?: KitId;
  createdAt: string; // ISO-8601
}

/** Component entry returned by listComponents. */
export interface ComponentEntry {
  name: string;
  group: string;
  path: string;
  viewport: string;
  hash: string;
  lastModified: string; // ISO-8601
}

/** Encoding of a file's bytes as carried over the wire by `readFile`. */
export type FileEncoding = "utf-8" | "base64";

/**
 * Rich result of `KitStore.readFile` — the shape the `read_file` MCP tool
 * returns verbatim (RFC §9). MIME resolution + text/binary classification live
 * in the store (see `kit-files.ts`), so a `read_file` call is byte-identical
 * whichever adapter backs it:
 *   - `encoding: "utf-8"`  → `content` is the decoded text.
 *   - `encoding: "base64"` → `content` is base64 (binary files).
 * The 256 KiB cap (`MAX_FILE_BYTES`) is enforced by the store, which throws
 * `FileTooLargeError` before returning; the tool maps that onto its wire error.
 */
export interface KitFileContent {
  content: string;
  encoding: FileEncoding;
  mimeType: string;
}

/**
 * Rich per-file entry returned by `KitStore.listFiles` — the shape the
 * `list_files` MCP tool returns (RFC §9). Carries a Subresource-Integrity
 * hash (`sha256-<base64>`), byte size, and an ISO-8601 modification time.
 *
 * ── git-host `lastModified` parity (AC / DRO-540) ─────────────────────────────
 * `lastModified` is defined per-adapter and the granularity deliberately
 * differs:
 *   - `LocalFsKitStore` uses each file's real filesystem `mtime` — true
 *     per-file granularity.
 *   - `GitHostKitStore` uses the repository's last-update timestamp
 *     (`updated_at`, falling back to `created_at`) for EVERY entry in a
 *     listing — per-*repo* granularity, not per-file.
 * The reason is cost: the Gitea contents API (`GET …/contents/<path>`) carries
 * `sha`/`size` but no dependable per-file commit time across Gitea versions.
 * True per-file times would require a commits-API query per file
 * (`GET …/commits?path=<file>&limit=1`) — an N+1 fan-out over a whole kit tree.
 * The single repo-metadata read is the honest, cheap parity: "these files were
 * last touched no earlier than the repo's last push." Both satisfy the ISO-8601
 * contract; callers that need per-file precision on a git host must opt into the
 * commits API (a tracked follow-up, intentionally out of scope here).
 */
export interface KitFileEntry {
  path: string;
  size: number;
  hash: string; // Subresource-Integrity form: "sha256-<base64>"
  lastModified: string; // ISO-8601 (see parity note above)
}

/** A single file operation (write or delete) for plan commits. */
export type FileOp =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string };

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when a kit already exists with the given ID. */
export class KitAlreadyExistsError extends Error {
  constructor(public readonly kitId: string) {
    super(`Kit already exists: ${kitId}`);
    this.name = "KitAlreadyExistsError";
  }
}

/** Thrown when `readFile` encounters a file exceeding the 256 KiB cap. */
export class FileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly actualBytes: number,
  ) {
    super(
      `File "${path}" is ${actualBytes} bytes, exceeding the 256 KiB (262144 bytes) limit.`,
    );
    this.name = "FileTooLargeError";
  }
}

/** Thrown when a referenced kit/project/plan does not exist. */
export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} "${id}" not found.`);
    this.name = "NotFoundError";
  }
}

/** Thrown when a required credential is missing. */
export class MissingCredentialError extends Error {
  constructor(public readonly envVar: string) {
    super(
      `Required credential "${envVar}" is not set. ` +
        `Set it as an environment variable before starting genie.`,
    );
    this.name = "MissingCredentialError";
  }
}

// ─── KitStore interface ──────────────────────────────────────────────────────

/** Maximum file size in bytes that readFile will return (256 KiB). */
export const MAX_FILE_BYTES = 262_144;

/**
 * AC1 — KitStore defines:
 *   listKits, getKit, listFiles, readFile(kitId, path),
 *   createKit, openPlan(kitId, ops) → planId,
 *   commitPlan(kitId, planId, ops), closePlan(kitId, planId).
 *
 * The file-content trio (`listFiles`/`readFile`/`deleteFile`) is what the
 * fs-native MCP kit-file verbs (`list_files`/`read_file`/`delete_files`) bind
 * to (M1-14a-1a / DRO-540) — so injecting a `GitHostKitStore` carries those
 * verbs onto the git host, not just the metadata verbs.
 */
export interface KitStore {
  /** List all available kits. */
  listKits(): Promise<KitMeta[]>;

  /** Get metadata for a single kit. Throws NotFoundError if missing. */
  getKit(kitId: KitId): Promise<KitMeta>;

  /**
   * List files within a kit as rich entries (path + size + SRI hash +
   * lastModified). Sorted by `path` ASC for deterministic output. The
   * default-excluded dirs (`node_modules`/`.git`/`dist`/`.genie-tmp`), the
   * `.kit.json` marker, and any `.genieignore` patterns are honoured by the
   * adapter that has a notion of them (LocalFs); adapters without local
   * ignore semantics (GitHost) treat the tracked tree as authoritative.
   * Throws NotFoundError if the kit does not exist.
   */
  listFiles(kitId: KitId): Promise<KitFileEntry[]>;

  /**
   * List components within a kit, optionally filtered by group.
   * Returns an array of component metadata sorted by group ASC, then name ASC, then path ASC (for deterministic ordering when group + name collide).
   * Throws NotFoundError if the kit does not exist.
   */
  listComponents(params: {
    kitId: KitId;
    group?: string;
  }): Promise<ComponentEntry[]>;

  /**
   * Read a file from a kit as rich content (content + encoding + mimeType).
   * The store owns MIME resolution and text/binary classification, and returns
   * base64 for binary files / utf-8 for text.
   * Throws FileTooLargeError if the file exceeds MAX_FILE_BYTES.
   * Throws NotFoundError if the kit or file does not exist.
   */
  readFile(kitId: KitId, path: string): Promise<KitFileContent>;

  /**
   * Delete a single file from a kit's readable surface (the LocalFs kit dir /
   * the git-host default branch). Returns `{ existed }`:
   *   - `existed: true`  — the file was present and has been removed.
   *   - `existed: false` — the file (or its whole kit) was already absent — an
   *     idempotent no-op, NOT an error. This is the `delete_files`
   *     silent-retry case (an authorized path that no longer exists lands in
   *     `notFoundPaths`, not a failure).
   * Plan-gating (which paths a caller may delete) is NOT a store concern — it
   * stays in the `delete_files` tool (planId → `deletes` globs), as does the
   * path-shape / kitId-shape traversal guard. This primitive only performs the
   * physical removal once the tool has authorized it. A hard removal failure
   * that is NOT "already absent" (e.g. a directory target → EISDIR, a
   * permission error) propagates as the adapter's native error, which the tool
   * surfaces as `DeleteFailed`.
   */
  deleteFile(kitId: KitId, path: string): Promise<{ existed: boolean }>;

  /**
   * Create a new kit with the given name and metadata. Returns its metadata.
   * Throws KitAlreadyExistsError if a kit with the same ID already exists.
   */
  createKit(name: string, kitId?: string): Promise<KitMeta>;

  /**
   * Open a plan (staging area) for a kit. Applies initial writes/deletes.
   * Returns a planId that can be used with commitPlan/closePlan.
   */
  openPlan(
    kitId: KitId,
    ops: FileOp[],
  ): Promise<PlanId>;

  /**
   * Commit additional file operations to an existing plan.
   * In LocalFsStore this writes to a staging dir; in GitHostStore it commits
   * to the plan branch.
   */
  commitPlan(kitId: KitId, planId: PlanId, ops: FileOp[]): Promise<void>;

  /**
   * Close a plan (discard the staging area / delete the plan branch).
   * Idempotent — closing an already-closed plan is a no-op.
   */
  closePlan(kitId: KitId, planId: PlanId): Promise<void>;
}

// ─── ProjectStore interface ──────────────────────────────────────────────────

/**
 * AC2 — ProjectStore defines:
 *   listProjects, getProject, createProject, deleteProject,
 *   bindKit, recordScreen.
 */
export interface ProjectStore {
  /** List all projects. */
  listProjects(): Promise<ProjectMeta[]>;

  /** Get metadata for a single project. Throws NotFoundError if missing. */
  getProject(projectId: ProjectId): Promise<ProjectMeta>;

  /** Create a new project with the given name. */
  createProject(name: string): Promise<ProjectMeta>;

  /** Delete a project. Throws NotFoundError if missing. */
  deleteProject(projectId: ProjectId): Promise<void>;

  /**
   * Bind a kit to a project. Throws NotFoundError if the project is missing.
   * Note: kit existence is not validated by this interface.
   */
  bindKit(projectId: ProjectId, kitId: KitId): Promise<void>;

  /**
   * Record a screen capture reference for a project.
   * Stores the path/url for later retrieval.
   */
  recordScreen(projectId: ProjectId, screenRef: string): Promise<void>;
}
