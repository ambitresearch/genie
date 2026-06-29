/**
 * Tool registration barrel.
 *
 * Each tool module exports a `register*` function that takes the MCP server
 * and the stores it needs. This module wires them all up.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectStore } from "../store/interface.js";
import { registerListProjects } from "./list_projects.js";

export interface ToolDeps {
  projectStore: ProjectStore;
}

/** Register all M1 tools on the server. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerListProjects(server, deps.projectStore);
}
