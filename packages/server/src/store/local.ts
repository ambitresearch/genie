/**
 * LocalFsStore — solo-dev adapter.
 *
 * AC3: Stores kits under `${GENIE_HOME ?? ~/.genie}/kits/<kitId>/`
 * and projects under `${GENIE_HOME ?? ~/.genie}/projects/<projectId>/`.
 * Each plan is a temp staging directory.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  ComponentEntry,
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
  NotFoundError,
  RollbackIncompleteError,
  WriteFailedError,
} from "./interface.js";
import {
  buildIgnoreMatcher,
  classifyFileContent,
  isSafeKitId,
  parseGenieignore,
  type IgnoreMatcher,
} from "./kit-files.js";
import { serializeEmptyManifest } from "./empty-manifest.js";
import { MANIFEST_PATH, selectComponents } from "./manifest.js";
import { loadViewerAssets } from "./viewer-assets.js";

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
    throw new Error(`Path traversal denied: "${userPath}" resolves outside the allowed directory.`);
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
    // Size comes from stat; the SRI hash is STREAMED (createReadStream piped
    // through the hash) rather than read into a full buffer, so peak hashing
    // memory is bounded by the stream's highWaterMark (~64 KiB), not the
    // largest file's size (AC2, DRO-581). The digest is byte-identical to the
    // prior `sriSha256(await readFile(...))` — same bytes, same hash, same
    // order — which the streamed-vs-full-buffer regression test pins down.
    const [stats, hash] = await Promise.all([stat(absolutePath), hashFileStream(absolutePath)]);
    files.push({
      path: relativePath,
      size: stats.size,
      hash,
      lastModified: stats.mtime.toISOString(),
    });
  }
  return files;
}

/**
 * Compute a file's `sha256-<base64>` SRI hash by STREAMING it through the hash
 * in chunks, so peak memory stays bounded by the read-stream buffer (default
 * highWaterMark, ~64 KiB) rather than the largest single file's size (AC2).
 *
 * The digest is byte-identical to hashing the full buffer with
 * `createHash("sha256").update(bytes)` (i.e. the shared `sriSha256(bytes)`):
 * piping the stream feeds the SAME bytes to the SAME hash in the SAME order, so
 * a >64 KiB multi-chunk file, an empty file (zero chunks), and a binary file
 * all produce the identical digest — pinned by the streamed-vs-full-buffer
 * regression test. `pipeline` surfaces a mid-read stream error as a rejection
 * instead of leaving a dangling read stream. RFC G-5's byte-identical-across-
 * adapters contract is preserved because the git-host adapter still calls
 * `sriSha256` over the same bytes, and both forms yield the same string.
 */
async function hashFileStream(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolutePath), hash);
  return `sha256-${hash.digest("base64")}`;
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

// ─── Atomic write transaction (LocalFsKitStore.writeFiles) ───────────────────
//
// Lifted from the shipped fs-native `write_files` tool (M1-08) when its
// transactional writer moved behind the KitStore seam (DRO-565). The semantics
// are byte-identical to the pre-store tool — only the destination base changed
// from the plan's `localDir` to the kit dir (the readable surface list_files/
// read_file/delete_file already target). Every Copilot review finding baked
// into the original (staging inside the destination tree for same-filesystem
// renames, directory-target refusal, collected rollback failures →
// RollbackIncompleteError) is preserved.

/** One file staged under the per-call temp dir and ready to commit. */
interface StagedFile {
  /** Kit-relative path, for error messages. */
  publicPath: string;
  /** Absolute destination path under the kit dir. */
  destPath: string;
  /** Absolute path of the staged (new) content, inside the call's temp dir. */
  stagedPath: string;
}

/**
 * Stage every op's new content under a fresh `<kitDir>/.genie-tmp/<rand>/`
 * (streaming `sourcePath` ops through a hash so a large file is never fully
 * buffered), then commit via rename-to-temp + rename-back. Nothing under
 * `kitDir` is touched until every op has staged successfully. Staging inside
 * `kitDir` (not `os.tmpdir()`) is load-bearing: `rename()` is only atomic
 * within one filesystem, and a kit dir + `/tmp` are commonly different mounts.
 */
async function stageAndCommit(kitDir: string, ops: WriteOp[]): Promise<{ writtenPaths: string[] }> {
  const genieTmpRoot = join(kitDir, ".genie-tmp");
  await mkdir(genieTmpRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(genieTmpRoot, `${randomUUID()}-`));
  const backupRoot = join(stagingRoot, "backup");

  try {
    // Phase 1 — stage new content. Real destinations are untouched so far.
    const staged: StagedFile[] = [];
    for (const op of ops) {
      // Defense-in-depth traversal guard: the tool already rejects `..`/absolute
      // paths, but the store must not trust that blindly (a future direct caller
      // could bypass the tool). safePath throws if `op.path` escapes kitDir.
      const destPath = safePath(kitDir, op.path);
      const stagedPath = join(stagingRoot, `${staged.length}`);

      if ("sourcePath" in op) {
        await streamCopy(op.sourcePath, stagedPath, op.path);
      } else {
        await writeStaged(stagedPath, op.content, op.path);
      }

      staged.push({ publicPath: op.path, destPath, stagedPath });
    }

    await commitStaged(staged, backupRoot, kitDir);

    return { writtenPaths: ops.map((o) => o.path) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Commit every staged file via rename-to-temp + rename-back.
 * 1. Ensure every destination's parent dir exists.
 * 2. Back up (rename away) any destination that already exists.
 * 3. Rename each staged file into its real destination.
 * 4. On any failure in step 3: remove whatever committed, restore every backup,
 *    then throw — collecting (never short-circuiting on) rollback failures so a
 *    second failure surfaces as RollbackIncompleteError rather than masking the
 *    incomplete restore.
 */
async function commitStaged(
  staged: StagedFile[],
  backupRoot: string,
  kitDir: string,
): Promise<void> {
  await mkdir(backupRoot, { recursive: true });

  for (const { destPath, publicPath } of staged) {
    try {
      await mkdir(dirname(destPath), { recursive: true });
    } catch (error) {
      throw new WriteFailedError(
        publicPath,
        describeError(error, "failed to create destination directory"),
      );
    }
  }

  const backedUp: { destPath: string; backupPath: string }[] = [];
  const committed: string[] = [];

  try {
    for (const { destPath, publicPath } of staged) {
      const backupPath = join(backupRoot, `${backedUp.length}`);
      const hadExisting = await tryRenameIfExists(destPath, backupPath, publicPath);
      if (hadExisting) backedUp.push({ destPath, backupPath });
    }

    for (const { destPath, stagedPath, publicPath } of staged) {
      try {
        await rename(stagedPath, destPath);
      } catch (error) {
        throw new WriteFailedError(
          relativeOrAbsolute(kitDir, destPath, publicPath),
          describeError(error, "rename failed"),
        );
      }
      committed.push(destPath);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const destPath of committed) {
      try {
        await rm(destPath, { force: true });
      } catch (rmError) {
        rollbackFailures.push(
          `failed to remove committed file "${relativeOrAbsolute(kitDir, destPath, destPath)}": ` +
            describeError(rmError, "unknown error"),
        );
      }
    }
    for (const { destPath, backupPath } of backedUp) {
      try {
        await rename(backupPath, destPath);
      } catch (restoreError) {
        rollbackFailures.push(
          `failed to restore backup for "${relativeOrAbsolute(kitDir, destPath, destPath)}": ` +
            describeError(restoreError, "unknown error"),
        );
      }
    }

    if (rollbackFailures.length > 0) {
      throw new RollbackIncompleteError(describeError(error, "commit failed"), rollbackFailures);
    }
    throw error;
  }
}

/**
 * Rename `destPath` to `backupPath` if it exists. Returns whether a backup was
 * made (`false` when `destPath` didn't exist). Refuses (WriteFailedError,
 * triggering the normal rollback) when `destPath` is a DIRECTORY: `write_files`
 * writes files, never replaces a directory, and letting a directory move into
 * the backup slot then be deleted by the caller's cleanup would silently
 * destroy it (a Copilot review finding on PR #106).
 */
async function tryRenameIfExists(
  destPath: string,
  backupPath: string,
  publicPath: string,
): Promise<boolean> {
  const existing = await statIfExists(destPath);
  if (existing?.isDirectory()) {
    throw new WriteFailedError(
      publicPath,
      `destination "${destPath}" already exists and is a directory, not a file`,
    );
  }

  try {
    await rename(destPath, backupPath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw new WriteFailedError(publicPath, describeError(error, "failed to back up existing file"));
  }
}

/** `stat`, or `undefined` if the path doesn't exist. Other errors propagate. */
async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function relativeOrAbsolute(baseDir: string, destPath: string, fallback: string): string {
  const rel = relative(baseDir, destPath);
  return rel.length > 0 ? rel : fallback;
}

async function writeStaged(stagedPath: string, content: Buffer, publicPath: string): Promise<void> {
  try {
    await writeFile(stagedPath, content);
  } catch (error) {
    throw new WriteFailedError(publicPath, describeError(error, "write failed"));
  }
}

/**
 * Stream `sourcePath` into `stagedPath` through a SHA-256 pass-through, so a
 * `localPath`-sourced write never loads a full file into memory regardless of
 * size. The hash isn't surfaced (no AC calls for it) but proves the data
 * genuinely streamed end-to-end rather than being buffered.
 */
async function streamCopy(
  sourcePath: string,
  stagedPath: string,
  publicPath: string,
): Promise<void> {
  try {
    const hash = createHash("sha256");
    const source = createReadStream(sourcePath);
    const dest = createWriteStream(stagedPath);
    source.on("data", (chunk) => hash.update(chunk));
    await pipeline(source, dest);
  } catch (error) {
    throw new WriteFailedError(publicPath, describeError(error, "read failed"));
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
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

  /**
   * Resolve a kitId to its on-disk directory for the READ verbs
   * (`listFiles`/`readFile`), rejecting unsafe ids BEFORE the join (AC-SEC,
   * DRO-581). This is the store-layer half of the shared `isSafeKitId` rule and
   * the defense-in-depth guard behind each tool's own kitId check: a
   * programmatic caller that bypasses the tool must not be able to pass `""`
   * (whose `join(baseDir, "")` is the kits ROOT — letting a crafted `path` like
   * `other-kit/secret.txt` read a SIBLING kit), `.`/`..`, or a separator.
   *
   * An unsafe id names no valid kit, so it surfaces as the SAME `NotFoundError`
   * a genuinely-missing kit would — this never leaks a sibling's bytes and adds
   * no new error type to the `KitStore` contract (AC4). The write/plan verbs
   * (`createKit`/`deleteFile`/`openPlan`) keep using `kitDir` directly: their
   * ids are server-minted or already plan-gated, and their behavior is
   * unchanged.
   */
  private safeKitDir(kitId: KitId): string {
    if (!isSafeKitId(kitId)) throw new NotFoundError("Kit", kitId);
    return this.kitDir(kitId);
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
      const meta = await readMeta<KitMetaFile>(this.kitMetaPath(entry.name));
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
    const dir = this.safeKitDir(kitId);
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

  async listComponents(params: { kitId: KitId; group?: string }): Promise<ComponentEntry[]> {
    const { kitId, group } = params;

    // Validate kit exists (throws NotFoundError) before touching the manifest,
    // so "kit missing" and "kit present but no components yet" stay distinct.
    await this.getKit(kitId);

    // The compiled card index (D-D). Absent until the M3-03 compiler writes it
    // (or on a brand-new kit) → selectComponents maps `undefined` to [] (AC8).
    // A path-traversal-safe join is unnecessary here: MANIFEST_PATH is a fixed
    // constant, not user input.
    const manifestFile = join(this.kitDir(kitId), MANIFEST_PATH);
    let raw: string | undefined;
    try {
      raw = await readFile(manifestFile, "utf-8");
    } catch (err) {
      // Only a genuinely-absent manifest (ENOENT) means "no components yet" →
      // undefined, which selectComponents maps to [] (AC8). Any other IO error
      // (EACCES, EISDIR, transient failures) is a real operability problem and
      // must propagate rather than be masked as a silently-empty listing. This
      // mirrors GitHostStore, which only maps NotFoundError (404) to undefined.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        raw = undefined;
      } else {
        throw err;
      }
    }

    return selectComponents(kitId, raw, group);
  }

  async readFile(kitId: KitId, path: string): Promise<KitFileContent> {
    // Reject an unsafe kitId (incl. "" → the kits root, which would let `path`
    // read across sibling kits) BEFORE resolving the kit dir (AC-SEC).
    const kitDir = this.safeKitDir(kitId);
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

  async writeFiles(kitId: KitId, ops: WriteOp[]): Promise<{ writtenPaths: string[] }> {
    // Destination = the kit dir (the readable surface list_files/read_file see),
    // matching how deleteFile targets the same dir. The `write_files` tool has
    // already glob-gated every path, checked the byte cap, streamed-source
    // containment, and rejected duplicates — so this only performs the atomic
    // commit. `ensureDir` (not getKit) because a brand-new kit dir is a valid
    // write target, and a `sourcePath` op streams rather than buffering.
    const kitDir = this.kitDir(kitId);
    await ensureDir(kitDir);
    return stageAndCommit(kitDir, ops);
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

    // DRO-764 AC1 — scaffold the viewer's static shell into the new kit root
    // so file:// / localhost-Vite / ui://genie/grid all have something to
    // render immediately, with zero manual copying. `dir` was just created
    // above and is not yet visible to any other caller (the `.kit.json`
    // exclusive-write above is the only publication point `getKit`/`listKits`
    // key off), so plain per-file writes are safe here — no concurrent writer
    // can be racing this directory. `loadViewerAssets` prefers the shell
    // bundled into the server package and degrades to `[]` (never throws) only
    // when neither that payload nor the optional viewer package is available.
    const viewerAssets = await loadViewerAssets();
    await Promise.all(viewerAssets.map((asset) => writeFile(join(dir, asset.path), asset.content)));

    // DRO-764 AC3 — seed an empty `.genie/manifest.json` so the file:// /
    // localhost-Vite vehicles' `fetch(".genie/manifest.json")` resolves
    // immediately to a valid, empty manifest (→ the `.ds-empty` state)
    // instead of rejecting (→ the `.ds-error` state) — see
    // `empty-manifest.ts`'s header for why a missing `file://` resource is a
    // REJECTED fetch, not a 404 Response. The M3-03 compiler transparently
    // overwrites this the moment any component is actually added.
    await mkdir(join(dir, ".genie"), { recursive: true });
    await writeFile(join(dir, MANIFEST_PATH), serializeEmptyManifest(name), "utf-8");

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

  async commitPlan(kitId: KitId, planId: PlanId, ops: FileOp[]): Promise<void> {
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
      const meta = await readMeta<ProjectMetaFile>(this.metaPath(entry.name));
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
