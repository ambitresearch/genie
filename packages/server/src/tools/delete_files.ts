/**
 * MCP tool: delete_files (M1-09; re-plumbed onto KitStore in M1-14a-1a / DRO-540).
 *
 * The plan-gated companion to `write_files`. Every requested path must be
 * covered by a glob in the plan's `deletes` list (locked at `plan` time) —
 * otherwise the whole call is rejected with `PathOutsidePlanError` and nothing
 * is touched. A path that is authorized but no longer exists is NOT an error:
 * it is recorded in `notFoundPaths` and the call still succeeds. This is the
 * "known-good failure to silently retry past" from the research report — e.g.
 * deleting a floor-card component's `_preview/*.html` that was never generated
 * remotely.
 *
 * Plan-gating stays here (planId → `deletes` globs is a genie concept, not a
 * store concept). The physical removal is delegated to the injected
 * `KitStore.deleteFile`, so the SAME verb deletes from a `LocalFsKitStore` (fs
 * unlink) or a `GitHostKitStore` (contents-API DELETE on the default branch)
 * with identical gating and result shaping.
 *
 * Input:  { planId: string, paths: string[] }
 * Output: { deletedPaths: string[], notFoundPaths: string[] }
 *
 * Ordering: paths are deleted longest-first so a file is always removed before
 * any (shorter) prefix that names its containing directory — avoiding a
 * spurious ENOTEMPTY. (Recursive directory delete is out of scope: paths must
 * name files. A directory target surfaces as a hard `DeleteFailed` error.)
 */

import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KitStore } from "../store/interface.js";
import { withPlanGuard } from "../middleware/plan-guard.js";
import { getPlan, pathMatchesGlobs, PlanNotFoundError } from "../plans/index.js";

export const DELETE_FILES_TOOL_NAME = "mcp__genie__delete_files";
export const DELETE_FILES_DESCRIPTION =
  "Delete kit files authorized by a plan. Every path must match a glob in " +
  "the plan's `deletes`; an out-of-plan path rejects the whole call. A path " +
  "that no longer exists is not an error — it is returned in `notFoundPaths`. " +
  "Paths must name files, not directories. Requires a planId from mcp__genie__plan " +
  "whose `deletes` globs cover every path being removed. After deletion, call " +
  "mcp__genie__preview to recompile the manifest so the grid and list_components " +
  "stop exposing removed components.";

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
 * True if any `/`- or `\`-separated segment is `.` or `..`.
 *
 * `pathMatchesGlobs` checks the RAW request string, but a store resolves it
 * against the kit root. Those two views can disagree: a dot-segment input like
 * `allowed/../secret.txt` matches a glob such as `allowed/../*.txt` yet resolves
 * to `kitRoot/secret.txt` — a file the plan never meant to authorize. Rejecting
 * any dot-segment BEFORE both the glob check and the store call makes plan
 * gating depend only on the literal authorized path.
 */
function hasDotSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
}

/**
 * True if a kitId is path-shaped (contains a separator or a `..`). The tool no
 * longer holds a `kitsRoot`, so it cannot re-derive the on-disk kit root to
 * prove containment; instead it rejects a traversal-shaped kitId outright.
 *
 * `plan` accepts `kitId: z.string().min(1)` with no traversal guard and stores
 * it verbatim, so a plan authored with e.g. `kitId: ".."` could otherwise make
 * a LocalFs store resolve a kit dir OUTSIDE the kits root (defense in depth,
 * mirroring read_file's kitId check). A store guards internally too, but this
 * keeps the whole-call rejection at the atomic pre-flight, before anything is
 * deleted.
 */
function isPathShapedKitId(kitId: string): boolean {
  return kitId.includes("/") || kitId.includes("\\") || kitId.includes("..");
}

/**
 * Delete every `path` in `args.paths` from the plan's kit, subject to the
 * plan's `deletes` allow-list.
 *
 * @param store The injected kit backend (M1-14a-1a / DRO-540). The concrete kit
 *   is `plan.kitId`; the physical removal is `store.deleteFile(plan.kitId, path)`
 *   — LocalFs unlink or git-host contents-API delete, behind one interface.
 */
export async function deleteFiles(
  store: KitStore,
  args: DeleteFilesArgs,
): Promise<DeleteFilesResult> {
  // 1. Validate argument shape (AC2). A malformed planId / empty paths array is
  //    an InvalidArguments error, never a silent no-op.
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

  // 2. Resolve the plan. Unknown / expired / malformed-UUID planIds throw
  //    PlanNotFoundError (surfaced to the client, not swallowed here).
  const plan = await getPlan(parsed.planId);

  // 2a. Defense in depth: a plan authored with a traversal-shaped kitId (e.g.
  //     "..") could make a LocalFs store resolve a kit dir outside the kits
  //     root. As the first destructive consumer, reject it before deleting
  //     anything (mirrors read_file's kitId guard).
  if (isPathShapedKitId(plan.kitId)) {
    throw new DeleteFilesError(
      "PathOutsidePlanError",
      `Plan kitId "${plan.kitId}" is not a valid kit identifier.`,
      plan.kitId,
    );
  }

  // 3. De-duplicate while preserving first-seen order — a path repeated in the
  //    request must not appear twice in the result, nor in both result arrays.
  const uniquePaths = [...new Set(parsed.paths)];

  // 4. Atomic pre-flight (AC3). EVERY path must both (a) match a `deletes` glob
  //    and (b) stay inside the kit root. If any path fails, throw before
  //    deleting anything — so an out-of-plan path can never take an in-plan
  //    sibling down with it. The containment check is purely lexical now (the
  //    tool holds no kits root): a relative path with no `.`/`..` segment can
  //    never escape the kit root, and an absolute path always does.
  for (const path of uniquePaths) {
    // 4a. Normalize-first defense: a `.`/`..` segment lets the raw-string glob
    //     check and the resolved delete target disagree (see hasDotSegment).
    if (hasDotSegment(path)) {
      throw new DeleteFilesError(
        "PathOutsidePlanError",
        `Path "${path}" contains a "." or ".." segment.`,
        path,
      );
    }
    // 4b. An absolute path escapes any kit root by definition.
    if (isAbsolute(path)) {
      throw new DeleteFilesError(
        "PathOutsidePlanError",
        `Path "${path}" is absolute and resolves outside the kit root.`,
        path,
      );
    }
    if (!pathMatchesGlobs(path, plan.deletes)) {
      throw new DeleteFilesError(
        "PathOutsidePlanError",
        `Path "${path}" is not covered by the plan's deletes.`,
        path,
      );
    }
  }

  // 5. Delete longest-first (files before their containing directories), via the
  //    injected store. `{ existed: false }` is the AC5 silent-retry case; a hard
  //    store error (a directory target, permission denied, …) fails the whole
  //    call (AC6) rather than being swallowed.
  const deleted = new Set<string>();
  const notFound = new Set<string>();
  for (const path of sortPathsLongestFirst(uniquePaths)) {
    try {
      const { existed } = await store.deleteFile(plan.kitId, path);
      if (existed) {
        deleted.add(path);
      } else {
        notFound.add(path); // AC5 — authorized but absent: a non-error.
      }
    } catch (error) {
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
 *
 * Plan-boundary validation (planId presence/existence/expiry, path-vs-
 * `deletes`-glob) runs through the M1-13 plan-guard middleware
 * (`../middleware/plan-guard.ts`) so the write/delete verbs share one
 * identical check. Delete-tool-specific validation (InvalidArguments shape,
 * kitId containment, dot-segment rejection, unlink failure taxonomy) stays
 * in `deleteFiles` itself — the guard is intentionally tool-agnostic about
 * those.
 */
export function registerDeleteFilesTool(server: McpServer, store: KitStore): void {
  server.registerTool(
    DELETE_FILES_TOOL_NAME,
    {
      title: "Delete files",
      description: DELETE_FILES_DESCRIPTION,
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
    // M1-13 plan-vs-write guard (DRO-239). The middleware runs BEFORE the
    // delete handler, catching PlanNotFoundError and out-of-plan paths and
    // returning the canonical JSON-RPC `-32602` shape `{ code, message,
    // data: { reason, planId?, path? } }`. The delete-side path-outside-
    // plan branch below is now only reachable for a direct in-process caller
    // (see the "deleteFiles — core behaviour" test suite), which bypasses
    // MCP registration and this middleware with it — kept as defense-in-
    // depth so removing the check from `deleteFiles` doesn't silently open
    // that path for those callers.
    withPlanGuard({ mode: "deletes", pathsKey: "paths" }, async (args) => {
      try {
        const result = await deleteFiles(store, args);
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
          // Ordinarily unreachable at the wire level — the M1-13 plan-guard
          // middleware (above) catches PlanNotFoundError first. Kept as
          // belt-and-suspenders for a future refactor that bypasses the
          // guard or a race where a plan expires between the guard's
          // getPlan and the core's getPlan.
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
    }),
  );
}
