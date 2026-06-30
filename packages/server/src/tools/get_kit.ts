import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KitMeta, KitStore } from "../store/interface.js";
import { NotFoundError } from "../store/interface.js";

export const GET_KIT_TOOL_NAME = "mcp__genie__get_kit";
export const GENIE_KIT_TYPE = "GENIE_KIT" as const;

const getKitArgsSchema = z
  .object({
    kitId: z.string().min(1),
  })
  .strict();

const getKitResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.literal(GENIE_KIT_TYPE),
    canEdit: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
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
    super(`Project "${kitId}" is "${actualType}", not "${GENIE_KIT_TYPE}".`);
    this.name = "WrongProjectTypeError";
  }
}

export function registerGetKitTool(server: McpServer, store: KitStore): void {
  server.registerTool(
    GET_KIT_TOOL_NAME,
    {
      title: "Get kit",
      description:
        "Return metadata for one writable UI kit and verify the kitId resolves to a GENIE_KIT.",
      inputSchema: {
        kitId: z.string().min(1),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        type: z.literal(GENIE_KIT_TYPE),
        canEdit: z.boolean(),
        createdAt: z.string(),
        updatedAt: z.string(),
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

  if (kit.type !== GENIE_KIT_TYPE) {
    throw new WrongProjectTypeError(kitId, kit.type);
  }

  return getKitResultSchema.parse({
    id: kit.id,
    name: kit.name,
    type: GENIE_KIT_TYPE,
    canEdit: kit.canEdit,
    createdAt: kit.createdAt,
    updatedAt: kit.updatedAt,
  });
}
