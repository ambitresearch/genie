/**
 * MCP tool: plan (M1-07).
 *
 * The single user-visible permission grant that locks `writes`, `deletes`,
 * and `localDir`. Returns a `planId` that downstream write/delete calls must
 * present. Without a valid `planId`, those verbs are rejected.
 *
 * Input:  { kitId: string, writes: string[], deletes?: string[], localDir?: string }
 * Output: { planId: string }
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createPlan,
  TooManyWritesError,
  TooComplexGlobError,
  MAX_WRITES,
  MAX_WILDCARDS,
} from "../plans/index.js";
import { isSafeKitId } from "../store/kit-files.js";
import { NotFoundError } from "../store/interface.js";

/**
 * The slice of `KitStore` this tool needs: resolve a kit by id, throwing when
 * it does not exist. Narrowed to one method (as `bind_kit`/`get_project` do)
 * so tests can stub it and so `plan` states exactly what it depends on.
 */
export interface PlanKitStore {
  getKit(kitId: string): Promise<unknown>;
}

/** Input schema for plan (Zod v4). */
const inputSchema = {
  // Intentionally NOT `.min(1)`: an empty kitId resolves to no kit, and the
  // handler already answers that with the structured `kitNotFound` envelope
  // (#252) plus its `plan.rejected` audit line. A schema-level minimum would
  // pre-empt both, making the MCP SDK reject `""` at the protocol layer with a
  // generic, non-JSON "MCP error ..." string — the exact failure mode the
  // `writes` field below documents. Type stays `string`; emptiness is a
  // semantic question, so the handler owns it.
  kitId: z.string().describe("The kit ID to create a plan for."),
  // Intentionally NOT `.max(MAX_WRITES)`: a schema-level cap makes the MCP SDK
  // reject oversized arrays at the protocol layer with a generic, non-JSON
  // "MCP error ..." string — before the handler below runs. That would bypass
  // the structured `TooManyWritesError` JSON payload (AC3) and its audit-log
  // line (AC10). `createPlan()` enforces the same limit at runtime instead, so
  // the handler's own try/catch owns the response shape.
  writes: z
    .array(z.string())
    .describe(
      `Array of glob patterns for files that will be written (max ${MAX_WRITES} patterns, ≤${MAX_WILDCARDS} wildcards each).`,
    ),
  deletes: z
    .array(z.string())
    .optional()
    .describe("Optional array of glob patterns for files that will be deleted."),
  localDir: z
    .string()
    .optional()
    .describe(
      "Optional local directory path that uploads may read from. Defaults to current working directory.",
    ),
} as const;

/** Output schema for plan (Zod v4 raw shape) — declared alongside the
 * `structuredContent` return so `tools/list` advertises it, matching the
 * repo-wide convention (see list_kits.ts, get_project.ts, bind_kit.ts). */
const outputSchema = {
  planId: z
    .string()
    .describe("The plan ID that downstream write_files/delete_files calls must present."),
} as const;

/**
 * Build the rejection payload for an unresolvable `kitId`.
 *
 * Deliberately the same envelope the plan guard emits for `planNotFound` /
 * `pathOutsidePlan` (see middleware/plan-guard.ts): a JSON-RPC-shaped
 * `{ code: -32602, message, data: { reason, … } }` with `isError: true`, so a
 * client can branch on `code`/`data.reason` uniformly across the whole
 * plan-scoped write path. Built locally rather than borrowing the guard's
 * helper because `plan` is not a guarded verb — it has no `planId` to resolve,
 * so widening `PlanGuardRejectReason` with a reason the guard can never emit
 * would be the wrong coupling.
 */
function kitNotFoundResult(kitId: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  process.stderr.write(
    JSON.stringify({ event: "plan.rejected", reason: "kitNotFound", kitId }) + "\n",
  );

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          code: -32602,
          message:
            `Kit "${kitId}" does not exist. A plan authorizes writes into a ` +
            `specific kit, so it cannot be issued for one that cannot be resolved.`,
          data: { reason: "kitNotFound", kitId },
        }),
      },
    ],
  };
}

/**
 * Register the `mcp__genie__plan` tool on the given MCP server.
 *
 * `store` is required, not optional: it is what makes the `kitId` check
 * fail-closed. An optional store would silently restore the very defect this
 * validates against (#252). Pass the *same* instance the write verbs use, so
 * `plan` validates against exactly the store that will later be written to.
 */
export function registerPlan(server: McpServer, store: PlanKitStore): void {
  server.registerTool(
    "mcp__genie__plan",
    {
      title: "Plan",
      description:
        "Lock write/delete patterns and localDir for a kit. Returns a planId " +
        "that must be presented to write_files/delete_files. " +
        "Plans expire after 1h of inactivity. Reach for this after conjure/refine returns " +
        "files you want to persist — plan first, then write_files (or delete_files) with " +
        "the returned planId.",
      inputSchema,
      outputSchema,
    },
    async ({
      kitId,
      writes,
      deletes = [],
      localDir,
    }: {
      kitId: string;
      writes: string[];
      deletes?: string[];
      localDir?: string;
    }) => {
      // Validate the kit BEFORE anything else. A plan is a scoped write
      // authorization for one specific kit, and downstream path containment is
      // enforced *relative to that kit* — so an unresolvable kitId weakens the
      // containment guarantee itself, not just the error message. Without this,
      // a typo'd or stale kitId produced a valid planId and `write_files` then
      // created the directory and wrote bytes into it (#252).
      //
      // Checked here rather than in the Zod schema so the failure returns the
      // structured JSON payload below instead of a generic thrown MCP protocol
      // error — the same reasoning the `writes` field documents above.
      //
      // Containment first, via the SHARED store rule. `isSafeKitId` rejects the
      // ids that escape a single-kit namespace — see its docblock for the
      // authoritative set, deliberately not restated here — which is what keeps
      // `getKit`, which resolves a path without re-checking id safety, from
      // reading above the kits root.
      //
      // Deliberately NOT `KIT_ID_PATTERN`. That pattern describes ids *minted by
      // `create_kit`*; `KitId` is documented as an opaque, adapter-assigned
      // string, and `list_kits` promises the ids it returns are valid input
      // here. An imported or git-host kit may legitimately be named `My_Kit.2`
      // or `a` — `read_file` and `list_files` already browse such kits through
      // `isSafeKitId`, so gating `plan` on the stricter pattern would make a
      // resolvable, browsable kit unwritable. Existence is `getKit`'s call, not
      // the charset's.
      if (!isSafeKitId(kitId)) {
        return kitNotFoundResult(kitId);
      }
      try {
        await store.getKit(kitId);
      } catch (err: unknown) {
        // Only a genuine "no such kit" becomes `kitNotFound`. An I/O or
        // transport fault (EACCES here, a network error behind a git-host
        // store) is re-thrown so it surfaces as itself instead of masquerading
        // as a missing kit — still fail-closed, since either way no plan is
        // issued, but honest about which failure actually happened.
        if (err instanceof NotFoundError) {
          return kitNotFoundResult(kitId);
        }
        throw err;
      }

      // Default localDir to cwd
      const resolvedLocalDir = localDir ? resolve(localDir) : process.cwd();

      // Validate that localDir exists AND is a directory. AC5 requires "an
      // existing directory" — a plain existence check would also accept a
      // regular file, silently creating a plan whose localDir is unusable.
      let localDirStat;
      try {
        localDirStat = await stat(resolvedLocalDir);
      } catch {
        localDirStat = null;
      }
      if (!localDirStat || !localDirStat.isDirectory()) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "InvalidLocalDir",
                message: `Local directory "${resolvedLocalDir}" does not exist or is not a directory.`,
              }),
            },
          ],
        };
      }

      try {
        const state = await createPlan(kitId, writes, deletes, resolvedLocalDir);

        // Emit audit log line. MUST go to stderr, never stdout: on the stdio
        // transport (the default when a harness pipes JSON-RPC — see
        // transport.ts), stdout *is* the protocol stream, and a stray
        // console.log line there corrupts every client's message framing.
        process.stderr.write(
          JSON.stringify({
            event: "plan.created",
            kitId,
            planId: state.planId,
            writeCount: writes.length,
            deleteCount: deletes.length,
            timestamp: state.createdAt,
          }) + "\n",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ planId: state.planId }),
            },
          ],
          structuredContent: { planId: state.planId },
        };
      } catch (err: unknown) {
        if (err instanceof TooManyWritesError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "TooManyWritesError",
                  message: err.message,
                  count: err.count,
                  max: MAX_WRITES,
                }),
              },
            ],
          };
        }

        if (err instanceof TooComplexGlobError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "TooComplexGlobError",
                  message: err.message,
                  pattern: err.pattern,
                  wildcardCount: err.wildcardCount,
                  max: MAX_WILDCARDS,
                }),
              },
            ],
          };
        }

        throw err; // unexpected errors bubble up as MCP internal errors
      }
    },
  );
}
