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
  hasRequiredKitMetaFields,
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

/**
 * The single-component limit, counted in UTF-16 code units.
 *
 * Filesystems disagree about the unit they cap. ext4, XFS and btrfs count
 * BYTES; NTFS counts UTF-16 code units; APFS is Unicode-oriented and accepts
 * names well past 255 bytes. Counting units is the conservative reading of that
 * disagreement, because a code point never costs fewer UTF-8 bytes than UTF-16
 * units (BMP 1-3 bytes / 1 unit, astral 4 / 2). An id above this many units is
 * therefore also above 255 bytes, so no cap named here admits it.
 *
 * Counting bytes instead over-reports on the two Unicode-oriented filesystems,
 * and over-reporting is the unsafe direction: it is what turns a name the
 * filesystem would have accepted into a reported absence.
 */
const NAME_MAX_UNITS = 255;

/** The characters Win32 reserves in a path component. */
const WIN32_RESERVED = /[<>:"|?*]/u;

/**
 * A name the filesystem cannot represent — which is a stronger statement than
 * "not there right now": no file with this name can ever exist here, so it is
 * absent by definition rather than by accident.
 *
 * The error code alone cannot support that claim, because both codes have a
 * second cause that has nothing to do with `id`:
 *
 *   - `ENAMETOOLONG` is raised for NAME_MAX (one component too long — the id,
 *     measured against {@link NAME_MAX_UNITS}) and for PATH_MAX (the whole
 *     pathname too long — dominated by the configured root). A deep root would
 *     otherwise make every lookup answer "absent", including for ids as short
 *     as `ui`.
 *   - `EINVAL` is the Win32 answer for its reserved characters (`<>:"|?*`), but
 *     is also raised by unrelated argument faults.
 *
 * So the id is inspected directly, and only a fault it can actually account for
 * is treated as absence. Anything else stays a fault. That asymmetry is the
 * point of #252: a configuration or platform problem reported as `kitNotFound`
 * is a problem no caller can diagnose, whereas an id no filesystem would accept
 * genuinely names nothing.
 *
 * Kept separate from {@link isMissingPathError} on purpose: that predicate
 * describes a path that is absent, this one an id that is unusable, and only the
 * second is an argument about the caller's input.
 */
function isUnrepresentableNameError(error: unknown, id: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  if (error.code === "ENAMETOOLONG") return id.length > NAME_MAX_UNITS;
  if (error.code === "EINVAL") return WIN32_RESERVED.test(id);
  return false;
}

/**
 * Strip the server's filesystem layout out of a genuine fs fault.
 *
 * Node builds `${code}: ${description}, ${syscall} '${path}'` and copies the
 * ABSOLUTE path onto `.path`/`.dest`. Both cross the MCP boundary verbatim, so
 * a caller who merely asked for a kit learns where the server keeps them.
 *
 * The fault itself still has to surface — #252: an unreadable kit must stay
 * distinguishable from a missing one, or `plan` reports `kitNotFound` for a kit
 * that exists. So the `${code}: ${description}` head is preserved (that is what
 * `plan.test.ts` matches on) and only the path-bearing tail is removed.
 */
function withoutPath(error: unknown): unknown {
  if (!(error instanceof Error) || !("code" in error)) return error;

  const errno = error as NodeJS.ErrnoException;
  const syscall = errno.syscall ?? "";
  // Node's exact separator, so a message that does not have this shape (a
  // hand-built error in a test double, say) is returned untouched.
  const marker = syscall ? `, ${syscall} '` : "";
  const cut = marker ? errno.message.indexOf(marker) : -1;
  if (cut === -1) return error;

  const redacted: NodeJS.ErrnoException = new Error(errno.message.slice(0, cut));
  redacted.code = errno.code;
  redacted.errno = errno.errno;
  redacted.syscall = errno.syscall;
  return redacted;
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

/**
 * Read and parse a JSON metadata file for a DIRECTLY NAMED resource.
 *
 * Returns `undefined` when the file is absent — either because nothing is there
 * ({@link isMissingPathError}) or because the name itself cannot exist on this
 * filesystem ({@link isUnrepresentableNameError}). Every other fault — EACCES,
 * EISDIR, EIO, an unparseable body — is re-thrown, with the server's absolute
 * path stripped out of it ({@link withoutPath}).
 *
 * That distinction matters because each direct-lookup caller below turns
 * `undefined` into `NotFoundError`. The previous bare `catch` swallowed *every*
 * error, so an unreadable kit was indistinguishable from a missing one: `plan`
 * would report `kitNotFound` for a kit that exists but could not be read, and
 * its narrowed `NotFoundError` catch could never see the real fault (#252).
 * Treating an unrepresentable NAME as absent does not reopen that: it is an
 * argument about the caller's id, not about whether a real kit could be read.
 *
 * Scan loops want the opposite bias and use {@link readMetaIfReadable}.
 */
async function readMeta<T>(filePath: string, id: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingPathError(error) || isUnrepresentableNameError(error, id)) return undefined;
    throw withoutPath(error);
  }
}

/**
 * Read and parse a JSON metadata file while ENUMERATING a directory.
 *
 * Tolerates any unreadable entry. `listKits`/`listProjects` walk a root that may
 * legitimately hold foreign, partially-written, or permission-restricted
 * neighbours, and one bad entry must not fail the whole listing — so this keeps
 * the historic swallow-everything behaviour exactly where it is wanted.
 */
async function readMetaIfReadable<T>(filePath: string, id: string): Promise<T | undefined> {
  try {
    return await readMeta<T>(filePath, id);
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
   * (whose `join(baseDir, "")` is the kits ROOT), `.`/`..`, or a separator.
   * BOTH gated verbs would be exposed, by different routes: `readFile` would
   * turn a crafted `path` like `other-kit/secret.txt` into a SIBLING kit's
   * bytes, while `listFiles` — which takes no `path` at all — would recursively
   * enumerate every kit under that root (and under `..`, its parent).
   *
   * An unsafe id names no valid kit, so it surfaces as the SAME `NotFoundError`
   * a genuinely-missing kit would — this never leaks a sibling's bytes and adds
   * no new error type to the `KitStore` contract (AC4). `createKit` now applies
   * the same rule inline rather than trusting `kitDir` (see the guard there):
   * its `kitId?` parameter is caller-supplied, and unlike the verbs below it
   * CREATES the container, so an unsafe id there writes a new directory at a
   * caller-chosen path instead of merely failing to resolve one. Every other
   * write/plan verb keeps resolving through the UNGATED helpers and is
   * unchanged: `deleteFile`/`writeFiles` via `kitDir`, and
   * `openPlan`/`commitPlan`/`closePlan` via `planDir`. `safeKitDir` cannot
   * SUPPLY a plan destination — it fuses the check with a `baseDir`-rooted
   * resolve, and plan paths root at `plansDir` — but that binds only its
   * RESOLUTION half; the check half is a root-independent predicate, so a plan
   * verb wanting the same rule calls `isSafeKitId` directly. None does today:
   * those ids are server-minted or already plan-gated. Treat the names as
   * EXAMPLES, not a census: grep `this.kitDir(`/`this.planDir(` for current
   * membership. This sentence has already shipped wrong twice — once reading
   * as exhaustive while naming two of the five, once claiming `safeKitDir`
   * could not gate the plan verbs at all.
   *
   * NOT every read verb routes through here, and the omission is deliberate.
   * `getKit` and `listComponents` both resolve through the UNCHECKED `kitDir`,
   * so neither is contained at this layer: `getKit` validates EXISTENCE and
   * TYPE at whatever location it resolves (a `.kit.json` parsing as `KIT_TYPE`),
   * never that the location is inside the kits root. `listComponents` resolves
   * through that SAME `kitDir(kitId)` (its manifest sits under it), so it
   * reaches no location `getKit` did not already admit — an absence of
   * INDEPENDENT exposure, not containment. The invariant is the shared
   * `kitDir` argument, NOT the `getKit` call that happens to precede it.
   *
   * The decision is recorded at `listKits`: the invariant is about what this
   * store PUBLISHES, and a caller that constructs an unsafe id is stopped at
   * the tool boundary, where `get_kit` and `list_components` both refine on
   * `isSafeKitId`. Read that comment before "fixing" this. The short form: what
   * separates the two sets is the BREADTH of what a verb can reach once the
   * directory resolves — NOT whether it takes a `path`. `listFiles` takes none
   * and is gated anyway, because it walks the entire tree. `getKit` reaches one
   * fixed filename that must parse as `KIT_TYPE` meta or it throws, and
   * `listComponents` reaches a second fixed path under that same directory.
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
      // A POSIX directory name may contain `\`, which `isSafeKitId` — the
      // kit-id safety rule every kit verb that applies it gates on (`validate`
      // applies none, and `create_project` records `kitBindings[].kitId` without
      // resolving it) — rejects. What that rule refuses is stated once, in its
      // docblock in kit-files.ts; restating it here is how the two drift apart.
      // Reporting the directory name (below) would therefore publish an id that
      // read_file/list_files/plan/write_files/bind_kit/conjure_screen all
      // refuse. Skipping it here keeps the promise `list_kits` makes: the ids
      // it hands out are valid input to the tools that consume them.
      //
      // Filtered at the LISTING, not by gating getKit: the invariant is about
      // what this store PUBLISHES. A caller that constructs such an id itself
      // is still stopped at the tool boundary. GitHostKitStore.listKits carries
      // the same filter: the clause is adapter-neutral, so enforcing it here
      // alone would leave the shared contract passing vacuously there.
      if (!isSafeKitId(entry.name)) continue;
      const meta = await readMetaIfReadable<KitMetaFile>(this.kitMetaPath(entry.name), entry.name);
      // Same publishing invariant as the id filter above, applied to the SHAPE
      // rather than the name. `readMeta` is `JSON.parse(...) as KitMetaFile` —
      // an erased cast — so a .kit.json that parses but omits `name` or
      // `createdAt` yields `undefined` for a field `KitMeta` declares required,
      // and this adapter has no other source for either. Publishing it makes
      // `list_kits` emit a `structuredContent` the MCP SDK rejects against the
      // tool's own outputSchema, which fails the WHOLE response: every healthy
      // kit disappears too, and the error names an array index with no kit id.
      //
      // `readMetaIfReadable`'s tolerance only catches bytes that fail to PARSE.
      // Valid JSON with missing fields sails through it — so the "one bad entry
      // must not fail the whole listing" promise it documents was kept for the
      // rarer fault and broken for the commoner one. This closes that gap.
      if (meta?.type === KIT_TYPE && hasRequiredKitMetaFields(meta)) {
        kits.push({
          // The DIRECTORY name, not `meta.id`. The directory is what getKit
          // routes on, so reporting the embedded id here can hand out an id
          // that cannot be fetched back. Mirrors GitHostKitStore, which treats
          // the repo name as authoritative and discards .kit.json's `id`.
          id: entry.name,
          name: meta.name,
          type: KIT_TYPE,
          createdAt: meta.createdAt,
        });
      }
    }
    return kits;
  }

  async getKit(kitId: KitId): Promise<KitMeta> {
    const meta = await readMeta<KitMetaFile>(this.kitMetaPath(kitId), kitId);
    // `!hasRequiredKitMetaFields` is NOT redundant with the listKits filter:
    // that one governs what this store PUBLISHES, this one governs what it
    // SERVES, and a caller can reach getKit with an id listKits never emitted.
    // Refusing here keeps visible ⟺ usable pointing both ways — a shape this
    // adapter declines to list is also one it declines to serve.
    //
    // NotFoundError, not a shape-specific error: this adapter's only source for
    // `name`/`createdAt` IS .kit.json, so an incomplete file means there is no
    // kit here to describe. Contrast GitHostKitStore, which can fall back to
    // host-authoritative repo metadata and therefore still serves the kit.
    if (!meta || meta.type !== KIT_TYPE || !hasRequiredKitMetaFields(meta)) {
      throw new NotFoundError("Kit", kitId);
    }
    return {
      // The lookup key, not `meta.id` — see listKits. Returning the embedded
      // id here would make `getKit(x).id !== x` for a desynchronised kit, so a
      // caller round-tripping the result would query an id that resolves to
      // nothing.
      id: kitId,
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
    // `createKit(name, kitId?)` is public on `KitStore`, so this id is
    // caller-supplied — the "server-minted" assumption holds for the tool layer
    // (`create_kit` mints via `buildKitId`) but not for the contract. Reject
    // BEFORE the `kitDir` join below, which is the UNGATED helper. Two distinct
    // consequences, both closed by the one guard: an unsafe id creates a real
    // kit that `listKits` then filters out — a successful creation nothing can
    // discover — and, since `join` NORMALIZES `..` rather than rejecting it, an
    // id of `..` would resolve the new directory outside the kits root.
    //
    // Same `NotFoundError` every other `isSafeKitId` rejection raises, in BOTH
    // adapters: an unsafe id names no valid kit, and AC4 keeps new error types
    // out of the `KitStore` contract. Deliberately no site count here — an
    // earlier version said "`git-host.ts` twice" and this PR then added a third.
    //
    // Both adapters apply the predicate BEFORE creating anything, and neither
    // guard is redundant. Do NOT justify one by the other's backend: an earlier
    // version claimed GitHost "already propagates the host's 4xx" for such a
    // name. It does not — the host ACCEPTED `unsafe\kit`, the POST succeeded,
    // and only the subsequent `.kit.json` write 404'd, leaving an orphan repo.
    // `git-host.ts` needs its own up-front guard for exactly the reason this
    // one exists. Error contract pinned in `test/store-conformance.test.ts`.
    if (!isSafeKitId(id)) throw new NotFoundError("Kit", id);
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

  // `meta.id` here is NOT the routing key, and unlike `listKits`/`getKit` above
  // it has not been fixed. That is a deferral, not a judgement that it is
  // correct — do not read this comment as blessing the current behaviour.
  //
  // The defect is the same one the kit sites just fixed, and BOTH project
  // adapters have it: each routes on a container key — the directory holding
  // `.project.json` here, the `projects/<projectId>.json` filename in
  // `GitHostProjectStore` — while reporting the `id` embedded in that file's
  // body. Let the two drift and `listProjects` hands out an id `getProject`
  // cannot resolve, exactly as `listKits` did for kits.
  //
  // What differs is the SHAPE of the fix, which is why it is not in that
  // change. The kit adapters DISAGREED: GitHostKitStore already reported the
  // routing key and discarded `.kit.json`'s embedded id, so LocalFs was
  // demonstrably wrong against a shipped reference and could be corrected
  // alone. The project adapters agree — in the defect — so there is no
  // reference to correct toward. Fixing it means moving both adapters together
  // plus a shared `projectStoreContract` pin, and moving only this one would
  // convert a latent shared bug into a live parity break.
  async listProjects(): Promise<ProjectMeta[]> {
    await ensureDir(this.baseDir);
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const projects: ProjectMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMetaIfReadable<ProjectMetaFile>(this.metaPath(entry.name), entry.name);
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
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId), projectId);
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
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId), projectId);
    if (!meta) throw new NotFoundError("Project", projectId);
    await rm(this.projectDir(projectId), { recursive: true, force: true });
  }

  /**
   * Bind a kit to a project. Throws NotFoundError if the project is missing.
   *
   * ⚠️ This is NOT the `bindKit` the `bind_kit` tool invokes. That tool depends
   * on the narrow `ProjectBindKitStore` port in `src/tools/bind_kit.ts`, whose
   * `bindKit` takes a single args object and resolves to a `ProjectSummary`;
   * the unrelated `ProjectStore` *class* in `src/tools/create_project.ts`
   * satisfies that port structurally. Tell them apart by signature — this one
   * takes `(projectId, kitId)` and returns `void`. See the ⚠️ NAME COLLISION
   * table in `src/store/interface.ts` for the full disambiguation.
   *
   * Kit existence is deliberately not checked *here*. That is a property of the
   * `ProjectStore` interface this class implements; whether `bind_kit` rejects
   * an absent kit is decided on the tool's own path, not on this one. So do not
   * conclude from this method that `bind_kit` accepts a nonexistent kit, and do
   * not "fix" it by adding a check. This note sits on the implementation
   * because that is where a search for `bindKit` lands, not only on the
   * interface.
   */
  async bindKit(projectId: ProjectId, kitId: KitId): Promise<void> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId), projectId);
    if (!meta) throw new NotFoundError("Project", projectId);
    meta.kitId = kitId;
    await writeFile(this.metaPath(projectId), JSON.stringify(meta, null, 2));
  }

  async recordScreen(projectId: ProjectId, screenRef: string): Promise<void> {
    const meta = await readMeta<ProjectMetaFile>(this.metaPath(projectId), projectId);
    if (!meta) throw new NotFoundError("Project", projectId);
    meta.screens.push(screenRef);
    await writeFile(this.metaPath(projectId), JSON.stringify(meta, null, 2));
  }
}
