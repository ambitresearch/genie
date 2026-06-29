import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/types.js";
import { registerGetKit } from "./get_kit.js";

/**
 * Register all genie MCP tools on the server.
 *
 * Each tool lives in its own file and exports a `register*` function.
 * This barrel calls them all — keeps server.ts short and makes it easy
 * to add tools in later milestones.
 */
export function registerTools(server: McpServer, store: KitStore): void {
  registerGetKit(server, store);
}
