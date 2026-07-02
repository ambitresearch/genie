import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const CREATE_PROJECT_TOOL_NAME = "mcp__genie__create_project";

export const PROJECT_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

const projectKindSchema = z.enum(["workspace", "blueprint"]);
const kitBindingSchema = z
  .object({
    kitId: z.string().min(1),
    default: z.boolean().optional(),
  })
  .strict();

const createProjectArgsSchema = z
  .object({
    name: z.string().min(1).max(128),
    kind: projectKindSchema,
    fromBlueprintId: z.string().regex(PROJECT_ID_PATTERN).optional(),
    kitBindings: z.array(kitBindingSchema).max(32).optional(),
  })
  .strict();

/** A recorded screen artifact within a project (written by `conjure_screen`, M1-21). */
const projectScreenSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const projectManifestSchema = z
  .object({
    id: z.string().regex(PROJECT_ID_PATTERN),
    name: z.string(),
    kind: projectKindSchema,
    defaultKitId: z.string().optional(),
    kitBindings: z.array(kitBindingSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceBlueprintId: z.string().optional(),
    // Optional + absent from every manifest `create_project` writes today: no M1 tool
    // records screens yet (that lands with `conjure_screen`, M1-21). Optional keeps
    // existing on-disk manifests parsing unchanged; `get_project` defaults this to `[]`.
    screens: z.array(projectScreenSchema).optional(),
  })
  .strict();

export type ProjectKind = z.infer<typeof projectKindSchema>;
export type KitBinding = z.infer<typeof kitBindingSchema>;
export type ProjectScreen = z.infer<typeof projectScreenSchema>;
export type CreateProjectArgs = z.infer<typeof createProjectArgsSchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export interface ProjectSummary extends Record<string, unknown> {
  id: string;
  name: string;
  kind: ProjectKind;
  defaultKitId?: string;
  kitBindings: KitBinding[];
  updatedAt: string;
  canEdit: boolean;
}

/** Full detail returned by `get_project` — a `ProjectSummary` plus screens and provenance. */
export interface ProjectDetail extends ProjectSummary {
  screens: ProjectScreen[];
  sourceBlueprintId?: string;
}

/**
 * Shared output shape for a `ProjectSummary`, consumed by both `list_projects` and
 * `get_project` so the two tools' schemas can't drift apart (Implementation Notes:
 * "Share schema helpers with list_projects").
 */
export const projectSummaryShape = {
  id: z.string().regex(PROJECT_ID_PATTERN),
  name: z.string(),
  kind: projectKindSchema,
  defaultKitId: z.string().optional(),
  kitBindings: z.array(kitBindingSchema),
  updatedAt: z.string(),
  canEdit: z.boolean(),
};

/** Shared output shape for a single recorded screen entry (see `ProjectDetail.screens`). */
export const projectScreenShape = {
  id: z.string(),
  path: z.string(),
  title: z.string(),
  updatedAt: z.string(),
};

export interface CreateProjectResult extends Record<string, unknown> {
  projectId: string;
}

export type ProjectStoreErrorCode =
  | "ERR_PROJECT_EXISTS"
  | "ERR_BLUEPRINT_NOT_FOUND"
  | "ERR_INVALID_PROJECT_NAME"
  | "ERR_PROJECT_NOT_FOUND";

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;
  readonly suggestedSlug?: string;
  readonly projectId?: string;

  constructor(
    code: ProjectStoreErrorCode,
    message: string,
    options: { suggestedSlug?: string; projectId?: string } = {},
  ) {
    super(message);
    this.name = "ProjectStoreError";
    this.code = code;
    this.suggestedSlug = options.suggestedSlug;
    this.projectId = options.projectId;
  }
}

export class ProjectStore {
  constructor(readonly root: string) {}

  async createProject(args: CreateProjectArgs): Promise<CreateProjectResult> {
    const parsed = createProjectArgsSchema.parse(args);
    if (parsed.fromBlueprintId && parsed.kind !== "workspace") {
      throw new ProjectStoreError(
        "ERR_BLUEPRINT_NOT_FOUND",
        "Blueprint instantiation is only supported for workspace projects.",
      );
    }

    await mkdir(this.root, { recursive: true });
    const projectId = slugify(parsed.name);
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new ProjectStoreError(
        "ERR_INVALID_PROJECT_NAME",
        "Project name must produce a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
      );
    }

    const existing = await this.findExistingProject(parsed.name, projectId);
    if (existing) {
      throw new ProjectStoreError(
        "ERR_PROJECT_EXISTS",
        `Project "${parsed.name}" already exists.`,
        {
          suggestedSlug: await this.suggestSlug(projectId),
        },
      );
    }

    const sourceBlueprint = parsed.fromBlueprintId
      ? await this.readBlueprint(parsed.fromBlueprintId)
      : undefined;
    const targetRoot = this.projectRoot(projectId);

    if (sourceBlueprint) {
      await cp(this.projectRoot(sourceBlueprint.id), targetRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (source) =>
          relative(this.projectRoot(sourceBlueprint.id), source).replaceAll("\\", "/") !==
          ".genie/project.json",
      });
    } else {
      await mkdir(targetRoot, { recursive: false });
    }

    const now = new Date().toISOString();
    const kitBindings = parsed.kitBindings ?? sourceBlueprint?.kitBindings ?? [];
    const manifestDefaultKitId = defaultKitId(kitBindings);
    const manifest: ProjectManifest = {
      id: projectId,
      name: parsed.name,
      kind: parsed.kind,
      ...(manifestDefaultKitId ? { defaultKitId: manifestDefaultKitId } : {}),
      kitBindings,
      createdAt: now,
      updatedAt: now,
      ...(sourceBlueprint ? { sourceBlueprintId: sourceBlueprint.id } : {}),
    };
    await this.writeManifest(projectId, manifest);

    return { projectId };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const projects: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!PROJECT_ID_PATTERN.test(entry.name)) continue;
      const manifest = await this.readListManifest(entry.name);
      if (!manifest) continue;
      projects.push(projectSummary(manifest));
    }
    return projects.sort(compareProjectSummaries);
  }

  /**
   * Get full detail for a single project (workspace or blueprint — same shape,
   * no special-case tool family; AC4). Throws `ProjectStoreError("ERR_PROJECT_NOT_FOUND")`
   * with the id echoed (AC5) for a missing, unreadable, or malformed manifest — the same
   * leniency `readListManifest` already applies when enumerating projects.
   */
  async getProject(projectId: string): Promise<ProjectDetail> {
    const manifest = await this.readListManifest(projectId);
    if (!manifest) {
      throw new ProjectStoreError(
        "ERR_PROJECT_NOT_FOUND",
        `Project "${projectId}" was not found.`,
        { projectId },
      );
    }
    return {
      ...projectSummary(manifest),
      canEdit: !existsSync(join(this.projectRoot(projectId), ".genie", ".readonly")),
      screens: manifest.screens ?? [],
      ...(manifest.sourceBlueprintId ? { sourceBlueprintId: manifest.sourceBlueprintId } : {}),
    };
  }

  private projectRoot(projectId: string): string {
    return join(this.root, projectId);
  }

  private manifestPath(projectId: string): string {
    return join(this.projectRoot(projectId), ".genie", "project.json");
  }

  private async writeManifest(projectId: string, manifest: ProjectManifest): Promise<void> {
    await mkdir(join(this.projectRoot(projectId), ".genie"), { recursive: true });
    await writeFile(this.manifestPath(projectId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private async readManifest(projectId: string): Promise<ProjectManifest | undefined> {
    const path = this.manifestPath(projectId);
    if (!existsSync(path)) return undefined;
    const raw = await readFile(path, "utf8");
    const manifest = projectManifestSchema.parse(JSON.parse(raw));
    if (manifest.id !== projectId) {
      throw new ProjectStoreError(
        "ERR_BLUEPRINT_NOT_FOUND",
        `Project manifest id "${manifest.id}" does not match directory "${projectId}".`,
      );
    }
    return manifest;
  }

  private async readBlueprint(projectId: string): Promise<ProjectManifest> {
    const manifest = await this.readManifest(projectId);
    if (!manifest || manifest.kind !== "blueprint") {
      throw new ProjectStoreError(
        "ERR_BLUEPRINT_NOT_FOUND",
        `Blueprint "${projectId}" was not found.`,
      );
    }
    return manifest;
  }

  private async readListManifest(projectId: string): Promise<ProjectManifest | undefined> {
    try {
      return await this.readManifest(projectId);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        error instanceof z.ZodError ||
        error instanceof ProjectStoreError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async findExistingProject(
    name: string,
    projectId: string,
  ): Promise<ProjectManifest | undefined> {
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!PROJECT_ID_PATTERN.test(entry.name)) continue;
      if (entry.name === projectId) return (await this.readManifest(entry.name)) ?? undefined;
      const manifest = await this.readManifest(entry.name);
      if (manifest?.name.toLocaleLowerCase() === name.toLocaleLowerCase()) return manifest;
    }
    return undefined;
  }

  private async suggestSlug(baseSlug: string): Promise<string> {
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${baseSlug}-${suffix}`;
      if (!existsSync(this.projectRoot(candidate))) return candidate;
    }
    return `${baseSlug}-${Date.now()}`;
  }
}

export function registerCreateProjectTool(server: McpServer, store: ProjectStore): void {
  server.registerTool(
    CREATE_PROJECT_TOOL_NAME,
    {
      title: "Create project",
      description:
        "Create a blank workspace, create a reusable blueprint project, or instantiate a workspace from a blueprint.",
      inputSchema: {
        name: z.string().min(1).max(128),
        kind: projectKindSchema,
        fromBlueprintId: z.string().regex(PROJECT_ID_PATTERN).optional(),
        kitBindings: z.array(kitBindingSchema).max(32).optional(),
      },
      outputSchema: {
        projectId: z.string(),
      },
    },
    async (args) => {
      try {
        const result = await store.createProject(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
                  ...(error.suggestedSlug ? { suggestedSlug: error.suggestedSlug } : {}),
                }),
              },
            ],
          };
        }
        throw error;
      }
    },
  );
}

function slugify(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function projectSummary(manifest: ProjectManifest): ProjectSummary {
  const defaultId = manifest.defaultKitId ?? defaultKitId(manifest.kitBindings);
  return {
    id: manifest.id,
    name: manifest.name,
    kind: manifest.kind,
    ...(defaultId ? { defaultKitId: defaultId } : {}),
    kitBindings: manifest.kitBindings,
    updatedAt: manifest.updatedAt,
    canEdit: true,
  };
}

function defaultKitId(kitBindings: KitBinding[]): string | undefined {
  return kitBindings.find((binding) => binding.default)?.kitId;
}

function compareProjectSummaries(a: ProjectSummary, b: ProjectSummary): number {
  return compareText(a.kind, b.kind) || compareText(a.name, b.name) || compareText(a.id, b.id);
}

function compareText(a: string, b: string): number {
  const aNorm = a.normalize("NFC").toLowerCase();
  const bNorm = b.normalize("NFC").toLowerCase();
  return aNorm < bNorm ? -1 : aNorm > bNorm ? 1 : a < b ? -1 : a > b ? 1 : 0;
}
