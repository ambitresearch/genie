/**
 * Store interfaces for genie.
 *
 * Every M1 tool (M1-02 … M1-21) is coded against these interfaces, never
 * against `fs` directly. Adapters: InMemoryProjectStore (dev/test),
 * LocalFsStore (solo), GitHostStore (shared — any git host).
 *
 * @see docs/plan/00-decisions.md D-F — kits & projects
 * @see docs/github/issues/M1-01-storage-abstraction.md
 */

// ── Project types ────────────────────────────────────────────

/** A project is either a workspace (screen/app) or a reusable blueprint. */
export type ProjectKind = "workspace" | "blueprint";

/** Kit binding within a project: which kit and whether it is the default. */
export interface KitBinding {
  kitId: string;
  isDefault: boolean;
}

/** The project record returned by `listProjects` / `getProject`. */
export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  /** The id of the default kit, or `null` when no kit is bound. */
  defaultKitId: string | null;
  /** All bound kits (may be empty). */
  kitBindings: KitBinding[];
  /** ISO 8601 timestamp of last modification. */
  updatedAt: string;
  /** Whether the caller can write to this project. */
  canEdit: boolean;
}

// ── Warning metadata ─────────────────────────────────────────

/** Structured warning attached to every list response via `_meta.warnings`. */
export interface StoreWarning {
  code: string;
  message: string;
}

// ── ProjectStore ─────────────────────────────────────────────

/** Read/write interface for project persistence (M1-01 AC2). */
export interface ProjectStore {
  /**
   * Return every reachable project (both `workspace` and `blueprint`).
   *
   * When a remote backend is unreachable the adapter MUST still return
   * whatever local results it has, and append a warning to the second
   * element of the tuple.
   *
   * @returns `[projects, warnings]`
   */
  listProjects(): Promise<[Project[], StoreWarning[]]>;
}
