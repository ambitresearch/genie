import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/types.js";
import { GENIE_KIT_TYPE } from "../store/types.js";

/**
 * Register the `get_kit` MCP tool.
 *
 * Returns metadata for a single UI kit identified by `kitId`.
 * Throws ProjectNotFoundError (-32602) when the kitId is unknown,
 * and WrongProjectTypeError (-32602) when the project exists but
 * is not of type GENIE_KIT.
 */
export function registerGetKit(server: McpServer, store: KitStore): void {
  server.registerTool(
    "get_kit",
    {
      title: "Get Kit",
      description:
        "Return metadata for a single UI kit. Confirms the kitId resolves " +
        "to a valid genie UI kit.",
      inputSchema: {
        kitId: z.string().describe("The unique identifier of the UI kit to retrieve."),
      },
    },
    async ({ kitId }) => {
      const kit = await store.getKit(kitId);

      if (!kit) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `ProjectNotFoundError: no kit found with id "${kitId}"`,
        );
      }

      if (kit.type !== GENIE_KIT_TYPE) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `WrongProjectTypeError: project "${kitId}" exists but is not a UI kit (type: "${kit.type}")`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: kit.id,
              name: kit.name,
              type: kit.type,
              canEdit: kit.canEdit,
              createdAt: kit.createdAt,
              updatedAt: kit.updatedAt,
            }),
          },
        ],
      };
    },
  );
}
