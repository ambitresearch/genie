/**
 * MCP tool: write_files (M1-08; re-plumbed onto KitStore in M1-14a-1b / DRO-565).
 *
 * Writes up to 256 files per call into a KIT (the plan's `kitId` — the same
 * readable surface `read_file`/`list_files`/`delete_files` see). Every `path`
 * must match at least one glob in the plan's `writes`; the plan is resolved via
 * `planId` against the M1-07 plan registry (`../plans/index.ts`), which must be
 * live (exists + not expired).
 *
 * Each file is sourced from exactly one of:
 *   - `localPath` — resolved against the plan's `localDir` (the harness-local
 *     SOURCE base); the server reads the bytes directly from disk, so file
 *     contents never enter model context (the whole point of the localPath
 *     indirection). Note the split of roles: `localDir` is where uploads are
 *     READ FROM; the kit is where they are WRITTEN TO.
 *   - `data` — inline content (utf-8 or base64, per `encoding`), for content
 *     the caller only has in-memory (e.g. LLM-generated text).
 *
 * ── Store re-plumb (DRO-565) ─────────────────────────────────────────────────
 * This tool used to own an fs-native rename-to-temp/rename-back transaction and
 * wrote straight into `plan.localDir`. That transaction now lives behind the
 * `KitStore.writeFiles(kitId, ops)` primitive (`store/interface.ts`), so the
 * SAME verb runs against `LocalFsKitStore` (disk, rename transaction) or
 * `GitHostKitStore` (contents-API commit on a branch) with the AC10 atomicity +
 * rollback contract preserved. The tool keeps ALL plan-gating and per-file
 * validation (planId, writes-glob membership, duplicate rejection, localPath
 * containment + streaming decision, byte cap, encoding) and hands the store a
 * resolved `WriteOp[]` — mirroring how `delete_files` keeps `deletes`-glob
 * gating tool-side and calls `store.deleteFile(plan.kitId, path)`.
 *
 * The atomicity/streaming/rollback semantics themselves are documented on the
 * `KitStore.writeFiles` primitive and its two adapters; this file is now the
 * validation + wire-error-shaping layer in front of them.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { withPlanGuard } from "../middleware/plan-guard.js";
import {
  getPlan,
  isPathInsideLocalDir,
  pathMatchesGlobs,
  PlanNotFoundError,
} from "../plans/index.js";
import type { KitStore, WriteOp } from "../store/interface.js";
import { RollbackIncompleteError, WriteFailedError } from "../store/interface.js";
import { isValidBase64Content } from "../store/kit-files.js";

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
    super(
      `Path "${path}" appears more than once in this write_files call; every path must be unique.`,
    );
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

/**
 * AC10 write-failure taxonomy now lives in the store layer (`store/interface.ts`),
 * because the store owns the atomic write transaction after the DRO-565 re-plumb.
 * Re-exported here so existing importers of these names from `write_files.js`
 * (tests, in-process callers) keep resolving them.
 */
export { RollbackIncompleteError, WriteFailedError } from "../store/interface.js";

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
 * @param server   The MCP server to register against. `planId`/`writes` are
 *                 validated against the shared M1-07 plan registry
 *                 (`../plans/index.ts`) via the M1-13 plan-guard middleware
 *                 (`../middleware/plan-guard.ts`) — the guard owns AC5's planId
 *                 presence/existence/expiry checks and AC4's path-vs-`writes`-
 *                 glob check; this file's own remaining validation covers
 *                 per-file structural rules (duplicates, localPath containment,
 *                 encoding, byte cap) that the guard is intentionally
 *                 tool-agnostic about.
 * @param kitStore The injected kit backend (M1-14a-1b / DRO-565). The physical
 *                 write is `kitStore.writeFiles(plan.kitId, ops)` — the kit is
 *                 the destination (same surface read_file/list_files see), and
 *                 the atomic rename-transaction (LocalFs) / contents-API commit
 *                 (GitHost) lives behind that primitive. Mirrors how
 *                 `registerDeleteFilesTool(server, kitStore)` routes deletes.
 */
export function registerWriteFilesTool(server: McpServer, kitStore: KitStore): void {
  server.registerTool(
    WRITE_FILES_TOOL_NAME,
    {
      title: "Write files",
      description:
        "Write up to 256 files per call into the plan's kit. Every path must match a " +
        "glob in the plan's writes. Reads content from localPath (resolved against the " +
        "plan's localDir, the local SOURCE base) so file contents never enter model " +
        "context, or from inline data for in-memory content. Atomic per call — if any " +
        "file fails, nothing is written. Requires a planId from mcp__genie__plan covering " +
        "every path being written; call preview afterwards to show the result.",
      inputSchema: writeFilesInputSchema,
      outputSchema: writeFilesOutputSchema,
    },
    // M1-13 plan-vs-write guard (DRO-239). The middleware validates planId
    // presence/existence/expiry and every file path against the plan's writes
    // globs BEFORE the handler runs, so the four verbs share one identical
    // plan-boundary check. Rejections surface as the canonical JSON-RPC
    // `-32602` shape and are audit-logged as `plan.guard.reject`. The guard
    // hands the resolved plan through in `ctx.plan`, so the handler reaches
    // `plan.kitId` (write destination) and `plan.localDir` (localPath source
    // base) without a second getPlan hit.
    //
    // The core `writeFiles(store, plan, args)` still performs the same plan
    // check as defense-in-depth (a direct in-process caller — see the
    // "writeFiles (core logic)" test suite — bypasses the MCP layer and this
    // middleware with it), so removing the checks from the core would silently
    // open a gap for those callers.
    withPlanGuard({ mode: "writes" }, async (args: WriteFilesArgs) => {
      try {
        const result = await writeFiles(kitStore, args);
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
          // Ordinarily unreachable at the wire level — the M1-13 plan-guard
          // middleware (above) catches PlanNotFoundError first and returns
          // the canonical -32602 shape. Kept as a belt-and-suspenders branch
          // in case `writeFiles` throws it from a code path the middleware
          // didn't traverse (e.g. a future refactor that bypasses the guard,
          // or a race where a plan expires between the guard's getPlan and
          // the core's getPlan). Behaviour matches shipped M1-07: same
          // PlanNotFoundError for "never existed" and "expired".
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
    }),
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
  if (error instanceof LocalPathEscapeError)
    return { localPath: error.localPath, localDir: error.localDir };
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
 * Validate + execute a `write_files` call against a resolved plan, committing
 * the batch into the plan's KIT via the injected store.
 *
 * Order of validation (fails fast, before any write) — keep this list in
 * lockstep with the code below; downstream steps assume every prior step has
 * passed (e.g. the `resolvedLocalPaths` map keyed by `file.path` assumes step 3
 * rejected duplicates):
 *   1. AC5           — planId exists + not expired (`getPlan`, from the M1-07
 *                      plan registry — throws `PlanNotFoundError` for either
 *                      failure mode).
 *   2. AC3           — `files.length <= 256`.
 *   3. Structural    — no two `files[]` entries share the same destination
 *                      `path` (`DuplicatePathError`; Copilot review finding
 *                      on PR #106).
 *   4. AC4           — every `path` matches a plan `writes` glob.
 *   5. Security      — every destination `path` is kit-relative and contained
 *                      (no absolute path, no `..`/`.` segment). Destinations
 *                      resolve against the KIT now (not `localDir`), so this is
 *                      a lexical containment check (`PathOutsidePlanError` with
 *                      `reason: "escapesLocalDir"`; RFC §10 T-13). The store
 *                      re-checks via `safePath` as defense-in-depth.
 *   6. AC7           — every file sets exactly one of `localPath` / `data`.
 *   7. AC6           — every `localPath` resolves inside the plan's `localDir`
 *                      (the SOURCE base — where uploads are read from).
 *   8. AC9           — total decoded payload size <= the configured byte cap.
 * Only once every file in the batch passes is the batch handed to
 * `store.writeFiles(plan.kitId, ops)` for the atomic commit (AC10).
 *
 * @param store The injected kit backend. The destination is `plan.kitId`; the
 *   physical atomic write (rename transaction on LocalFs / contents-API commit
 *   on GitHost) lives behind `store.writeFiles`, so this function is now purely
 *   validation + WriteOp assembly.
 */
export async function writeFiles(
  store: KitStore,
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
  // traversal in write_files overwrites /etc/passwd"): a glob match alone does
  // NOT guarantee the destination stays inside the kit — an absolute path like
  // "/etc/passwd" matches a permissive glob such as `**` under micromatch, and
  // resolving it against a kit root would escape. Post-re-plumb the destination
  // is the KIT (not `localDir`), and the store's `safePath` will reject an
  // escape too — but we reject up front so the whole call fails before any
  // WriteOp is built, keeping the all-or-nothing guarantee at the tool
  // boundary. The check is now purely lexical (kit-relative, no `.`/`..`
  // segment, not absolute) since the tool no longer holds a concrete kit root.
  for (const file of args.files) {
    if (!isKitRelativeContained(file.path)) {
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
    if (hasData && file.encoding === "base64" && !isValidBase64Content(file.data as string)) {
      throw new InvalidEncodingError(file.path);
    }
  }

  // AC6 — every localPath must resolve inside the plan's localDir (the SOURCE
  // base). Resolve once up front (rather than re-resolving during the WriteOp
  // build) so this check and the actual read always agree on the same absolute
  // path. isPathInsideLocalDir(path, localDir) does its own resolution of
  // `path` against `localDir` (correctly anchoring a relative localPath there,
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

  // Build the resolved WriteOp[] — inline `data` becomes `{ path, content }`,
  // a `localPath` becomes `{ path, sourcePath }` (the store STREAMS from it, so
  // a large upload never fully buffers here). Then hand the batch to the store
  // for the atomic commit into the kit (AC10).
  const ops: WriteOp[] = args.files.map((file): WriteOp => {
    if (file.localPath !== undefined) {
      const sourcePath = resolvedLocalPaths.get(file.path);
      if (sourcePath === undefined) {
        // Unreachable: every localPath file populated the map above.
        throw new WriteFailedError(file.path, "internal: unresolved localPath");
      }
      return { path: file.path, sourcePath };
    }
    return {
      path: file.path,
      content: decodeData(file.data as string, file.encoding ?? "utf-8", file.path),
    };
  });

  return store.writeFiles(plan.kitId, ops);
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

async function sizeOf(localPath: string, publicPath: string): Promise<number> {
  try {
    const info = await stat(localPath);
    return info.size;
  } catch (error) {
    throw new WriteFailedError(publicPath, describeError(error, "source file not found"));
  }
}

/**
 * True if a destination `path` is a safe kit-relative path: not absolute, and
 * with no `.`/`..` segment (on either separator). Post-re-plumb the destination
 * is the kit (the tool holds no concrete kit root), so containment is a lexical
 * check — a relative path with no dot-segment can never escape the kit root the
 * store resolves it against, and an absolute path always does. The store's
 * `safePath` re-verifies as defense-in-depth. Mirrors delete_files' own
 * kit-relative path guard.
 */
function isKitRelativeContained(path: string): boolean {
  if (isAbsolute(path)) return false;
  return !path.split(/[/\\]/).some((seg) => seg === "." || seg === "..");
}

function decodeData(data: string, encoding: "utf-8" | "base64", path: string): Buffer {
  try {
    return Buffer.from(data, encoding === "base64" ? "base64" : "utf-8");
  } catch (error) {
    throw new WriteFailedError(path, describeError(error, "invalid data encoding"));
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}
