import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ComponentEntry, KitStore } from "../store/interface.js";

export const LIST_COMPONENTS_TOOL_NAME = "mcp__genie__list_components";

export const LIST_COMPONENTS_DESCRIPTION =
  "List components within a kit, optionally filtered by group. Returns an array of component metadata (name, group, path, viewport, hash, lastModified) sorted by group ASC, then name ASC, then path ASC for deterministic ordering. When group is omitted, returns every component across all groups. Returns [] when the kit has no components or the group filter matches nothing. NOTE: Current stub implementation returns [] until M3-03 manifest compiler lands.";

/** Zod shape for a single component entry — reused by `outputSchema`. */
const componentEntryShape = {
  name: z.string(),
  group: z.string(),
  path: z.string(),
  viewport: z.string(),
  hash: z.string(),
  lastModified: z.string(),
};

export interface ListComponentsResult {
  components: ComponentEntry[];
}

export function registerListComponents(
  server: McpServer,
  store: KitStore,
): void {
  server.registerTool(
    LIST_COMPONENTS_TOOL_NAME,
    {
      title: "List components",
      description: LIST_COMPONENTS_DESCRIPTION,
      inputSchema: z
        .object({
          kitId: z.string().describe("The ID of the kit to list components from"),
          group: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Optional group filter. When specified, returns only components in that group. Empty string rejected.",
            ),
        })
        .strict(),
      outputSchema: {
        components: z.array(z.object(componentEntryShape).strict()),
      },
    },
    async ({ kitId, group }: { kitId: string; group?: string }) => {
      const components = await store.listComponents({ kitId, group });
      return {
        content: [{ type: "text", text: JSON.stringify(components) }],
        structuredContent: { components },
      };
    },
  );
}
