import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/interface.js";
import { KIT_TYPE_GENIE } from "../store/interface.js";

/**
 * Register the `list_kits` MCP tool on the server.
 *
 * Returns the user's writable UI kits, filtered to `type === "GENIE_KIT"`.
 * Interop adapters map Anthropic's `PROJECT_TYPE_DESIGN_SYSTEM` separately.
 *
 * AC1: Tool name is `list_kits` (the MCP SDK exposes it as `mcp__genie__list_kits`
 *       when Claude applies the harness rewrite rule on `server.name`).
 * AC2: Description ≤ 2 KB.
 * AC3: JSON Schema is Draft 7 — no `anyOf` / `$ref`.
 * AC4: Returns `{ id, name, owner, updatedAt, canEdit }[]`.
 * AC5: Filters by `type === "GENIE_KIT"`.
 * AC6: Returns `[]` when the user has no kits.
 * AC7: Backed by `KitStore.listKits()`.
 */
export function registerListKitsTool(server: McpServer, store: KitStore): void {
  server.registerTool(
    "list_kits",
    {
      title: "List UI Kits",
      description:
        "List the user's writable UI kits. Returns an array of kit summaries " +
        "with id, name, owner, updatedAt (ISO 8601), and canEdit fields. " +
        "Only genie-native kits are included; interop adapters handle " +
        "Anthropic project-type mapping separately.",
      inputSchema: {},
    },
    async () => {
      const allKits = await store.listKits();
      const filtered = allKits
        .filter((k) => k.type === KIT_TYPE_GENIE)
        .map(({ id, name, owner, updatedAt, canEdit }) => ({
          id,
          name,
          owner,
          updatedAt,
          canEdit,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered),
          },
        ],
      };
    },
  );
}
