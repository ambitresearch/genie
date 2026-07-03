import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KitStore } from "../store/interface.js";
import { NotFoundError } from "../store/interface.js";
import { isSafeKitId } from "../store/kit-files.js";

export const LIST_FILES_TOOL_NAME = "mcp__genie__list_files";

const listFilesArgsSchema = z
  .object({
    kitId: z.string().min(1),
  })
  .strict();

const fileEntrySchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    hash: z.string().startsWith("sha256-"),
    lastModified: z.string(),
  })
  .strict();

export type ListFilesArgs = z.infer<typeof listFilesArgsSchema>;
export type ListedFile = z.infer<typeof fileEntrySchema>;

export class ListFilesError extends Error {
  constructor(
    readonly code: "ERR_KIT_NOT_FOUND" | "ERR_INVALID_KIT_ID" | "ERR_INVALID_ARGS",
    message: string,
  ) {
    super(message);
    this.name = "ListFilesError";
  }
}

/**
 * Reject path-shaped kit ids up front (the store also guards, but this keeps the
 * tool's `ERR_INVALID_KIT_ID` contract). Delegates to the shared `isSafeKitId`
 * rule (`store/kit-files.ts`) — the SAME predicate `read_file` and both stores
 * use — so the two tools' kitId defenses cannot silently drift (AC1). The rule
 * rejects the empty string, `.`/`..`, and any `/`/`\\` separator; ids that
 * merely embed dots (`my..kit`) stay a valid single-segment child.
 */
function assertValidKitId(kitId: string): void {
  if (!isSafeKitId(kitId)) {
    throw new ListFilesError("ERR_INVALID_KIT_ID", `Invalid kitId "${kitId}".`);
  }
}

/**
 * List a kit's files as rich entries (path + size + SRI hash + lastModified),
 * through the injected `KitStore` (M1-14a-1a / DRO-540). The store owns the
 * walk, SHA-256 SRI hashing, size/mtime, and the `.genieignore` + default-dir
 * exclusion — so the SAME verb runs against `LocalFsKitStore` (disk) or
 * `GitHostKitStore` (git host). This function owns only arg-shape validation,
 * the kitId guard, and mapping the store's `NotFoundError` onto the tool's
 * `ERR_KIT_NOT_FOUND`.
 */
export async function listFiles(store: KitStore, args: ListFilesArgs): Promise<ListedFile[]> {
  let parsed: ListFilesArgs;
  try {
    parsed = listFilesArgsSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new ListFilesError(
        "ERR_INVALID_ARGS",
        issue?.message ?? "Invalid arguments: expected { kitId: string }.",
      );
    }
    throw error;
  }

  assertValidKitId(parsed.kitId);

  let entries;
  try {
    entries = await store.listFiles(parsed.kitId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ListFilesError("ERR_KIT_NOT_FOUND", `Kit "${parsed.kitId}" not found.`);
    }
    throw error;
  }
  return z.array(fileEntrySchema).parse(entries);
}

export function registerListFilesTool(server: McpServer, store: KitStore): void {
  server.registerTool(
    LIST_FILES_TOOL_NAME,
    {
      title: "List files",
      description:
        "Return the UI kit file tree with kit-root-relative paths, byte sizes, SHA-256 SRI hashes, and modification times.",
      inputSchema: {
        kitId: z.string().min(1),
      },
      outputSchema: {
        files: z.array(fileEntrySchema),
      },
    },
    async (args) => {
      try {
        const result = await listFiles(store, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { files: result },
        };
      } catch (error) {
        if (error instanceof ListFilesError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ code: error.code, message: error.message }),
              },
            ],
          };
        }
        throw error;
      }
    },
  );
}
