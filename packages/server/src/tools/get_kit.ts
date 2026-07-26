import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KitMeta, KitStore } from "../store/interface.js";
import { NotFoundError, KIT_TYPE } from "../store/interface.js";
import { isSafeKitId, KIT_ID_SAFETY_MESSAGE } from "../store/kit-files.js";

export const GET_KIT_TOOL_NAME = "mcp__genie__get_kit";

/** Shape every `kitId` produced by `buildKitId` (create_kit.ts) satisfies: a
 * lowercase slug plus a 6-char hex suffix.
 *
 * This describes what `create_kit` MINTS. It is deliberately NOT an input gate:
 * `KitId` is an opaque, adapter-assigned string, and `list_kits` promises the
 * ids it returns are valid input to every kit-taking verb. A git-host kit maps
 * its id to a repo name (uppercase, `_`, `.` and single chars are all legal
 * there) and an imported kit directory is listable under any containment-safe
 * name, so `My_Kit.2` is a legitimate kitId this pattern would reject. Gate
 * INPUT on `isSafeKitId` — the shared kit-id safety rule the store adapters
 * apply on their path-taking operations. What that rule refuses is stated once,
 * in its docblock in kit-files.ts; a summary here is a second copy free to drift
 * from it, and has. Note that `getKit` is NOT one of those operations:
 * `LocalFsKitStore.getKit` joins through `kitDir`, not
 * `safeKitDir`, and `GitHostKitStore.getKit` only `encodeURIComponent`s the id,
 * so the schema below is the ONLY check in front of this verb's lookup. Leave
 * the pattern to assert the shape of ids we generate ourselves. */
export const KIT_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

const getKitArgsSchema = z
  .object({
    kitId: z.string().refine(isSafeKitId, KIT_ID_SAFETY_MESSAGE),
  })
  .strict();

const getKitResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.literal(KIT_TYPE),
    createdAt: z.string(),
  })
  .strict();

export type GetKitResult = z.infer<typeof getKitResultSchema>;

export class ProjectNotFoundError extends Error {
  constructor(readonly kitId: string) {
    super(`Project "${kitId}" was not found.`);
    this.name = "ProjectNotFoundError";
  }
}

export class WrongProjectTypeError extends Error {
  constructor(
    readonly kitId: string,
    readonly actualType: string,
  ) {
    super(`Project "${kitId}" is "${actualType}", not "${KIT_TYPE}".`);
    this.name = "WrongProjectTypeError";
  }
}

export function registerGetKitTool(server: McpServer, store: KitStore): void {
  server.registerTool(
    GET_KIT_TOOL_NAME,
    {
      title: "Get kit",
      description:
        "Return metadata for one writable UI kit and verify the kitId resolves to a GENIE_KIT. " +
        "Useful to confirm a kitId (e.g. from list_kits) is valid and writable before " +
        "generating or binding against it.",
      inputSchema: {
        kitId: z.string().refine(isSafeKitId, KIT_ID_SAFETY_MESSAGE),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        type: z.literal(KIT_TYPE),
        createdAt: z.string(),
      },
    },
    async (args) => {
      try {
        const result = await getKit(store, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ProjectNotFoundError || error instanceof WrongProjectTypeError) {
          throw new McpError(ErrorCode.InvalidParams, error.name, {
            code: error.name,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}

export async function getKit(store: KitStore, args: unknown): Promise<GetKitResult> {
  const { kitId } = getKitArgsSchema.parse(args);
  let kit: KitMeta;
  try {
    kit = await store.getKit(kitId);
  } catch (error) {
    if (error instanceof NotFoundError) throw new ProjectNotFoundError(kitId);
    throw error;
  }

  if (kit.type !== KIT_TYPE) {
    throw new WrongProjectTypeError(kitId, kit.type);
  }

  return getKitResultSchema.parse({
    id: kit.id,
    name: kit.name,
    type: KIT_TYPE,
    createdAt: kit.createdAt,
  });
}
