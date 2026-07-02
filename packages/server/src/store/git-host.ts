/**
 * GitHostStore — shared adapter for any git host (GitHub / Gitea / GitLab).
 *
 * AC4: Uses a git-host SDK against an operator-configured base URL.
 *   plan = branch `plan/${planId}`, commit on `commitPlan`, no auto-merge.
 * AC6: Honours its token from env (`GENIE_GIT_TOKEN`), fails fast with a
 *   clear error if missing.
 *
 * The adapter communicates with the git host via its HTTP REST API (Gitea is
 * the reference instance). No git host is privileged in the abstraction and
 * no provider URL is baked into the code.
 */

import { randomUUID } from "node:crypto";

import type {
  FileOp,
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
  MissingCredentialError,
  NotFoundError,
} from "./interface.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface GitHostConfig {
  /** Base URL of the git host API (e.g. "https://gitea.example.com/api/v1"). */
  baseUrl: string;
  /** API token. If not provided, reads from GENIE_GIT_TOKEN env var. */
  token?: string;
  /** Owner / org name on the git host. */
  owner: string;
}

function resolveToken(cfg: GitHostConfig): string {
  const token = cfg.token ?? process.env["GENIE_GIT_TOKEN"];
  if (!token) throw new MissingCredentialError("GENIE_GIT_TOKEN");
  return token;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  baseUrl: string;
  token: string;
}

async function apiRequest<T>(opts: RequestOptions): Promise<T> {
  const url = `${opts.baseUrl}${opts.path}`;
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      Authorization: `token ${opts.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 404) {
    throw new NotFoundError("resource", opts.path);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Git host API error: ${res.status} ${res.statusText} — ${text}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Git host API response types ─────────────────────────────────────────────

interface RepoResponse {
  name: string;
  full_name: string;
  created_at: string;
  description?: string;
  default_branch?: string;
}

interface ContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  content?: string;
  encoding?: string;
}

interface BranchResponse {
  name: string;
}

interface FileResponse {
  content: {
    sha: string;
  };
}

// ─── GitHostKitStore ─────────────────────────────────────────────────────────

/**
 * Maps kits to repositories on the git host.
 * A kitId is the repository name under the configured owner.
 */
export class GitHostKitStore implements KitStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly owner: string;

  constructor(config: GitHostConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = resolveToken(config);
    this.owner = config.owner;
  }

  private api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return apiRequest({
      method,
      path,
      body,
      baseUrl: this.baseUrl,
      token: this.token,
    });
  }

  async listKits(): Promise<KitMeta[]> {
    const repos = await this.api<RepoResponse[]>(
      "GET",
      `/repos/search?q=&owner=${encodeURIComponent(this.owner)}&limit=50`,
    );
    // Gitea returns { data: [...] } wrapper for search
    const list = Array.isArray(repos)
      ? repos
      : ((repos as unknown as { data: RepoResponse[] }).data ?? []);
    return list.map((r) => ({
      id: r.name,
      name: r.name,
      type: KIT_TYPE,
      createdAt: r.created_at,
    }));
  }

  async getKit(kitId: KitId): Promise<KitMeta> {
    try {
      const repo = await this.api<RepoResponse>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}`,
      );
      return {
        id: repo.name,
        name: repo.name,
        type: KIT_TYPE,
        createdAt: repo.created_at,
      };
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError("Kit", kitId);
      throw e;
    }
  }

  async listFiles(kitId: KitId): Promise<string[]> {
    // Get the full tree recursively
    const entries = await this.listTree(kitId, "");
    return entries.sort();
  }

  async listComponents(params: {
    kitId: KitId;
    group?: string;
  }): Promise<import("./interface.js").ComponentEntry[]> {
    // For now, return empty array as M3-03 manifest compiler is not yet implemented
    // TODO: After M3-03 lands, fetch .genie/manifest.json from the kit repository
    const components: import("./interface.js").ComponentEntry[] = [];

    // Filter by group if specified
    if (params.group) {
      return components.filter((c) => c.group === params.group);
    }

    return components;
  }

  private async listTree(kitId: KitId, dirPath: string): Promise<string[]> {
    const path = dirPath
      ? `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${dirPath}`
      : `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents`;
    let entries: ContentEntry[];
    try {
      entries = await this.api<ContentEntry[]>("GET", path);
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError("Kit", kitId);
      throw e;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.type === "file") {
        files.push(entry.path);
      } else if (entry.type === "dir") {
        const children = await this.listTree(kitId, entry.path);
        files.push(...children);
      }
    }
    return files;
  }

  async readFile(kitId: KitId, path: string): Promise<string> {
    // Encode each path segment to handle spaces, #, ?, etc.
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    let entry: ContentEntry;
    try {
      entry = await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
      );
    } catch (e) {
      if (e instanceof NotFoundError)
        throw new NotFoundError("File", `${kitId}/${path}`);
      throw e;
    }

    // Validate that this is a file, not a directory
    if (entry.type !== "file") {
      throw new NotFoundError("File", `${kitId}/${path}`);
    }

    if (entry.size && entry.size > MAX_FILE_BYTES) {
      throw new FileTooLargeError(path, entry.size);
    }

    // Validate that content is actually present
    if (!entry.content) {
      throw new Error(
        `File "${kitId}/${path}" returned no content from the git host API.`,
      );
    }

    if (entry.encoding === "base64") {
      const decoded = Buffer.from(entry.content, "base64").toString("utf-8");
      // Fallback size check when entry.size was not provided by the API
      const byteLength = Buffer.byteLength(decoded, "utf-8");
      if (byteLength > MAX_FILE_BYTES) {
        throw new FileTooLargeError(path, byteLength);
      }
      return decoded;
    }

    // If encoding is not base64, treat content as plain text
    return entry.content;
  }

  async createKit(name: string, kitId?: string): Promise<KitMeta> {
    const repoName = kitId ?? name;
    try {
      const repo = await this.api<RepoResponse>(
        "POST",
        `/orgs/${encodeURIComponent(this.owner)}/repos`,
        {
          name: repoName,
          auto_init: true,
          private: true,
        },
      );
      return {
        id: repo.name,
        name: repo.name,
        type: KIT_TYPE,
        createdAt: repo.created_at,
      };
    } catch (err: unknown) {
      // Check if it's a 409 Conflict indicating repo already exists
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        err.status === 409
      ) {
        throw new KitAlreadyExistsError(repoName);
      }
      throw err;
    }
  }

  async openPlan(kitId: KitId, ops: FileOp[]): Promise<PlanId> {
    // Validate kit exists
    await this.getKit(kitId);
    const planId = randomUUID();
    const branchName = `plan/${planId}`;

    // Get the default branch SHA to branch from
    const repo = await this.api<RepoResponse>(
      "GET",
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}`,
    );
    const defaultBranch = repo.default_branch ?? "main";

    // Create the plan branch
    await this.api<BranchResponse>(
      "POST",
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/branches`,
      {
        new_branch_name: branchName,
        old_branch_name: defaultBranch,
      },
    );

    // Apply initial operations
    if (ops.length > 0) {
      await this.applyOps(kitId, branchName, ops);
    }

    return planId;
  }

  async commitPlan(
    kitId: KitId,
    planId: PlanId,
    ops: FileOp[],
  ): Promise<void> {
    const branchName = `plan/${planId}`;
    // Verify branch exists by trying to get it
    try {
      await this.api<BranchResponse>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/branches/${encodeURIComponent(branchName)}`,
      );
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError("Plan", planId);
      throw e;
    }
    await this.applyOps(kitId, branchName, ops);
  }

  async closePlan(kitId: KitId, planId: PlanId): Promise<void> {
    const branchName = `plan/${planId}`;
    try {
      await this.api<void>(
        "DELETE",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/branches/${encodeURIComponent(branchName)}`,
      );
    } catch {
      // Idempotent — branch already deleted or never existed
    }
  }

  private async applyOps(
    kitId: KitId,
    branch: string,
    ops: FileOp[],
  ): Promise<void> {
    for (const op of ops) {
      // Validate path for traversal-like segments
      const pathSegments = op.path.split("/");
      for (const segment of pathSegments) {
        if (segment === ".." || segment === "." || segment === "") {
          throw new Error(
            `Invalid path in file operation: "${op.path}" contains traversal or empty segments.`,
          );
        }
      }
      // Encode each path segment to handle spaces, #, ?, etc.
      // Consistent with readFile()'s encoding strategy.
      const encodedPath = pathSegments.map(encodeURIComponent).join("/");

      if (op.kind === "write") {
        const content = Buffer.from(op.content).toString("base64");
        // Try to get existing file for its SHA (needed for update)
        let existingSha: string | undefined;
        try {
          const existing = await this.api<ContentEntry>(
            "GET",
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
          );
          // The Gitea API returns sha at the top level for file content
          existingSha = (existing as unknown as { sha?: string }).sha;
        } catch (e) {
          // Only "file doesn't exist" should fall through to create.
          // Rethrow other failures (auth, network, server errors) so callers
          // aren't silently misled into creating an overwrite.
          if (!(e instanceof NotFoundError)) throw e;
        }
        const body: Record<string, string> = {
          content,
          message: `plan: write ${op.path}`,
          branch,
        };
        if (existingSha) body["sha"] = existingSha;
        await this.api<FileResponse>(
          existingSha ? "PUT" : "POST",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
          body,
        );
      } else {
        // Delete: need the file SHA
        let sha: string;
        try {
          const existing = await this.api<ContentEntry>(
            "GET",
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
          );
          sha = (existing as unknown as { sha?: string }).sha ?? "";
        } catch (e) {
          // File doesn't exist — idempotent delete, nothing to do.
          if (e instanceof NotFoundError) continue;
          // Surface transient API/auth failures rather than silently skipping.
          throw e;
        }
        await this.api<void>(
          "DELETE",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
          {
            message: `plan: delete ${op.path}`,
            branch,
            sha,
          },
        );
      }
    }
  }
}

// ─── GitHostProjectStore ─────────────────────────────────────────────────────

/**
 * Stores project metadata in a dedicated repo (`_genie-projects`) as JSON files.
 * Each project is a file `projects/<projectId>.json`.
 */
export class GitHostProjectStore implements ProjectStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly owner: string;
  private readonly metaRepo = "_genie-projects";

  constructor(config: GitHostConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = resolveToken(config);
    this.owner = config.owner;
  }

  private api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return apiRequest({
      method,
      path,
      body,
      baseUrl: this.baseUrl,
      token: this.token,
    });
  }

  private projectPath(projectId: ProjectId): string {
    return `projects/${projectId}.json`;
  }

  private async ensureMetaRepo(): Promise<void> {
    try {
      await this.api<RepoResponse>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}`,
      );
    } catch (e) {
      // Only auto-create on NotFoundError; rethrow other failures
      if (e instanceof NotFoundError) {
        await this.api<RepoResponse>(
          "POST",
          `/orgs/${encodeURIComponent(this.owner)}/repos`,
          { name: this.metaRepo, auto_init: true, private: true },
        );
      } else {
        throw e;
      }
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    await this.ensureMetaRepo();
    let entries: ContentEntry[];
    try {
      entries = await this.api<ContentEntry[]>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/projects`,
      );
    } catch {
      return [];
    }
    const projects: ProjectMeta[] = [];
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      try {
        const file = await this.api<ContentEntry>(
          "GET",
          `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${entry.path}`,
        );
        if (file.content && file.encoding === "base64") {
          const data = JSON.parse(
            Buffer.from(file.content, "base64").toString("utf-8"),
          ) as ProjectMeta;
          projects.push(data);
        }
      } catch {
        // Skip malformed entries
      }
    }
    return projects;
  }

  async getProject(projectId: ProjectId): Promise<ProjectMeta> {
    await this.ensureMetaRepo();
    try {
      const file = await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
      );
      if (file.content && file.encoding === "base64") {
        return JSON.parse(
          Buffer.from(file.content, "base64").toString("utf-8"),
        ) as ProjectMeta;
      }
    } catch {
      // fall through to NotFoundError
    }
    throw new NotFoundError("Project", projectId);
  }

  async createProject(name: string): Promise<ProjectMeta> {
    await this.ensureMetaRepo();
    const id = randomUUID();
    const meta: ProjectMeta = {
      id,
      name,
      createdAt: new Date().toISOString(),
    };
    const content = Buffer.from(JSON.stringify(meta, null, 2)).toString(
      "base64",
    );
    await this.api<FileResponse>(
      "POST",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(id)}`,
      { content, message: `project: create ${name}` },
    );
    return meta;
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    await this.ensureMetaRepo();
    let sha: string;
    try {
      const file = await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
      );
      sha = (file as unknown as { sha: string }).sha;
    } catch {
      throw new NotFoundError("Project", projectId);
    }
    await this.api<void>(
      "DELETE",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
      { message: `project: delete ${projectId}`, sha },
    );
  }

  async bindKit(projectId: ProjectId, kitId: KitId): Promise<void> {
    const meta = await this.getProject(projectId);
    meta.kitId = kitId;
    await this.updateProjectMeta(projectId, { ...meta });
  }

  async recordScreen(projectId: ProjectId, screenRef: string): Promise<void> {
    const meta = await this.getProject(projectId) as ProjectMeta & { screens?: string[] };
    const screens = meta.screens ?? [];
    screens.push(screenRef);
    await this.updateProjectMeta(projectId, { ...meta, screens });
  }

  private async updateProjectMeta(
    projectId: ProjectId,
    meta: object,
  ): Promise<void> {
    const file = await this.api<ContentEntry>(
      "GET",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
    );
    const sha = (file as unknown as { sha: string }).sha;
    const content = Buffer.from(JSON.stringify(meta, null, 2)).toString(
      "base64",
    );
    await this.api<FileResponse>(
      "PUT",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
      { content, message: `project: update ${projectId}`, sha },
    );
  }
}
