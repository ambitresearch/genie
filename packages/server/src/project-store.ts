import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export type ProjectKind = "workspace" | "blueprint";

export interface KitBinding {
  kitId: string;
  default?: boolean;
}

export interface CreateProjectArgs {
  name: string;
  kind: ProjectKind;
  fromBlueprintId?: string;
  kitBindings?: KitBinding[];
}

export interface ProjectManifest {
  id: string;
  name: string;
  kind: ProjectKind;
  kitBindings: KitBinding[];
  updatedAt: string;
  sourceBlueprintId?: string;
  defaultKitId?: string;
}

export interface CreateProjectResult {
  projectId: string;
}

export type ProjectStoreErrorCode = "ERR_PROJECT_EXISTS" | "ERR_BLUEPRINT_NOT_FOUND";

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ProjectStoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProjectStoreError";
    this.code = code;
    this.details = details;
  }
}

export interface ProjectStoreOptions {
  rootDir: string;
}

export class ProjectStore {
  readonly rootDir: string;

  constructor(options: ProjectStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async createProject(args: CreateProjectArgs): Promise<CreateProjectResult> {
    const projectId = slugifyProjectName(args.name);
    const projectDir = join(this.rootDir, projectId);
    if (await pathExists(projectDir)) {
      throw new ProjectStoreError("ERR_PROJECT_EXISTS", `Project "${args.name}" already exists.`, {
        projectId,
        suggestedSlug: await this.suggestAvailableSlug(projectId),
      });
    }

    const blueprint = args.fromBlueprintId
      ? await this.getBlueprint(args.fromBlueprintId)
      : undefined;
    const kitBindings = args.kitBindings ?? blueprint?.manifest.kitBindings ?? [];
    const defaultKitId = kitBindings.find((binding) => binding.default)?.kitId;
    const manifest: ProjectManifest = {
      id: projectId,
      name: args.name,
      kind: args.kind,
      kitBindings,
      updatedAt: new Date().toISOString(),
      ...(args.fromBlueprintId ? { sourceBlueprintId: args.fromBlueprintId } : {}),
      ...(defaultKitId ? { defaultKitId } : {}),
    };

    await mkdir(projectDir);
    try {
      if (blueprint) {
        await copyStarterFiles(blueprint.dir, projectDir, await realpath(blueprint.dir));
      }
      await mkdir(join(projectDir, ".genie"), { recursive: true });
      await writeFile(
        join(projectDir, ".genie", "project.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      await rm(projectDir, { recursive: true, force: true });
      throw error;
    }

    return { projectId };
  }

  private async getBlueprint(
    blueprintId: string,
  ): Promise<{ dir: string; manifest: ProjectManifest }> {
    if (!isProjectSlug(blueprintId)) {
      throw new ProjectStoreError(
        "ERR_BLUEPRINT_NOT_FOUND",
        `Blueprint "${blueprintId}" was not found.`,
        { blueprintId },
      );
    }
    const dir = join(this.rootDir, blueprintId);
    try {
      const json = await readFile(join(dir, ".genie", "project.json"), "utf8");
      const manifest = JSON.parse(json) as ProjectManifest;
      if (manifest.kind === "blueprint") {
        return { dir, manifest };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isNodeFileNotFoundError(error)) {
        throw error;
      }
    }
    throw new ProjectStoreError(
      "ERR_BLUEPRINT_NOT_FOUND",
      `Blueprint "${blueprintId}" was not found.`,
      { blueprintId },
    );
  }

  private async suggestAvailableSlug(baseSlug: string): Promise<string> {
    for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
      const candidate = `${baseSlug}-${index}`;
      if (!(await pathExists(join(this.rootDir, candidate)))) {
        return candidate;
      }
    }
    throw new Error(`Could not find an available slug for "${baseSlug}".`);
  }
}

function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "project";
}

function isProjectSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function copyStarterFiles(
  sourceDir: string,
  destinationDir: string,
  sourceRootRealPath: string,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".genie" || entry.name === ".git") {
      continue;
    }
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyStarterFiles(source, destination, sourceRootRealPath);
    } else if (entry.isSymbolicLink()) {
      await copyResolvedSymlink(source, destination, sourceRootRealPath);
    } else if (entry.isFile()) {
      await copyFile(source, destination);
    }
  }
}

async function copyResolvedSymlink(
  source: string,
  destination: string,
  sourceRootRealPath: string,
): Promise<void> {
  const resolvedSource = await realpath(source);
  if (!isPathInside(sourceRootRealPath, resolvedSource)) {
    throw new Error(`Blueprint starter file symlink escapes blueprint root: ${source}`);
  }
  if (isIgnoredStarterPath(sourceRootRealPath, resolvedSource)) {
    throw new Error(`Blueprint starter file symlink targets ignored metadata: ${source}`);
  }

  const resolvedStats = await stat(resolvedSource);
  if (resolvedStats.isDirectory()) {
    throw new Error(`Blueprint starter file directory symlinks are not supported: ${source}`);
  } else if (resolvedStats.isFile()) {
    await copyFile(resolvedSource, destination);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isIgnoredStarterPath(root: string, candidate: string): boolean {
  return relative(root, candidate)
    .split(/[\\/]/)
    .some((segment) => segment === ".genie" || segment === ".git");
}

function isNodeFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
