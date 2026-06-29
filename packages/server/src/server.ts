import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectStore } from "./store/interface.js";
import { InMemoryProjectStore } from "./store/memory.js";
import { registerTools } from "./tools/index.js";

/** Server identity. Bumped independently of the workspace version. */
export const SERVER_INFO = {
  name: "genie",
  version: "0.0.0",
} as const;

/** Options accepted by `createServer`. */
export interface ServerOptions {
  /** Project store to use. Defaults to an empty InMemoryProjectStore. */
  projectStore?: ProjectStore;
}

/**
 * Build the genie MCP server.
 *
 * M0 shipped an empty but bootable server; M1 adds the core tools.
 * Currently registered:
 *   - `ping` — built-in health check
 *   - `list_projects` — project discovery (M1-16)
 *
 * Keeping this a single factory means every transport (stdio, HTTP) shares one
 * registration — see transport.ts.
 */
export function createServer(opts: ServerOptions = {}): McpServer {
  const projectStore = opts.projectStore ?? new InMemoryProjectStore();

  const server = new McpServer(SERVER_INFO, {
    instructions:
      "genie generates UI components against your own UI kit, inside your coding " +
      "harness. Use list_projects to discover workspaces and blueprints.",
  });

  // Built-in health check — also ensures the SDK wires up tools/list +
  // tools/call handlers (they are lazy-initialized on first registration).
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Health check — returns 'pong' and the server version. Confirms genie is " +
        "connected and responding.",
      inputSchema: {},
    },
    () => ({
      content: [
        {
          type: "text",
          text: `pong — ${SERVER_INFO.name} ${SERVER_INFO.version}`,
        },
      ],
    }),
  );

  // Register M1 tools.
  registerTools(server, { projectStore });

  return server;
}
