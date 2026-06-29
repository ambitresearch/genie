/**
 * MCP tool: list_files
 *
 * Returns the file tree for a kit with size, SHA-256 hash, and mtime.
 * Used by clients to detect empty vs non-empty kits (drives "atomic vs
 * incremental" upload path) and to confirm post-upload counts.
 *
 * Tool name: `list_files` (exposed as `mcp__genie__list_files` by the MCP
 * protocol namespace).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/index.js";

const inputSchema = {
  kitId: z.string().describe("The kit identifier whose files to list."),
};

/**
 * Register the `list_files` tool on the given MCP server.
 */
export function registerListFiles(server: McpServer, store: KitStore): void {
  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description:
        "Returns the file tree for a kit with path, size, SHA-256 hash, and " +
        "last-modified timestamp. Hidden files are included; node_modules, " +
        ".git, and dist are excluded by default (configurable via .genieignore).",
      inputSchema,
    },
    async ({ kitId }) => {
      const files = await store.listFiles(kitId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(files),
          },
        ],
      };
    },
  );
}
