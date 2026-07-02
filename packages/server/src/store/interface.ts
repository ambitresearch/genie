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
 */
export interface KitStore {
  /** List all available kits. */
  listKits(): Promise<KitMeta[]>;

  /** Get metadata for a single kit. Throws NotFoundError if missing. */
  getKit(kitId: KitId): Promise<KitMeta>;

  /** List relative file paths within a kit. */
  listFiles(kitId: KitId): Promise<string[]>;

  /**
   * List components within a kit, optionally filtered by group.
   * Returns an array of component metadata sorted by group ASC, then name ASC.
   * Throws NotFoundError if the kit does not exist.
   */
  listComponents(params: {
    kitId: KitId;
    group?: string;
  }): Promise<ComponentEntry[]>;

  /**
   * Read a file from a kit.
   * Throws FileTooLargeError if the file exceeds MAX_FILE_BYTES.
   * Throws NotFoundError if the kit or file does not exist.
   */
  readFile(kitId: KitId, path: string): Promise<string>;

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
