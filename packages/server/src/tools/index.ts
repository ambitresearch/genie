import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/interface.js";
import { registerListKitsTool } from "./list_kits.js";

/**
 * Register all genie MCP tools on the server.
 *
 * Each tool lives in its own file under `tools/`. This index wires
 * them into the McpServer during `createServer()`.
 */
export function registerTools(server: McpServer, store: KitStore): void {
  registerListKitsTool(server, store);
}
