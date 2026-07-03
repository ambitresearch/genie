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
import { createReadStream } from "node:fs";

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
  WriteOp,
} from "./interface.js";
import {
  FileTooLargeError,
  KitAlreadyExistsError,
  KIT_TYPE,
  MAX_FILE_BYTES,
  MissingCredentialError,
  NotFoundError,
  RollbackIncompleteError,
  WriteFailedError,
} from "./interface.js";
import {
  buildIgnoreMatcher,
  classifyFileContent,
  isSafeKitId,
  parseGenieignore,
  sriSha256,
} from "./kit-files.js";
import { MANIFEST_PATH, selectComponents } from "./manifest.js";

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

/** Human-readable message for a caught error (for WriteFailedError causes). */
function describeGitError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * Read a file fully into a Buffer by streaming (`createReadStream`), so the
 * `write_files` "never buffer a whole localPath in memory ahead of time"
 * property is preserved up to the point the contents API forces a single
 * base64 body. The tool has already containment-checked `sourcePath`.
 */
async function readStreamToBuffer(sourcePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(sourcePath);
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  baseUrl: string;
  token: string;
}

class GitHostApiError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
    body: string,
  ) {
    super(`Git host API error: ${status} ${statusText} — ${body}`);
    this.name = "GitHostApiError";
  }
}

/**
 * Build an EISDIR-shaped error for `deleteFile` on a directory / non-file
 * target. LocalFs's `unlink` throws a native `NodeJS.ErrnoException` with
 * `code: "EISDIR"` for the same case; the `delete_files` tool reads `error.code`
 * to compose its `DeleteFailed` message. Emitting an identically-`code`d error
 * keeps that failure byte-identical across adapters (RFC G-5 / DRO-568) instead
 * of GitHost silently no-op'ing where LocalFs hard-fails.
 */
function eisdirError(target: string): NodeJS.ErrnoException {
  const err = new Error(
    `EISDIR: illegal operation on a directory, unlink '${target}'`,
  ) as NodeJS.ErrnoException;
  err.code = "EISDIR";
  return err;
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
    throw new GitHostApiError(res.status, res.statusText, text);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Git host API response types ─────────────────────────────────────────────

interface RepoResponse {
  name: string;
  full_name: string;
  created_at: string;
  /** Last push/update time — the git-host `lastModified` parity source (see
   * `KitFileEntry`'s doc comment); may be absent on older Gitea versions. */
  updated_at?: string;
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
  sha?: string;
}

interface BranchResponse {
  name: string;
}

interface FileResponse {
  content: {
    sha: string;
  };
}

interface KitMetaFile {
  id: string;
  name: string;
  type: string;
  createdAt: string;
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
  private readonly kitMetaPath = ".kit.json";

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

  private repoPath(kitId: KitId): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}`;
  }

  private async readKitMeta(kitId: KitId): Promise<KitMeta | undefined> {
    try {
      const entry = await this.api<ContentEntry>(
        "GET",
        `${this.repoPath(kitId)}/contents/${this.kitMetaPath}`,
      );
      if (!entry.content || entry.encoding !== "base64") {
        throw new Error(`Kit metadata for "${kitId}" returned no base64 content.`);
      }
      const meta = JSON.parse(
        Buffer.from(entry.content, "base64").toString("utf-8"),
      ) as KitMetaFile;
      // The repository name (kitId) is authoritative for the kit's identity —
      // it is the path every subsequent API call routes through. A manually
      // edited or corrupted .kit.json could embed a divergent `id`; trusting it
      // would make listKits/getKit return an ID that resolves to no repo. So we
      // take only the human-readable fields (name, createdAt) from the file.
      return {
        id: kitId,
        name: meta.name,
        type: KIT_TYPE,
        createdAt: meta.createdAt,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private async writeKitMeta(meta: KitMeta): Promise<void> {
    const content = Buffer.from(JSON.stringify(meta, null, 2)).toString("base64");
    await this.api<FileResponse>("POST", `${this.repoPath(meta.id)}/contents/${this.kitMetaPath}`, {
      content,
      message: `kit: create ${meta.name}`,
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
    // Each repo needs its own .kit.json read. Fetch them concurrently so the
    // total time is bounded by the slowest request rather than the sum of all
    // N — the previous serial loop was an N+1 latency trap at limit=50.
    return Promise.all(
      list.map(async (repo) => {
        const meta = await this.readKitMeta(repo.name);
        return (
          meta ?? {
            id: repo.name,
            name: repo.name,
            type: KIT_TYPE,
            createdAt: repo.created_at,
          }
        );
      }),
    );
  }

  async getKit(kitId: KitId): Promise<KitMeta> {
    try {
      const repo = await this.api<RepoResponse>("GET", this.repoPath(kitId));
      const meta = await this.readKitMeta(kitId);
      if (meta) return meta;
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

  async listFiles(kitId: KitId): Promise<KitFileEntry[]> {
    // Same shared kitId rule LocalFs applies, so the two adapters cannot drift
    // (AC1). A git host maps each kit to a SEPARATE repo — `repoPath("")` is a
    // nonexistent repo, not a shared-root escape — so an unsafe id is simply a
    // missing kit here; rejecting it up front keeps the contract identical
    // (NotFoundError) without an extra 404 round-trip.
    if (!isSafeKitId(kitId)) throw new NotFoundError("Kit", kitId);
    // Repo metadata doubles as the kit-existence check AND the `lastModified`
    // parity source (updated_at → created_at). See KitFileEntry's doc comment
    // for why git-host entries carry a per-repo, not per-file, timestamp.
    const repo = await this.getRepo(kitId);
    const lastModified = repo.updated_at ?? repo.created_at;

    // Enumerate every tracked file path (recursive contents walk).
    const paths = await this.listTree(kitId, "");

    // Apply the SAME exclusion LocalFs uses — default dirs (node_modules/.git/
    // dist/.genie-tmp) + a committed `.genieignore` + the `.kit.json` marker —
    // so a listing is filtered identically whichever adapter backs it.
    const ignore = buildIgnoreMatcher(await this.readIgnorePatterns(kitId));
    const visible = paths.filter((path) => path !== this.kitMetaPath && !ignore(path));

    // A git host exposes no dependable per-file sha256 (its `sha` is a git blob
    // SHA-1, wrong algorithm AND wrong shape for the `sha256-…` SRI contract),
    // so we fetch each surviving file's bytes to compute a real SRI hash + true
    // byte size. This is an intentional N-read fan-out — the honest cost of
    // producing byte-identical `list_files` output across adapters. Ignored
    // files were filtered out ABOVE, so their bytes are never fetched.
    const entries = await Promise.all(
      visible.map(async (path): Promise<KitFileEntry> => {
        const bytes = await this.fetchFileBytes(kitId, path);
        return { path, size: bytes.length, hash: sriSha256(bytes), lastModified };
      }),
    );
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listComponents(params: {
    kitId: KitId;
    group?: string;
  }): Promise<import("./interface.js").ComponentEntry[]> {
    // getKit throws NotFoundError for an unknown kit, which propagates naturally
    // and keeps "kit missing" distinct from "kit present but no manifest yet".
    await this.getKit(params.kitId);

    // Fetch the compiled card index (D-D) from the kit's default branch. It is
    // absent until the M3-03 compiler writes it → a 404 (surfaced by readFile as
    // NotFoundError) maps to `undefined`, which selectComponents turns into []
    // (AC8). Other errors (auth, 5xx, oversize) propagate.
    //
    // `readFile` returns the rich `KitFileContent` shape (M1-14a-1a / DRO-540),
    // not a bare string. `.genie/manifest.json` is JSON (a textual MIME), so the
    // shared classifier decodes it to a utf-8 `content` string; a base64 result
    // is decoded defensively so `selectComponents` always parses real JSON text.
    let raw: string | undefined;
    try {
      const file = await this.readFile(params.kitId, MANIFEST_PATH);
      raw =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf-8")
          : file.content;
    } catch (e) {
      if (e instanceof NotFoundError) {
        raw = undefined;
      } else {
        throw e;
      }
    }

    return selectComponents(params.kitId, raw, params.group);
  }

  /** Fetch repo metadata, mapping a 404 to NotFoundError("Kit"). */
  private async getRepo(kitId: KitId): Promise<RepoResponse> {
    try {
      return await this.api<RepoResponse>("GET", this.repoPath(kitId));
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError("Kit", kitId);
      throw e;
    }
  }

  /**
   * Read the kit's committed `.genieignore` (default branch) into active
   * pattern lines. Absent file → no extra patterns (default-dir exclusion still
   * applies via buildIgnoreMatcher).
   */
  private async readIgnorePatterns(kitId: KitId): Promise<string[]> {
    try {
      const entry = await this.fetchContentEntry(kitId, ".genieignore");
      if (entry.type !== "file" || !entry.content) return [];
      const raw =
        entry.encoding === "base64"
          ? Buffer.from(entry.content, "base64").toString("utf-8")
          : entry.content;
      return parseGenieignore(raw);
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
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

  /**
   * GET a single contents entry, mapping a 404 to NotFoundError("File").
   * Encodes each path segment to handle spaces, #, ?, etc.
   */
  private async fetchContentEntry(kitId: KitId, path: string): Promise<ContentEntry> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    try {
      return await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
      );
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError("File", `${kitId}/${path}`);
      throw e;
    }
  }

  /** Fetch a file's raw bytes off the default branch (base64 or utf-8 payload). */
  private async fetchFileBytes(kitId: KitId, path: string): Promise<Buffer> {
    const entry = await this.fetchContentEntry(kitId, path);
    if (entry.type !== "file" || !entry.content) return Buffer.alloc(0);
    return entry.encoding === "base64"
      ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf-8");
  }

  async readFile(kitId: KitId, path: string): Promise<KitFileContent> {
    // Reject an unsafe kitId up front, mirroring LocalFs (AC1/AC-SEC). Each kit
    // is its own repo here so `""` cannot cross kits, but keeping the SAME guard
    // on both adapters is what prevents the rule from silently drifting.
    if (!isSafeKitId(kitId)) throw new NotFoundError("Kit", kitId);
    const entry = await this.fetchContentEntry(kitId, path);

    // Validate that this is a file, not a directory
    if (entry.type !== "file") {
      throw new NotFoundError("File", `${kitId}/${path}`);
    }

    if (entry.size && entry.size > MAX_FILE_BYTES) {
      throw new FileTooLargeError(path, entry.size);
    }

    // Validate that content is actually present
    if (!entry.content) {
      throw new Error(`File "${kitId}/${path}" returned no content from the git host API.`);
    }

    const bytes =
      entry.encoding === "base64"
        ? Buffer.from(entry.content, "base64")
        : Buffer.from(entry.content, "utf-8");
    // Fallback size check when entry.size was not provided by the API.
    if (bytes.length > MAX_FILE_BYTES) {
      throw new FileTooLargeError(path, bytes.length);
    }
    // Shared classifier decides utf-8 vs base64 + the MIME type — identical to
    // LocalFsKitStore, so a `read_file` result is byte-identical across adapters
    // (a binary blob on the git host comes back base64, text comes back utf-8).
    return classifyFileContent(path, bytes);
  }

  async deleteFile(kitId: KitId, path: string): Promise<{ existed: boolean }> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    // The contents-API DELETE needs the file's current blob SHA. A missing file
    // OR a missing kit (repo) both 404 → the idempotent "already absent" no-op,
    // matching LocalFs (which never pre-stats the kit). Deletes hit the DEFAULT
    // branch — the readable surface `readFile`/`listFiles` see — NOT a plan
    // branch (plan-branch edits are the openPlan/commitPlan path).
    let sha: string;
    try {
      const existing = await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
      );
      // A directory (contents-API array response) or any non-`file` entry
      // (submodule, symlink) is NOT a deletable file. LocalFs's `unlink` on a
      // directory throws a native EISDIR, which the `delete_files` tool maps to
      // `DeleteFailed`. GitHost must raise the SAME native-shaped error rather
      // than silently no-op'ing to `{ existed: false }` — otherwise an
      // authorized `deletes: ["adir"]` plan yields `DeleteFailed` on LocalFs but
      // a silent success on GitHost, breaking byte-identical cross-adapter
      // parity (RFC G-5). The `interface.ts` deleteFile contract already mandates
      // this ("a hard removal failure that is NOT 'already absent' … propagates
      // as the adapter's native error"). See DRO-568.
      if (Array.isArray(existing) || existing.type !== "file") {
        throw eisdirError(`${kitId}/${path}`);
      }
      sha = existing.sha ?? "";
    } catch (e) {
      if (e instanceof NotFoundError) return { existed: false };
      throw e;
    }
    await this.api<void>(
      "DELETE",
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
      { message: `kit: delete ${path}`, sha },
    );
    return { existed: true };
  }

  async writeFiles(kitId: KitId, ops: WriteOp[]): Promise<{ writtenPaths: string[] }> {
    // Writes land on the DEFAULT branch — the readable surface readFile/
    // listFiles/deleteFile see — NOT a plan branch (a git host has no
    // rename-transaction; the plan is the capability grant, resolved tool-side,
    // and openPlan/commitPlan are the separate plan-branch path). A git host
    // can't offer filesystem-atomic multi-file writes, so we honour the
    // all-or-nothing CONTRACT the way the host allows: capture each
    // destination's prior blob state, apply every write, and on any failure
    // unwind by restoring captured blobs / deleting files this call created.
    // Rollback failures are collected (never short-circuited) and surfaced as
    // RollbackIncompleteError — the same guarantee shape as LocalFs.

    // Resolve each op's bytes first (streaming a `sourcePath` off disk so a
    // large localPath upload never fully buffers beyond this base64 encode,
    // which the contents API requires anyway). A read failure here aborts
    // before any remote write — nothing has landed yet.
    const resolved: { path: string; contentB64: string }[] = [];
    for (const op of ops) {
      try {
        const bytes = "sourcePath" in op ? await readStreamToBuffer(op.sourcePath) : op.content;
        resolved.push({ path: op.path, contentB64: bytes.toString("base64") });
      } catch (error) {
        throw new WriteFailedError(op.path, describeGitError(error, "read failed"));
      }
    }

    // Snapshot prior state per path so we can restore on rollback:
    //   { existed: true, sha, contentB64 } — restore via PUT with this content.
    //   { existed: false }                 — created by us; delete on rollback.
    const priors: {
      path: string;
      encodedPath: string;
      existed: boolean;
      sha?: string;
      contentB64?: string;
    }[] = [];
    const committed: { path: string; encodedPath: string; sha: string }[] = [];

    try {
      for (const { path, contentB64 } of resolved) {
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        const prior = await this.getContentForWrite(kitId, encodedPath);
        priors.push({ path, encodedPath, ...prior });

        const body: Record<string, string> = {
          content: contentB64,
          message: `kit: write ${path}`,
        };
        if (prior.existed && prior.sha) body["sha"] = prior.sha;

        try {
          const res = await this.api<FileResponse>(
            prior.existed ? "PUT" : "POST",
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
            body,
          );
          committed.push({ path, encodedPath, sha: res.content.sha });
        } catch (error) {
          throw new WriteFailedError(path, describeGitError(error, "contents-API write failed"));
        }
      }
    } catch (error) {
      const rollbackFailures = await this.unwriteFiles(kitId, committed, priors);
      if (rollbackFailures.length > 0) {
        throw new RollbackIncompleteError(
          describeGitError(error, "commit failed"),
          rollbackFailures,
        );
      }
      throw error;
    }

    return { writtenPaths: ops.map((o) => o.path) };
  }

  /**
   * Fetch a path's current blob state on the default branch for a write:
   * `{ existed: true, sha, contentB64 }` if present (needed to update AND to
   * restore on rollback), `{ existed: false }` if absent (we'd be creating it).
   * A directory at the path is treated as "not a writable file" and surfaces as
   * absent — the subsequent write then fails and rolls back, matching LocalFs's
   * directory-target refusal.
   */
  private async getContentForWrite(
    kitId: KitId,
    encodedPath: string,
  ): Promise<{ existed: boolean; sha?: string; contentB64?: string }> {
    try {
      const existing = await this.api<ContentEntry>(
        "GET",
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${encodedPath}`,
      );
      if (Array.isArray(existing) || existing.type !== "file") {
        return { existed: false };
      }
      return {
        existed: true,
        sha: existing.sha ?? "",
        contentB64: existing.encoding === "base64" ? existing.content : undefined,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return { existed: false };
      throw error;
    }
  }

  /**
   * Unwind a partially-applied writeFiles batch. For each committed file: if it
   * pre-existed, PUT its captured content back; if we created it, DELETE it.
   * Every step is attempted even if an earlier one fails — failures are
   * collected and returned so the caller can raise RollbackIncompleteError
   * rather than mask an incomplete restore.
   */
  private async unwriteFiles(
    kitId: KitId,
    committed: { path: string; encodedPath: string; sha: string }[],
    priors: {
      path: string;
      encodedPath: string;
      existed: boolean;
      sha?: string;
      contentB64?: string;
    }[],
  ): Promise<string[]> {
    const failures: string[] = [];
    const priorByPath = new Map(priors.map((p) => [p.path, p]));
    // Undo in reverse commit order so a path committed twice (impossible today —
    // the tool rejects duplicates — but cheap insurance) restores oldest-last.
    for (const c of [...committed].reverse()) {
      const prior = priorByPath.get(c.path);
      try {
        if (prior?.existed && prior.contentB64 !== undefined) {
          // Restore the captured blob. Needs the CURRENT sha (what we just
          // wrote) as the update base.
          await this.api<FileResponse>(
            "PUT",
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${c.encodedPath}`,
            { content: prior.contentB64, message: `kit: rollback ${c.path}`, sha: c.sha },
          );
        } else {
          // We created it (or couldn't capture its content) — delete it.
          await this.api<void>(
            "DELETE",
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(kitId)}/contents/${c.encodedPath}`,
            { message: `kit: rollback delete ${c.path}`, sha: c.sha },
          );
        }
      } catch (error) {
        failures.push(
          `failed to roll back "${c.path}": ${describeGitError(error, "unknown error")}`,
        );
      }
    }
    return failures;
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
      const meta: KitMeta = {
        id: repo.name,
        name,
        type: KIT_TYPE,
        createdAt: repo.created_at,
      };
      await this.writeKitMeta(meta);
      return meta;
    } catch (err: unknown) {
      // Check if it's a 409 Conflict indicating repo already exists
      if (err instanceof GitHostApiError && err.status === 409) {
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

  async commitPlan(kitId: KitId, planId: PlanId, ops: FileOp[]): Promise<void> {
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

  private async applyOps(kitId: KitId, branch: string, ops: FileOp[]): Promise<void> {
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
        await this.api<RepoResponse>("POST", `/orgs/${encodeURIComponent(this.owner)}/repos`, {
          name: this.metaRepo,
          auto_init: true,
          private: true,
        });
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
        return JSON.parse(Buffer.from(file.content, "base64").toString("utf-8")) as ProjectMeta;
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
    const content = Buffer.from(JSON.stringify(meta, null, 2)).toString("base64");
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
    const meta = (await this.getProject(projectId)) as ProjectMeta & { screens?: string[] };
    const screens = meta.screens ?? [];
    screens.push(screenRef);
    await this.updateProjectMeta(projectId, { ...meta, screens });
  }

  private async updateProjectMeta(projectId: ProjectId, meta: object): Promise<void> {
    const file = await this.api<ContentEntry>(
      "GET",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
    );
    const sha = (file as unknown as { sha: string }).sha;
    const content = Buffer.from(JSON.stringify(meta, null, 2)).toString("base64");
    await this.api<FileResponse>(
      "PUT",
      `/repos/${encodeURIComponent(this.owner)}/${this.metaRepo}/contents/${this.projectPath(projectId)}`,
      { content, message: `project: update ${projectId}`, sha },
    );
  }
}
