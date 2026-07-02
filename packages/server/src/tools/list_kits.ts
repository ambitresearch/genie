import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KitMeta, KitStore } from "../store/interface.js";
import { KIT_TYPE } from "../store/interface.js";

export const LIST_KITS_TOOL_NAME = "mcp__genie__list_kits";

export const LIST_KITS_DESCRIPTION =
  "List the user's writable UI kits. Returns every genie-native kit visible to the current store as an array of { id, name, owner, updatedAt, canEdit }. Filters out records whose stored type is not GENIE_KIT; interop adapters map Anthropic project types separately.";

export interface ListKitsEntry extends Record<string, unknown> {
  id: string;
  name: string;
  owner: string;
  updatedAt: string;
  canEdit: boolean;
}

/** Zod shape for a single `list_kits` entry — reused by `outputSchema`. */
const listKitsEntryShape = {
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
};

type ListableKitMeta = KitMeta & {
  owner?: string;
  updatedAt?: string;
  canEdit?: boolean;
};

export async function listWritableKits(store: KitStore): Promise<ListKitsEntry[]> {
  const kits = (await store.listKits()) as ListableKitMeta[];
  return kits
    .filter((kit) => kit.type === KIT_TYPE)
    .map((kit) => ({
      id: kit.id,
      name: kit.name,
      owner: kit.owner ?? "local",
      updatedAt: kit.updatedAt ?? kit.createdAt,
      canEdit: kit.canEdit ?? true,
    }));
}

export function registerListKits(server: McpServer, store: KitStore): void {
  server.registerTool(
    LIST_KITS_TOOL_NAME,
    {
      title: "List kits",
      description: LIST_KITS_DESCRIPTION,
      inputSchema: z.object({}).strict(),
      outputSchema: {
        kits: z.array(z.object(listKitsEntryShape).strict()),
      },
    },
    async () => {
      const kits = await listWritableKits(store);
      return {
        content: [{ type: "text", text: JSON.stringify(kits) }],
        structuredContent: { kits },
      };
    },
  );
}
