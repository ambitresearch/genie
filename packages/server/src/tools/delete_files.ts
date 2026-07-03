/**
 * MCP tool: delete_files (M1-09).
 *
 * The plan-gated companion to `write_files`. Every requested path must be
 * covered by a glob in the plan's `deletes` list (locked at `plan` time) —
 * otherwise the whole call is rejected with `PathOutsidePlanError` and nothing
 * is touched. A path that is authorized but no longer exists on disk is NOT an
 * error: it is recorded in `notFoundPaths` and the call still succeeds. This is
 * the "known-good failure to silently retry past" from the research report —
 * e.g. deleting a floor-card component's `_preview/*.html` that was never
 * generated remotely.
 *
 * Input:  { planId: string, paths: string[] }
 * Output: { deletedPaths: string[], notFoundPaths: string[] }
 *
 * Ordering: paths are deleted longest-first so a file is always removed before
 * any (shorter) prefix that names its containing directory — avoiding a
 * spurious ENOTEMPTY. (Recursive directory delete is out of scope: paths must
 * name files. A directory target surfaces as a hard `DeleteFailed` error.)
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlanNotFoundError } from "../plans/index.js";
import { PlanGuardError, runPlanGuard } from "../middleware/plan-guard.js";

export const DELETE_FILES_TOOL_NAME = "mcp__genie__delete_files";

/**
 * Authoritative argument schema. `.strict()` rejects unknown keys, and the
 * per-item `.min(1)` guards against empty path strings. This is re-parsed
 * inside `deleteFiles` so the same validation holds whether the tool is invoked
 * over MCP or called directly (tests, future in-process callers).
 */
const deleteFilesArgsSchema = z
  .object({
    planId: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type DeleteFilesArgs = z.infer<typeof deleteFilesArgsSchema>;

export interface DeleteFilesResult extends Record<string, unknown> {
  /** Paths that existed and were removed (AC4). */
  deletedPaths: string[];
  /** Authorized paths that did not exist — a non-error (AC5). */
  notFoundPaths: string[];
}

export type DeleteFilesErrorCode = "InvalidArguments" | "PathOutsidePlanError" | "DeleteFailed";

/** Structured, client-facing error for the delete_files tool. */
export class DeleteFilesError extends Error {
  readonly code: DeleteFilesErrorCode;
  /** The offending path, when the error is path-specific. */
  readonly path?: string;

  constructor(code: DeleteFilesErrorCode, message: string, path?: string) {
    super(message);
    this.name = "DeleteFilesError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Sort paths so deeper/longer paths come first. Deleting a file before the
 * (shorter) path that names its parent directory avoids ENOTEMPTY. Length ties
 * fall back to `localeCompare` for a deterministic order. Pure — never mutates
 * the caller's array.
 */
export function sortPathsLongestFirst(paths: string[]): string[] {
  return [...paths].sort((a, b) =>
    b.length !== a.length ? b.length - a.length : a.localeCompare(b),
  );
}

/**
 * Map a shared plan-guard failure onto delete_files' own error taxonomy, so the
 * tool's public contract is unchanged after the M1-13 refactor. The guard's
 * per-path reasons (dot-segment, not-in-plan, escapes-boundary) and the
 * kitId-escape case all surface as this tool's `PathOutsidePlanError`; a
 * plan-not-found/expired surfaces as `PlanNotFoundError` (the same type the
 * MCP handler already renders). A missing planId can't occur here (the Zod
 * schema requires it before this runs) but is mapped defensively.
 *
 * Any non-guard error is returned unchanged for the caller to rethrow.
 */
function mapGuardError(error: unknown): Error {
  if (!(error instanceof PlanGuardError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.reason) {
    case "PLAN_NOT_FOUND":
    case "MISSING_PLAN_ID":
      return new PlanNotFoundError(error.path ?? "");
    case "PATH_DOT_SEGMENT":
    case "PATH_NOT_IN_PLAN":
    case "PATH_ESCAPES_PLAN":
      return new DeleteFilesError("PathOutsidePlanError", error.message, error.path);
  }
}

/** ENOENT (missing file) and ENOTDIR (a parent component is a file) both mean
 * "the path is not there" — the silent-retry case, not a hard failure. */
function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * Delete every `path` in `args.paths` from the plan's kit, subject to the
 * plan's `deletes` allow-list.
 *
 * @param kitsRoot The directory kits live under (the SAME value `createServer`
 *   threads into `read_file`/`list_files`), so deletes hit exactly the tree
 *   those verbs read. The concrete kit root is `resolve(kitsRoot, plan.kitId)`.
 */
export async function deleteFiles(
  kitsRoot: string,
  args: DeleteFilesArgs,
): Promise<DeleteFilesResult> {
  // 1. Validate argument shape (AC2). A malformed planId / empty paths array is
  //    an InvalidArguments error, never a silent no-op. (Shape validation stays
  //    here — the plan-guard middleware validates plan+paths, not arg schema.)
  let parsed: DeleteFilesArgs;
  try {
    parsed = deleteFilesArgsSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new DeleteFilesError(
        "InvalidArguments",
        error.issues[0]?.message ??
          "Invalid arguments: expected { planId: string, paths: string[] }.",
      );
    }
    throw error;
  }

  // 2. Plan + path authorization (M1-13 AC4): funnel through the SHARED
  //    plan-guard middleware so write_files and delete_files enforce identical
  //    plan semantics. The guard resolves the plan (unknown/expired →
  //    PLAN_NOT_FOUND), verifies the kit root stays inside kitsRoot (defence in
  //    depth against a traversal kitId), and checks every path: no dot-segment,
  //    matches the plan's `deletes`, resolves inside the kit root. We map its
  //    typed reasons back onto delete_files' own error taxonomy so the tool's
  //    public contract (PathOutsidePlanError / PlanNotFoundError shapes the
  //    conformance suite asserts) is unchanged.
  const resolvedKitsRoot = resolve(kitsRoot);
  let guarded;
  try {
    guarded = await runPlanGuard(parsed, {
      kind: "delete",
      getPlanId: (a) => a.planId,
      getPaths: (a) => a.paths,
      resolveBoundary: (plan) => resolve(resolvedKitsRoot, plan.kitId),
      rootForBoundary: resolvedKitsRoot,
    });
  } catch (error) {
    throw mapGuardError(error);
  }

  const plan = guarded.plan;
  const kitRoot = resolve(resolvedKitsRoot, plan.kitId);
  const uniquePaths = guarded.paths;

  // 5. Delete longest-first (files before their containing directories).
  const deleted = new Set<string>();
  const notFound = new Set<string>();
  for (const path of sortPathsLongestFirst(uniquePaths)) {
    const target = resolve(kitRoot, path);
    try {
      await unlink(target);
      deleted.add(path);
    } catch (error) {
      if (isMissingPathError(error)) {
        // AC5 — authorized but absent: a non-error, retry past it.
        notFound.add(path);
        continue;
      }
      // AC6 — permission denied, a directory target (EISDIR), etc. fail the
      // whole call rather than being silently dropped.
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      throw new DeleteFilesError("DeleteFailed", `Failed to delete "${path}": ${code}.`, path);
    }
  }

  // 6. Report in the original (de-duplicated) request order.
  return {
    deletedPaths: uniquePaths.filter((path) => deleted.has(path)),
    notFoundPaths: uniquePaths.filter((path) => notFound.has(path)),
  };
}

/**
 * Register the `mcp__genie__delete_files` tool.
 *
 * AC1: Tool name `mcp__genie__delete_files`.
 * AC2: Input `{ planId: string, paths: string[] }`.
 * AC3: Each path must match a plan `deletes` glob, else PathOutsidePlanError.
 * AC4: Returns `deletedPaths` — what was actually removed.
 * AC5: A missing path is a non-error, recorded in `notFoundPaths`.
 * AC6: Other errors (permission denied, directory target, …) fail the call.
 */
export function registerDeleteFilesTool(server: McpServer, kitsRoot: string): void {
  server.registerTool(
    DELETE_FILES_TOOL_NAME,
    {
      title: "Delete files",
      description:
        "Delete kit files authorized by a plan. Every path must match a glob in " +
        "the plan's `deletes`; an out-of-plan path rejects the whole call. A path " +
        "that no longer exists is not an error — it is returned in `notFoundPaths`. " +
        "Paths must name files, not directories.",
      inputSchema: {
        planId: z
          .string()
          .describe(
            "The planId returned by mcp__genie__plan whose `deletes` authorize these paths.",
          ),
        paths: z
          .array(z.string())
          .describe("Kit-root-relative file paths to delete; each must match a `deletes` glob."),
      },
      // `deletedPaths` is the contract's required field (RFC §9.8); `notFoundPaths`
      // is always populated but declared optional so `required` stays `["deletedPaths"]`.
      outputSchema: {
        deletedPaths: z.array(z.string()),
        notFoundPaths: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const result = await deleteFiles(kitsRoot, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof DeleteFilesError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.code,
                  message: error.message,
                  ...(error.path !== undefined ? { path: error.path } : {}),
                }),
              },
            ],
          };
        }
        if (error instanceof PlanNotFoundError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "PlanNotFoundError",
                  message: error.message,
                  planId: error.planId,
                }),
              },
            ],
          };
        }
        throw error; // unexpected — bubble up as an MCP internal error
      }
    },
  );
}
