/**
 * MCP tool: plan (M1-07).
 *
 * The single user-visible permission grant that locks `writes`, `deletes`,
 * and `localDir`. Returns a `planId` that downstream write/delete/register
 * calls must present. Without a valid `planId`, those verbs are rejected.
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

/** Input schema for plan (Zod v4). */
const inputSchema = {
  kitId: z.string().min(1).describe("The kit ID to create a plan for."),
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

/**
 * Register the `mcp__genie__plan` tool on the given MCP server.
 */
export function registerPlan(server: McpServer): void {
  server.registerTool(
    "mcp__genie__plan",
    {
      title: "Plan",
      description:
        "Lock write/delete patterns and localDir for a kit. Returns a planId " +
        "that must be presented to write_files/delete_files/register_assets. " +
        "Plans expire after 1h of inactivity.",
      inputSchema,
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
