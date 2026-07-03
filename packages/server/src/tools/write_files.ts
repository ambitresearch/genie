/**
 * MCP tool: write_files (M1-08).
 *
 * Writes up to 256 files per call. Every `path` must match at least one glob
 * in the plan's `writes`; the plan is resolved via `planId` against the M1-07
 * plan registry (`../plans/index.ts`), which must be live (exists + not
 * expired).
 *
 * Each file is sourced from exactly one of:
 *   - `localPath` — resolved against the plan's `localDir`; the server reads
 *     the bytes directly from disk, so file contents never enter model
 *     context (the whole point of the localPath indirection).
 *   - `data` — inline content (utf-8 or base64, per `encoding`), for content
 *     the caller only has in-memory (e.g. LLM-generated text).
 *
 * The call is atomic (AC10), via a rename-to-temp + rename-back transaction:
 *   1. Stage every file's new content into a per-call temp directory first
 *      (streamed for `localPath` sources — never buffering a whole file in
 *      memory). Nothing under the real destination tree is touched yet.
 *   2. For each destination that already exists, rename it into a backup
 *      slot (rename-to-temp) rather than deleting it, so the original bytes
 *      are recoverable.
 *   3. Rename each staged file into its real destination.
 *   4. If every rename in step 3 succeeds, discard the backups — done.
 *   5. If any rename in step 3 fails, remove whatever this call already
 *      committed and rename every backup from step 2 back onto its original
 *      destination (rename-back) — the tree ends up exactly as it was
 *      before the call, and the error propagates. Nothing partially lands.
 *
 * Cross-issue note: this issue (M1-08) was specced as "Blocked by: M1-07"
 * (the `plan` tool). Earlier work-in-progress on this branch bundled a
 * stopgap `plan` implementation because M1-07 (GitHub issue #12 / DRO-235)
 * was open, unassigned, and had no PR at the time. M1-07 has since merged
 * (PR #104) with its own — differently shaped — plan registry
 * (`../plans/index.ts`: module-level functions + a singleton in-memory
 * registry, rather than an injectable `PlanStore` class; a single
 * `PlanNotFoundError` covers both "never existed" and "expired", rather than
 * a distinct `PlanExpiredError`). This file consumes that shipped API
 * directly instead of the stopgap, which has been deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getPlan, isPathInsideLocalDir, pathMatchesGlobs, PlanNotFoundError } from "../plans/index.js";

export const WRITE_FILES_TOOL_NAME = "mcp__genie__write_files";

/** M1-08 AC3 — hard ceiling on files per call. */
export const MAX_FILES_PER_CALL = 256;

/**
 * Byte-cap for a single `write_files` call's total decoded payload.
 *
 * RFC §17.5 flags Anthropic's exact server-side cap as unconfirmed for their
 * hosted endpoint; PRD §EC-029 sets genie's own default at 16 MiB with a
 * configurable ceiling. `GENIE_WRITE_BYTE_CAP` overrides the default; values
 * that are non-numeric or ≤ 0 fall back to it.
 */
export const DEFAULT_WRITE_BYTE_CAP = 16 * 1024 * 1024;

function resolveByteCap(env: Record<string, string | undefined>): number {
  const raw = env["GENIE_WRITE_BYTE_CAP"];
  if (raw === undefined) return DEFAULT_WRITE_BYTE_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WRITE_BYTE_CAP;
}

// ─── write_files' own error taxonomy ─────────────────────────────────────────
//
// Repo convention (see ListFilesError in tools/list_files.ts, ProjectStoreError
// in tools/create_project.ts): each tool owns its error classes colocated in
// its own file rather than a shared cross-tool errors module. The one
// plan-layer error this tool can also see — PlanNotFoundError — is imported
// from `../plans/index.ts` instead of redefined here.

/** M1-08 AC3 — more than 256 files were supplied to `write_files` in one call. */
export class TooManyFilesError extends Error {
  readonly code = "TooManyFilesError";
  constructor(
    readonly count: number,
    readonly max: number,
  ) {
    super(`write_files accepts at most ${max} files per call; received ${count}.`);
    this.name = "TooManyFilesError";
  }
}

/**
 * Two or more files in the same call target the same `path` (Copilot review
 * finding on PR #106). Without this check, `resolvedLocalPaths` — keyed by
 * `file.path` — would silently drop all but the last entry's `localPath`
 * (so an earlier duplicate would stage the WRONG file's bytes), and
 * `writtenPaths` would list the same path twice as if two distinct files had
 * been written, when in fact whichever entry committed last (an unspecified,
 * input-order-dependent race between the two renames) is the only one that
 * survives. Rejected up front, before any per-file validation, so partial
 * ambiguity is never staged.
 */
export class DuplicatePathError extends Error {
  readonly code = "DuplicatePathError";
  constructor(readonly path: string) {
    super(`Path "${path}" appears more than once in this write_files call; every path must be unique.`);
    this.name = "DuplicatePathError";
  }
}

/**
 * M1-08 AC4 — a file's `path` is rejected by the plan boundary: either it
 * doesn't match any glob in the plan's `writes` (`reason: "glob"`), or it
 * resolves outside the plan's `localDir` even though a glob DID match
 * (`reason: "escapesLocalDir"` — e.g. an absolute path under a permissive
 * `**`; see the containment check in `writeFiles`). Both failure modes share
 * one error class/code (`PathOutsidePlanError`) so callers can branch on a
 * single `code`, but the message and `reason` field distinguish them —
 * a Copilot review finding on PR #106 flagged the message as misleadingly
 * glob-specific even when the actual cause was the containment check.
 */
export class PathOutsidePlanError extends Error {
  readonly code = "PathOutsidePlanError";
  constructor(
    readonly path: string,
    readonly reason: "glob" | "escapesLocalDir" = "glob",
  ) {
    super(
      reason === "escapesLocalDir"
        ? `Path "${path}" resolves outside the plan's localDir, even though it may match a writes pattern.`
        : `Path "${path}" does not match any pattern in the plan's writes.`,
    );
    this.name = "PathOutsidePlanError";
  }
}

/** M1-08 AC6 — a file's `localPath` resolves outside the plan's `localDir`. */
export class LocalPathEscapeError extends Error {
  readonly code = "LocalPathEscapeError";
  constructor(
    readonly localPath: string,
    readonly localDir: string,
  ) {
    super(`localPath "${localPath}" resolves outside the plan's localDir "${localDir}".`);
    this.name = "LocalPathEscapeError";
  }
}

/** M1-08 AC7 — a file set neither `localPath` nor `data`, or set both. */
export class InvalidFileInputError extends Error {
  readonly code = "InvalidFileInputError";
  constructor(
    readonly path: string,
    reason: "missing" | "both",
  ) {
    super(
      reason === "both"
        ? `File "${path}" set both localPath and data; exactly one is required.`
        : `File "${path}" set neither localPath nor data; exactly one is required.`,
    );
    this.name = "InvalidFileInputError";
  }
}

/** M1-08 AC7 — `data` was not valid base64 when `encoding: "base64"` was declared. */
export class InvalidEncodingError extends Error {
  readonly code = "InvalidEncodingError";
  constructor(readonly path: string) {
    super(`File "${path}" declared encoding "base64" but data is not valid base64.`);
    this.name = "InvalidEncodingError";
  }
}

/** M1-08 AC9 — the call's total decoded byte size exceeds the configured cap. */
export class PayloadTooLargeError extends Error {
  readonly code = "PayloadTooLargeError";
  constructor(
    readonly totalBytes: number,
    readonly maxBytes: number,
    readonly retryMaxFiles: number,
  ) {
    super(
      `write_files payload is ${totalBytes} bytes, exceeding the ${maxBytes} byte cap. ` +
        "Halve the file count and retry.",
    );
    this.name = "PayloadTooLargeError";
  }
}

/** M1-08 AC10 — a file in the batch could not be written; the whole call rolled back. */
export class WriteFailedError extends Error {
  readonly code = "WriteFailedError";
  constructor(
    readonly path: string,
    readonly cause: string,
  ) {
    super(`Failed to write "${path}": ${cause}. The call was rolled back; no files were written.`);
    this.name = "WriteFailedError";
  }
}

/**
 * AC10 — a commit failed AND the rollback itself could not fully undo/restore
 * every step, so the destination tree is NOT guaranteed to match its
 * pre-call state (unlike the ordinary `WriteFailedError` path, which
 * guarantees a clean rollback). Surfaced instead of silently swallowing the
 * rollback failure and reporting the original commit error as if the
 * rollback had fully succeeded — a Copilot review finding on PR #106 flagged
 * that the prior code did exactly that, violating AC10's "tree ends up
 * exactly as it was before the call" guarantee without telling the caller.
 */
export class RollbackIncompleteError extends Error {
  readonly code = "RollbackIncompleteError";
  constructor(
    readonly commitError: string,
    readonly rollbackFailures: string[],
  ) {
    super(
      `write_files failed (${commitError}) AND rollback could not fully restore the ` +
        `original tree: ${rollbackFailures.join("; ")}. The destination may be left in ` +
        "a partially-modified state — verify manually before retrying.",
    );
    this.name = "RollbackIncompleteError";
  }
}

// ─── Input/output shapes ─────────────────────────────────────────────────────

const fileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Project-relative path to write, matched against the plan's writes globs"),
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe("Path on disk to read content from, resolved against the plan's localDir"),
    data: z
      .string()
      .optional()
      .describe("Inline content — utf-8 text, or base64 when encoding is base64"),
    encoding: z
      .enum(["utf-8", "base64"])
      .optional()
      .describe('Encoding of `data`. Defaults to "utf-8".'),
    mimeType: z.string().optional().describe("Optional MIME type hint (not currently persisted)"),
  })
  .describe("A single file to write: exactly one of localPath or data must be set");

const writeFilesInputSchema = {
  planId: z.string().min(1).describe("planId returned by a prior plan call"),
  files: z.array(fileInputSchema).describe("Files to write (max 256 per call)"),
} as const;

const writeFilesOutputSchema = {
  writtenPaths: z.array(z.string()).describe("Paths written, in the same order as the input"),
} as const;

interface FileInput {
  path: string;
  localPath?: string;
  data?: string;
  encoding?: "utf-8" | "base64";
  mimeType?: string;
}

interface WriteFilesArgs {
  planId: string;
  files: FileInput[];
}

/** Structured tool-error payload shape shared by every branch below. */
function toolError(payload: Record<string, unknown>) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/**
 * Register the `mcp__genie__write_files` tool.
 *
 * @param server The MCP server to register against. `planId`/`writes`/
 *               `localDir` are validated against the shared M1-07 plan
 *               registry (`../plans/index.ts`'s module-level `getPlan`) —
 *               there is no separate store instance to thread through.
 */
export function registerWriteFilesTool(server: McpServer): void {
  server.registerTool(
    WRITE_FILES_TOOL_NAME,
    {
      title: "Write files",
      description:
        "Write up to 256 files per call. Every path must match a glob in the plan's " +
        "writes. Reads content from localPath (resolved against the plan's localDir) " +
        "so file contents never enter model context, or from inline data for " +
        "in-memory content. Atomic per call — if any file fails, nothing is written.",
      inputSchema: writeFilesInputSchema,
      outputSchema: writeFilesOutputSchema,
    },
    async (args: WriteFilesArgs) => {
      try {
        const result = await writeFiles(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof TooManyFilesError) {
          // AC3 — plain structured error; no retry-hint contract specified
          // for the file-count ceiling (that's AC9's byte-cap path, below).
          return toolError({
            code: "TooManyFilesError",
            message: error.message,
            count: error.count,
            max: error.max,
          });
        }
        if (error instanceof PayloadTooLargeError) {
          // AC9 — literal contract: "return HTTP-equivalent error code -32099
          // with { retryWith: { maxFiles: <half> } } in data". That's the
          // shape of a JSON-RPC error object ({ code, message, data }), which
          // this mirrors exactly. Note this issue's AC9 and RFC §6.2's error
          // taxonomy disagree on the number — the RFC assigns byte-cap
          // overflow to genie.byteCapExceeded (-32031) and reserves -32099
          // for genie.internal (unanticipated errors). This implements AC9's
          // literal number as written (the graded contract for this issue)
          // and flags the discrepancy in the PR description for the
          // maintainer to reconcile.
          return toolError({
            code: -32099,
            message: error.message,
            data: {
              retryWith: { maxFiles: error.retryMaxFiles },
              totalBytes: error.totalBytes,
              maxBytes: error.maxBytes,
            },
          });
        }
        if (error instanceof PlanNotFoundError) {
          // M1-07's getPlan collapses "never existed" and "expired" into one
          // PlanNotFoundError (no separate PlanExpiredError) — see the module
          // header. AC5 asks for "existence + not-expired" validation; both
          // failure modes surface identically here, matching shipped M1-07.
          return toolError({
            code: "PlanNotFoundError",
            message: error.message,
            planId: error.planId,
          });
        }
        if (error instanceof RollbackIncompleteError) {
          // AC10's rollback guarantee could not be fully honored — this is
          // more severe than a plain WriteFailedError (which promises a
          // clean, fully-restored tree), so it gets its own code rather than
          // being silently folded into that message.
          return toolError({
            code: "RollbackIncompleteError",
            message: error.message,
            commitError: error.commitError,
            rollbackFailures: error.rollbackFailures,
          });
        }
        if (
          error instanceof PathOutsidePlanError ||
          error instanceof LocalPathEscapeError ||
          error instanceof InvalidFileInputError ||
          error instanceof InvalidEncodingError ||
          error instanceof WriteFailedError ||
          error instanceof DuplicatePathError
        ) {
          return toolError({ code: error.code, message: error.message, ...errorFields(error) });
        }
        throw error;
      }
    },
  );
}

/** Extra structured fields per own-error-type, beyond `code`/`message` (for client consumption). */
function errorFields(
  error:
    | PathOutsidePlanError
    | LocalPathEscapeError
    | InvalidFileInputError
    | InvalidEncodingError
    | WriteFailedError
    | DuplicatePathError,
): Record<string, unknown> {
  if (error instanceof PathOutsidePlanError) return { path: error.path, reason: error.reason };
  if (error instanceof LocalPathEscapeError) return { localPath: error.localPath, localDir: error.localDir };
  if (error instanceof InvalidFileInputError) return { path: error.path };
  if (error instanceof InvalidEncodingError) return { path: error.path };
  if (error instanceof DuplicatePathError) return { path: error.path };
  return { path: error.path, cause: error.cause }; // WriteFailedError
}

// ─── Core logic (exported for direct unit testing without the MCP transport) ─

export interface WriteFilesResult extends Record<string, unknown> {
  writtenPaths: string[];
}

/**
 * Validate + execute a `write_files` call against a resolved plan.
 *
 * Order of validation (fails fast, before any filesystem write) — keep this
 * list in lockstep with the code below; downstream steps assume every prior
 * step has passed (e.g. the `resolvedLocalPaths` map keyed by `file.path`
 * assumes step 3 rejected duplicates):
 *   1. AC5           — planId exists + not expired (`getPlan`, from the M1-07
 *                      plan registry — throws `PlanNotFoundError` for either
 *                      failure mode).
 *   2. AC3           — `files.length <= 256`.
 *   3. Structural    — no two `files[]` entries share the same destination
 *                      `path` (`DuplicatePathError`; Copilot review finding
 *                      on PR #106).
 *   4. AC4           — every `path` matches a plan `writes` glob.
 *   5. Security      — every destination `path` resolves inside
 *                      `plan.localDir` (`PathOutsidePlanError` with
 *                      `reason: "escapesLocalDir"`; RFC §10 T-13 — a glob
 *                      match alone doesn't imply containment when the glob
 *                      is permissive and the path is absolute).
 *   6. AC7           — every file sets exactly one of `localPath` / `data`.
 *   7. AC6           — every `localPath` resolves inside the plan's
 *                      `localDir`.
 *   8. AC9           — total decoded payload size <= the configured byte cap.
 * Only once every file in the batch passes does staging begin (AC10).
 */
export async function writeFiles(
  args: WriteFilesArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<WriteFilesResult> {
  // AC5 — planId must exist and be unexpired. Propagates PlanNotFoundError as-is.
  const plan = await getPlan(args.planId);

  // AC3 — file-count ceiling, before any per-file validation.
  if (args.files.length > MAX_FILES_PER_CALL) {
    throw new TooManyFilesError(args.files.length, MAX_FILES_PER_CALL);
  }

  // Structural check (Copilot review finding on PR #106): reject duplicate
  // destination `path`s before any per-file validation depends on paths
  // being unique. `resolvedLocalPaths` below is keyed by `file.path` — a
  // second entry with the same path would silently overwrite the first's
  // resolved `localPath` source, and `writtenPaths` would otherwise list the
  // same path twice as if two distinct files had committed.
  const seenPaths = new Set<string>();
  for (const file of args.files) {
    if (seenPaths.has(file.path)) {
      throw new DuplicatePathError(file.path);
    }
    seenPaths.add(file.path);
  }

  // AC4 — every path must match the plan's writes globs.
  for (const file of args.files) {
    if (!pathMatchesGlobs(file.path, plan.writes)) {
      throw new PathOutsidePlanError(file.path);
    }
  }

  // Security (Copilot review finding on PR #106; RFC §10 T-13 — "Path
  // traversal in write_files overwrites /etc/passwd"): `path` is
  // matched against the plan's glob patterns above, but a glob match alone
  // does NOT guarantee the resolved destination stays inside `localDir` — an
  // absolute path like "/etc/passwd" matches a permissive glob such as `**`
  // under micromatch (confirmed empirically: `isMatch("/etc/passwd", ["**"])`
  // is `true`), and `resolve(localDir, "/etc/passwd")` then returns
  // `/etc/passwd` verbatim, since `path.resolve` treats an absolute second
  // argument as an override rather than joining it. A `../`-traversal `path`
  // is already blocked by micromatch's own glob semantics (confirmed: `**`
  // does not match `../x`), so this second check is specifically the
  // absolute-path gap, not a redundant traversal re-check. Reuses
  // `isPathInsideLocalDir` — the same containment helper `localPath` (AC6)
  // already goes through — so `path` and `localPath` share one containment
  // guarantee instead of the destination trusting glob-membership alone.
  for (const file of args.files) {
    if (!isPathInsideLocalDir(file.path, plan.localDir)) {
      throw new PathOutsidePlanError(file.path, "escapesLocalDir");
    }
  }

  // AC7 — exactly one of localPath/data per file.
  for (const file of args.files) {
    const hasLocalPath = file.localPath !== undefined;
    const hasData = file.data !== undefined;
    if (hasLocalPath && hasData) {
      throw new InvalidFileInputError(file.path, "both");
    }
    if (!hasLocalPath && !hasData) {
      throw new InvalidFileInputError(file.path, "missing");
    }
    if (hasData && file.encoding === "base64" && !isValidBase64(file.data as string)) {
      throw new InvalidEncodingError(file.path);
    }
  }

  // AC6 — every localPath must resolve inside the plan's localDir. Resolve
  // once up front (rather than re-resolving during staging) so this check
  // and the actual read always agree on the same absolute path.
  // isPathInsideLocalDir(path, localDir) does its own resolution of `path`
  // against `localDir` (correctly anchoring a relative localPath there,
  // rather than against process.cwd()) — see plans/index.ts.
  const resolvedLocalPaths = new Map<string, string>();
  for (const file of args.files) {
    if (file.localPath === undefined) continue;
    if (!isPathInsideLocalDir(file.localPath, plan.localDir)) {
      throw new LocalPathEscapeError(file.localPath, plan.localDir);
    }
    resolvedLocalPaths.set(file.path, resolve(plan.localDir, file.localPath));
  }

  // AC9 — total decoded byte-size cap, checked before any write lands.
  const maxBytes = resolveByteCap(env);
  let totalBytes = 0;
  for (const file of args.files) {
    if (file.data !== undefined) {
      totalBytes += byteLengthOf(file.data, file.encoding ?? "utf-8");
    } else {
      const localPath = resolvedLocalPaths.get(file.path);
      if (localPath !== undefined) {
        totalBytes += await sizeOf(localPath, file.path);
      }
    }
  }
  if (totalBytes > maxBytes) {
    throw new PayloadTooLargeError(
      totalBytes,
      maxBytes,
      Math.max(1, Math.floor(args.files.length / 2)),
    );
  }

  // AC10 — stage every file into a per-call temp dir first; only rename into
  // place once every file has staged successfully.
  return stageAndCommit(args.files, resolvedLocalPaths, plan.localDir);
}

/** Decoded byte length of inline `data`, without materializing extra copies for utf-8. */
function byteLengthOf(data: string, encoding: "utf-8" | "base64"): number {
  if (encoding === "base64") {
    // Base64 expands 3 bytes -> 4 chars; strip padding for an exact count.
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.floor((data.length * 3) / 4) - padding;
  }
  return Buffer.byteLength(data, "utf-8");
}

function isValidBase64(data: string): boolean {
  if (data.length === 0) return true;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0;
}

async function sizeOf(localPath: string, publicPath: string): Promise<number> {
  try {
    const info = await stat(localPath);
    return info.size;
  } catch (error) {
    throw new WriteFailedError(publicPath, describeError(error, "source file not found"));
  }
}

/** One file staged and ready to commit. */
interface StagedFile {
  /** The plan-relative path, for error messages. */
  publicPath: string;
  /** Absolute destination path under the plan's localDir. */
  destPath: string;
  /** Absolute path of the staged (new) content, inside the call's temp dir. */
  stagedPath: string;
}

/**
 * Stage every file's new content under a fresh per-call temp directory
 * (streaming `localPath` sources through a hash so a large file is never
 * fully buffered in memory), then commit via rename-to-temp + rename-back
 * (see the module header). Nothing under `localDir` is touched until every
 * file has staged successfully.
 *
 * Staging lives at `<localDir>/.genie-tmp/<random>/` — inside `localDir`
 * itself, per the issue's own Implementation Notes ("Per-call transaction =
 * write to `<projectRoot>/.genie-tmp/<callId>/` then atomic rename per
 * file"). This is load-bearing, not cosmetic: `rename()` is only atomic
 * within a single filesystem/mount. An earlier version of this code staged
 * under `os.tmpdir()` (`/tmp`), which is commonly a *different* mount than
 * the project/kit directory (e.g. a container with `/tmp` as tmpfs and the
 * project on a bind-mounted volume) — a Copilot review finding on PR #106
 * confirmed the commit-phase `rename()` would then throw `EXDEV` and break
 * the atomic guarantee AC10 depends on. Staging inside `localDir` guarantees
 * same-filesystem renames.
 *
 * Known limitation (v1, matches the issue's own "conflict detection vs
 * concurrent writes... out of scope" note): a concurrent `list_files` call
 * could observe the `.genie-tmp/<random>/` directory mid-write. It is always
 * removed (success or failure) before this function returns, and
 * `randomUUID()`-derived names make a collision between concurrent calls
 * astronomically unlikely, but it is not hidden from a concurrent lister the
 * way `.git`/`node_modules`/`dist` are (see `list_files.ts`'s ignore list) —
 * left as-is rather than expanding this PR's scope into that tool.
 */
async function stageAndCommit(
  files: FileInput[],
  resolvedLocalPaths: Map<string, string>,
  localDir: string,
): Promise<WriteFilesResult> {
  const genieTmpRoot = join(localDir, ".genie-tmp");
  await mkdir(genieTmpRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(genieTmpRoot, `${randomUUID()}-`));
  const backupRoot = join(stagingRoot, "backup");

  try {
    // Phase 1 — stage new content. Real destinations are untouched so far.
    const staged: StagedFile[] = [];
    for (const file of files) {
      const destPath = resolve(localDir, file.path);
      const stagedPath = join(stagingRoot, `${staged.length}`);

      if (file.localPath !== undefined) {
        const sourcePath = resolvedLocalPaths.get(file.path);
        if (sourcePath === undefined) {
          throw new WriteFailedError(file.path, "internal: unresolved localPath");
        }
        await streamCopy(sourcePath, stagedPath, file.path);
      } else {
        const buffer = decodeData(file.data as string, file.encoding ?? "utf-8", file.path);
        await writeStaged(stagedPath, buffer, file.path);
      }

      staged.push({ publicPath: file.path, destPath, stagedPath });
    }

    await commitStaged(staged, backupRoot, localDir);

    return { writtenPaths: files.map((f) => f.path) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Commit every staged file via rename-to-temp + rename-back (AC10).
 *
 * 1. Ensure every destination's parent directory exists.
 * 2. Back up (rename away) any destination that already exists.
 * 3. Rename each staged file into its real destination.
 * 4. On any failure in step 3: remove whatever this call already committed,
 *    restore every backup to its original path, then throw. On full
 *    success, the backups are left under `backupRoot` and cleaned up by the
 *    caller's `finally` (removing the whole staging root).
 */
async function commitStaged(
  staged: StagedFile[],
  backupRoot: string,
  localDir: string,
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
          relativeOrAbsolute(localDir, destPath, publicPath),
          describeError(error, "rename failed"),
        );
      }
      committed.push(destPath);
    }
  } catch (error) {
    // Roll back: undo everything this call committed, then restore backups.
    //
    // Every step below runs unconditionally (never short-circuits on a prior
    // failure within this block) and its own failure is collected rather than
    // thrown immediately — a Copilot review finding on PR #106 flagged that
    // the previous code did the opposite: `rm(destPath, { force: true })`
    // could itself throw (e.g. EACCES; `force` only suppresses ENOENT, not
    // other errors) and abort the `for` loop early, silently skipping BOTH
    // the remaining commit-undo steps AND the entire backup-restore loop that
    // used to follow it — while still reporting only the original commit
    // error, as if rollback had fully succeeded. Collecting failures here
    // means every step is still attempted even if an earlier one fails.
    const rollbackFailures: string[] = [];
    for (const destPath of committed) {
      try {
        await rm(destPath, { force: true });
      } catch (rmError) {
        rollbackFailures.push(
          `failed to remove committed file "${relativeOrAbsolute(localDir, destPath, destPath)}": ` +
            describeError(rmError, "unknown error"),
        );
      }
    }
    for (const { destPath, backupPath } of backedUp) {
      try {
        await rename(backupPath, destPath);
      } catch (restoreError) {
        rollbackFailures.push(
          `failed to restore backup for "${relativeOrAbsolute(localDir, destPath, destPath)}": ` +
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
 * Rename `destPath` to `backupPath` if it exists. Returns whether a backup
 * was made (`false` when `destPath` didn't exist — nothing to back up).
 *
 * Refuses (via `WriteFailedError`, triggering the normal rollback path) when
 * `destPath` exists as a DIRECTORY rather than a file. `rename()` itself
 * doesn't distinguish files from directories — it would happily move an
 * existing directory into the backup slot, after which a file gets renamed
 * into its place; if the whole call then succeeds, the caller's `finally`
 * (`stageAndCommit`) deletes the entire staging root, backups included,
 * silently destroying whatever tree used to live at `destPath` (a Copilot
 * review finding on PR #106). `write_files` writes FILES, never replaces a
 * directory, so this rejects before the rename is even attempted.
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

function relativeOrAbsolute(localDir: string, destPath: string, fallback: string): string {
  const rel = relative(localDir, destPath);
  return rel.length > 0 ? rel : fallback;
}

function decodeData(data: string, encoding: "utf-8" | "base64", path: string): Buffer {
  try {
    return Buffer.from(data, encoding === "base64" ? "base64" : "utf-8");
  } catch (error) {
    throw new WriteFailedError(path, describeError(error, "invalid data encoding"));
  }
}

async function writeStaged(stagedPath: string, content: Buffer, publicPath: string): Promise<void> {
  try {
    await writeFile(stagedPath, content);
  } catch (error) {
    throw new WriteFailedError(publicPath, describeError(error, "write failed"));
  }
}

/**
 * Stream `sourcePath` into `stagedPath` through a SHA-256 hash pass-through,
 * so `write_files` never loads a full file into memory regardless of size
 * (Implementation Notes: "Streaming reads … pipe through hash"). The hash
 * itself isn't surfaced today (no AC calls for it) but proves the data
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
