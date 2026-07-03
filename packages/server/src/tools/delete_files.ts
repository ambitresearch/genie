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
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPlan, pathMatchesGlobs, PlanNotFoundError } from "../plans/index.js";

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
 * Reject any path containing a `.` or `..` segment (on either separator).
 *
 * `pathMatchesGlobs` checks the RAW request string, but deletion resolves it
 * (`resolve(kitRoot, path)`). Those two views can disagree: a dot-segment input
 * like `allowed/../secret.txt` matches a glob such as `allowed/../*.txt` yet
 * resolves to `kitRoot/secret.txt` — a file the plan never meant to authorize.
 * (Plain `allowed/**` does not match it under micromatch's default handling of
 * `..`, but relying on that incidental behaviour is brittle across micromatch
 * versions and glob shapes.) Normalizing dot-segments away *before* both the
 * glob check and the resolve makes plan gating depend only on the literal
 * authorized path — never on how micromatch or `path.resolve` treats traversal.
 * Mirrors the read side, where `read_file` rejects a `kitId` containing `..`.
 */
function hasDotSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
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
  const resolvedKitsRoot = resolve(kitsRoot);
  const kitRoot = resolve(resolvedKitsRoot, plan.kitId);

  // 2a. Defense in depth: `plan` accepts `kitId: z.string().min(1)` with no
  //     traversal guard (unlike read_file's kitId check) and createPlan stores
  //     it verbatim, so a plan authored with e.g. `kitId: ".."` resolves a
  //     kitRoot OUTSIDE kitsRoot. Every per-path containment check below is
  //     computed relative to kitRoot, so an escaped kitRoot would let in-bounds
  //     paths unlink files outside the kit tree. As the first destructive
  //     consumer, verify kitRoot stays within kitsRoot before deleting anything.
  const kitRel = relative(resolvedKitsRoot, kitRoot);
  const kitRootEscapes = kitRel === ".." || kitRel.startsWith(`..${sep}`) || isAbsolute(kitRel);
  if (kitRootEscapes) {
    throw new DeleteFilesError(
      "PathOutsidePlanError",
      `Plan kitId "${plan.kitId}" resolves outside the kits root.`,
      plan.kitId,
    );
  }

  // 3. De-duplicate while preserving first-seen order — a path repeated in the
  //    request must not appear twice in the result, nor in both result arrays.
  const uniquePaths = [...new Set(parsed.paths)];

  // 4. Atomic pre-flight (AC3). EVERY path must both (a) match a `deletes` glob
  //    and (b) stay inside the kit root. If any path fails, throw before
  //    deleting anything — so an out-of-plan path can never take an in-plan
  //    sibling down with it. A traversal path is, by definition, outside the
  //    plan → the same PathOutsidePlanError.
  for (const path of uniquePaths) {
    // 4a. Normalize-first defense: a `.`/`..` segment lets the raw-string glob
    //     check and the resolved unlink target disagree (see hasDotSegment).
    //     Reject before matching so gating never depends on how micromatch or
    //     path.resolve treats traversal.
    if (hasDotSegment(path)) {
      throw new DeleteFilesError(
        "PathOutsidePlanError",
        `Path "${path}" contains a "." or ".." segment.`,
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
    const target = resolve(kitRoot, path);
    const rel = relative(kitRoot, target);
    const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (escapes) {
      throw new DeleteFilesError(
        "PathOutsidePlanError",
        `Path "${path}" resolves outside the kit root.`,
        path,
      );
    }
  }

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
