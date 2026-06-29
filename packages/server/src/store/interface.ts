/**
 * Store interfaces for genie projects and kits.
 *
 * M1-01 defines the full surface; this file ships the subset needed by M1-18
 * (create_project) and will be extended as later tools land.
 */

// ── Project types ──────────────────────────────────────────────────────────

export type ProjectKind = "workspace" | "blueprint";

export interface KitBinding {
  kitId: string;
  alias?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  kind: ProjectKind;
  kitBindings: KitBinding[];
  sourceBlueprintId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Error codes ────────────────────────────────────────────────────────────

export class ProjectExistsError extends Error {
  readonly code = "ERR_PROJECT_EXISTS" as const;
  readonly suggestedSlug: string;
  constructor(name: string, suggestedSlug: string) {
    super(`A project named "${name}" already exists. Try "${suggestedSlug}".`);
    this.suggestedSlug = suggestedSlug;
  }
}

export class BlueprintNotFoundError extends Error {
  readonly code = "ERR_BLUEPRINT_NOT_FOUND" as const;
  constructor(id: string) {
    super(`Blueprint "${id}" not found.`);
  }
}

// ── Store interface ────────────────────────────────────────────────────────

export interface CreateProjectArgs {
  name: string;
  kind: ProjectKind;
  fromBlueprintId?: string;
  kitBindings?: KitBinding[];
}

export interface ProjectStore {
  listProjects(): Promise<ProjectMeta[]>;
  getProject(projectId: string): Promise<ProjectMeta | undefined>;
  createProject(args: CreateProjectArgs): Promise<ProjectMeta>;
}
