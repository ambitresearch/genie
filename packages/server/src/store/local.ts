import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type {
  CreateProjectArgs,
  KitBinding,
  ProjectMeta,
  ProjectStore,
} from "./interface.js";
import { BlueprintNotFoundError, ProjectExistsError } from "./interface.js";

/** Resolve the genie home directory (env override or default). */
function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), ".genie");
}

/** On-disk shape of `.genie/project.json`. */
interface ProjectJson {
  id: string;
  name: string;
  kind: "workspace" | "blueprint";
  kitBindings: KitBinding[];
  sourceBlueprintId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Local-filesystem project store.
 *
 * Layout: `<baseDir>/projects/<projectId>/.genie/project.json`
 *
 * Each project is a directory. The `.genie/project.json` manifest is the
 * single source of truth for project metadata. Starter files from blueprints
 * are copied into the project root at creation time (snapshot copy — AC6:
 * later blueprint edits do not propagate).
 */
export class LocalProjectStore implements ProjectStore {
  private readonly projectsDir: string;

  constructor(baseDir?: string) {
    this.projectsDir = join(baseDir ?? genieHome(), "projects");
  }

  /**
   * Resolve a project directory and ensure it stays within projectsDir.
   * Rejects path-traversal attempts (e.g. IDs containing "../").
   */
  private safeProjectDir(projectId: string): string {
    const resolved = resolve(this.projectsDir, projectId);
    if (!resolved.startsWith(this.projectsDir + "/") && resolved !== this.projectsDir) {
      throw new Error(`Invalid project ID: "${projectId}"`);
    }
    return resolved;
  }

  /** Read project.json for a given project directory, or undefined. */
  private async readProjectJson(
    projectDir: string,
  ): Promise<ProjectJson | undefined> {
    try {
      const raw = await readFile(
        join(projectDir, ".genie", "project.json"),
        "utf-8",
      );
      return JSON.parse(raw) as ProjectJson;
    } catch {
      return undefined;
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir);
    } catch {
      return [];
    }

    const results: ProjectMeta[] = [];
    for (const entry of entries) {
      const meta = await this.readProjectJson(
        join(this.projectsDir, entry),
      );
      if (meta) results.push(meta);
    }

    // Deterministic sort: kind → name → id (M1-16 AC8)
    results.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
    return results;
  }

  async getProject(projectId: string): Promise<ProjectMeta | undefined> {
    return this.readProjectJson(this.safeProjectDir(projectId));
  }

  async createProject(args: CreateProjectArgs): Promise<ProjectMeta> {
    // Duplicate-name check (AC7)
    const existing = await this.listProjects();
    const dup = existing.find((p) => p.name === args.name);
    if (dup) {
      throw new ProjectExistsError(
        args.name,
        `${args.name}-${randomUUID().slice(0, 8)}`,
      );
    }

    // Blueprint source resolution (AC5, AC8)
    let blueprintMeta: ProjectMeta | undefined;
    if (args.fromBlueprintId) {
      blueprintMeta = await this.getProject(args.fromBlueprintId);
      if (!blueprintMeta || blueprintMeta.kind !== "blueprint") {
        throw new BlueprintNotFoundError(args.fromBlueprintId);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const projectDir = join(this.projectsDir, id);
    const genieDir = join(projectDir, ".genie");

    // Copy blueprint files first if applicable (AC5 — snapshot copy, AC6)
    if (blueprintMeta) {
      const sourceDir = join(this.projectsDir, blueprintMeta.id);
      await cp(sourceDir, projectDir, { recursive: true });
    }

    // Ensure .genie dir exists (may already exist from blueprint copy)
    await mkdir(genieDir, { recursive: true });

    // Resolve kit bindings: prefer explicit, fall back to blueprint, default to empty
    const kitBindings = args.kitBindings ??
      blueprintMeta?.kitBindings ??
      [];

    const meta: ProjectJson = {
      id,
      name: args.name,
      kind: args.kind,
      kitBindings,
      createdAt: now,
      updatedAt: now,
      ...(blueprintMeta ? { sourceBlueprintId: blueprintMeta.id } : {}),
    };

    await writeFile(
      join(genieDir, "project.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8",
    );

    return meta;
  }
}
