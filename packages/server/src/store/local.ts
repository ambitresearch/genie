/**
 * LocalFsStore — solo-dev adapter.
 *
 * AC3: Stores kits under `${GENIE_HOME ?? ~/.genie}/kits/<kitId>/`
 * and projects under `${GENIE_HOME ?? ~/.genie}/projects/<projectId>/`.
 * Each plan is a temp staging directory.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  FileOp,
  KitFileContent,
  KitFileEntry,
  KitId,
  KitMeta,
  KitStore,
  PlanId,
  ProjectId,
  ProjectMeta,
  ProjectStore,
} from "./interface.js";
import {
  FileTooLargeError,
  KitAlreadyExistsError,
  KIT_TYPE,
  MAX_FILE_BYTES,
  NotFoundError,
} from "./interface.js";
import {
  buildIgnoreMatcher,
  classifyFileContent,
  parseGenieignore,
  sriSha256,
  type IgnoreMatcher,
} from "./kit-files.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genieHome(): string {
  return process.env["GENIE_HOME"] ?? join(homedir(), ".genie");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Resolve a path within a base directory and verify it doesn't escape.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 *
 * Uses path-segment-aware checks so legitimate names beginning with
 * the literal "..". (e.g. "..foo/bar") are not falsely rejected.
 */
function safePath(baseDir: string, userPath: string): string {
  const resolved = resolve(baseDir, userPath);
  const rel = relative(baseDir, resolved);
  // The relative path escapes baseDir only when it IS ".." itself,
  // starts with ".." followed by a path separator, or is absolute.
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(
      `Path traversal denied: "${userPath}" resolves outside the allowed directory.`,
    );
  }
  return resolved;
}

/**
 * Recursively walk a kit directory into rich `KitFileEntry` records
 * (kit-root-relative forward-slash `path`, byte `size`, `sha256-…` SRI `hash`,
 * ISO-8601 `lastModified`). The `.kit.json` marker and any path the `ignore`
 * matcher rejects (default dirs + `.genieignore`) are skipped. Symlinks and
 * other non-regular entries are ignored. Unsorted — the caller sorts by path.
 */
async function walkKitFiles(
  dir: string,
  root: string,
  ignore: IgnoreMatcher,
): Promise<KitFileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: KitFileEntry[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
    if (relativePath === ".kit.json" || ignore(relativePath)) continue;
    if (entry.isDirectory()) {
      files.push(...(await walkKitFiles(absolutePath, root, ignore)));
      continue;
    }
    if (!entry.isFile()) continue;
    const [stats, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
    files.push({
      path: relativePath,
      size: stats.size,
      hash: sriSha256(bytes),
      lastModified: stats.mtime.toISOString(),
    });
  }
  return files;
}

/** ENOENT (missing file) and ENOTDIR (a parent component is a file) both mean
 * "the path is not there". */
function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Read and parse a JSON metadata file, or return undefined. */
async function readMeta<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// ─── Metadata files ──────────────────────────────────────────────────────────

interface KitMetaFile {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

interface ProjectMetaFile {
  id: string;
  name: string;
  kitId?: string;
  screens: string[];
  createdAt: string;
}

// ─── LocalFsKitStore ─────────────────────────────────────────────────────────

export class LocalFsKitStore implements KitStore {
  private readonly baseDir: string;
  private readonly plansDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(genieHome(), "kits");
    this.plansDir = join(genieHome(), "plans");
  }

  private kitDir(kitId: KitId): string {
    return join(this.baseDir, kitId);
  }

  private kitMetaPath(kitId: KitId): string {
    return join(this.kitDir(kitId), ".kit.json");
  }

  private planDir(kitId: KitId, planId: PlanId): string {
    return join(this.plansDir, kitId, planId);
  }

  async listKits(): Promise<KitMeta[]> {
    await ensureDir(this.baseDir);
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const kits: KitMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta<KitMetaFile>(
        this.kitMetaPath(entry.name),
      );
      if (meta?.type === KIT_TYPE) {
        kits.push({
          id: meta.id,
          name: meta.name,
          type: KIT_TYPE,
          createdAt: meta.createdAt,
        });
      }
    }
    return kits;
  }

  async getKit(kitId: KitId): Promise<KitMeta> {
    const meta = await readMeta<KitMetaFile>(this.kitMetaPath(kitId));
    if (!meta || meta.type !== KIT_TYPE) throw new NotFoundError("Kit", kitId);
    return {
      id: meta.id,
      name: meta.name,
      type: KIT_TYPE,
      createdAt: meta.createdAt,
    };
  }

  async listFiles(kitId: KitId): Promise<KitFileEntry[]> {
    const dir = this.kitDir(kitId);
    try {
      await stat(dir);
    } catch {
      throw new NotFoundError("Kit", kitId);
    }
    const ignore = buildIgnoreMatcher(await this.readIgnorePatterns(dir));
    const files = await walkKitFiles(dir, dir, ignore);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Read the kit's `.genieignore` (if any) into active pattern lines. Absent
   * file → no extra patterns (the default-dir exclusion still applies).
   */
  private async readIgnorePatterns(kitDir: string): Promise<string[]> {
    try {
      const raw = await readFile(join(kitDir, ".genieignore"), "utf8");
      return parseGenieignore(raw);
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
  }

  async listComponents(params: {
    kitId: KitId;
    group?: string;
  }): Promise<import("./interface.js").ComponentEntry[]> {
    const { kitId, group } = params;

    // Validate kit exists and is properly configured (matches GitHostKitStore behavior)
    await this.getKit(kitId);

    // For now, return empty array as M3-03 manifest compiler is not yet implemented
    // TODO: After M3-03 lands, read from .genie/manifest.json
    const components: import("./interface.js").ComponentEntry[] = [];

    // Filter by group if specified (use explicit undefined check to handle empty string correctly)
    if (group !== undefined) {
      return components.filter((c) => c.group === group);
    }

    return components;
  }

  async readFile(kitId: KitId, path: string): Promise<KitFileContent> {
    // First check if kit exists
    const kitDir = this.kitDir(kitId);
    try {
      await stat(kitDir);
    } catch {
      throw new NotFoundError("Kit", kitId);
    }

    // Now check if file exists
    const filePath = safePath(kitDir, path);
    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch {
      throw new NotFoundError("File", `${kitId}/${path}`);
    }
    // A directory target is not a readable file.
    if (!fileStats.isFile()) {
      throw new NotFoundError("File", `${kitId}/${path}`);
    }
    if (fileStats.size > MAX_FILE_BYTES) {
      throw new FileTooLargeError(path, fileStats.size);
    }
    // Read raw bytes and let the shared classifier decide utf-8 vs base64 and
    // the MIME type — the exact logic the pre-store `read_file` tool ran, now
    // shared with GitHostKitStore so a read is byte-identical across adapters.
    const bytes = await readFile(filePath);
    return classifyFileContent(path, bytes);
  }

  async deleteFile(kitId: KitId, path: string): Promise<{ existed: boolean }> {
    // A missing kit is the same idempotent no-op as a missing file: the tool's
    // plan-gating has already authorized the path, and "not there" is the
    // silent-retry case, never a hard error. So we do NOT pre-stat the kit dir.
    const kitDir = this.kitDir(kitId);
    const filePath = safePath(kitDir, path);
    try {
      await unlink(filePath);
      return { existed: true };
    } catch (error) {
      if (isMissingPathError(error)) return { existed: false };
      throw error; // EISDIR / EPERM / … → tool maps to DeleteFailed.
    }
  }

  async createKit(name: string, kitId?: string): Promise<KitMeta> {
    const id = kitId ?? randomUUID();
    const dir = this.kitDir(id);

    // Defensive check: fail fast if kit directory already exists
    try {
      await stat(dir);
      throw new KitAlreadyExistsError(id);
    } catch (err: unknown) {
      if (err instanceof KitAlreadyExistsError) throw err;
      // Directory doesn't exist — proceed with creation
    }

    await ensureDir(dir);
    const meta: KitMetaFile = {
      id,
      name,
      type: KIT_TYPE,
      createdAt: new Date().toISOString(),
    };

    // Atomic write with exclusive flag to catch races
    try {
      await writeFile(this.kitMetaPath(id), JSON.stringify(meta, null, 2), {
        flag: "wx",
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new KitAlreadyExistsError(id);
      }
      throw err;
    }

    return {
      id: meta.id,
      name: meta.name,
      type: KIT_TYPE,
      createdAt: meta.createdAt,
    };
  }

  async openPlan(kitId: KitId, ops: FileOp[]): Promise<PlanId> {
    // Validate kit exists
    await this.getKit(kitId);
    const planId = randomUUID();
    const dir = this.planDir(kitId, planId);
    await ensureDir(dir);
    // Apply initial operations
    await this.applyOps(dir, ops);
    return planId;
  }

  async commitPlan(
    kitId: KitId,
    planId: PlanId,
    ops: FileOp[],
  ): Promise<void> {
    const dir = this.planDir(kitId, planId);
    try {
      await stat(dir);
    } catch {
      throw new NotFoundError("Plan", planId);
    }
    await this.applyOps(dir, ops);
  }

  async closePlan(kitId: KitId, planId: PlanId): Promise<void> {
    const dir = this.planDir(kitId, planId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Idempotent — already removed
    }
  }

  private async applyOps(dir: string, ops: FileOp[]): Promise<void> {
    for (const op of ops) {
      const target = safePath(dir, op.path);
      if (op.kind === "write") {
        await ensureDir(join(target, ".."));
        await writeFile(target, op.content);
      } else {
        await rm(target, { force: true });
      }
    }
  }
}

// ─── LocalFsProjectStore ─────────────────────────────────────────────────────

export class LocalFsProjectStore implements ProjectStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(genieHome(), "projects");
  }

  private projectDir(projectId: ProjectId): string {
    return join(this.baseDir, projectId);
  }

  private metaPath(projectId: ProjectId): string {
    return join(this.projectDir(projectId), ".project.json");
  }

  async listProjects(): Promise<ProjectMeta[]> {
    await ensureDir(this.baseDir);
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const projects: ProjectMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta<ProjectMetaFile>(
        this.metaPath(entry.name),
      );
      if (meta) {
        projects.push({
          id: meta.id,
          name: meta.name,
          kitId: meta.kitId,
          createdAt: meta.createdAt,
        });
      }
    }
    return projects;
  }

  async getProject(projectId: ProjectId): Promise<ProjectMeta> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId));
    if (!meta) throw new NotFoundError("Project", projectId);
    return {
      id: meta.id,
      name: meta.name,
      kitId: meta.kitId,
      createdAt: meta.createdAt,
    };
  }

  async createProject(name: string): Promise<ProjectMeta> {
    const id = randomUUID();
    const dir = this.projectDir(id);
    await ensureDir(dir);
    const meta: ProjectMetaFile = {
      id,
      name,
      screens: [],
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.metaPath(id), JSON.stringify(meta, null, 2));
    return { id: meta.id, name: meta.name, createdAt: meta.createdAt };
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId));
    if (!meta) throw new NotFoundError("Project", projectId);
    await rm(this.projectDir(projectId), { recursive: true, force: true });
  }

  async bindKit(projectId: ProjectId, kitId: KitId): Promise<void> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId));
    if (!meta) throw new NotFoundError("Project", projectId);
    meta.kitId = kitId;
    await writeFile(this.metaPath(projectId), JSON.stringify(meta, null, 2));
  }

  async recordScreen(projectId: ProjectId, screenRef: string): Promise<void> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId));
    if (!meta) throw new NotFoundError("Project", projectId);
    meta.screens.push(screenRef);
    await writeFile(this.metaPath(projectId), JSON.stringify(meta, null, 2));
  }
}
