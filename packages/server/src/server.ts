import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "./store/interface.js";
import { registerTools } from "./tools/index.js";

/** Server identity. Bumped independently of the workspace version. */
export const SERVER_INFO = {
  name: "genie",
  version: "0.0.0",
} as const;

/** Options accepted by `createServer`. */
export interface CreateServerOptions {
  /** Kit store implementation. When omitted the server boots without kit tools. */
  kitStore?: KitStore;
}

/**
 * Build the genie MCP server.
 *
 * The server negotiates the MCP handshake, advertises capabilities, and
 * registers tools. The built-in `ping` health check is always present.
 * When a `KitStore` is provided the M1 kit tools are also registered:
 *   - M1: genie's 19 core tools (13 kit verbs + 6 project verbs) (`mcp__genie__*`)
 *   - M2: generation tools (conjure, refine) via the configured LLM endpoint
 *   - M3: @genie marker validator + manifest compiler
 *   - M4: the ui://genie/grid MCP-Apps resource + Vite viewer
 *
 * Keeping this a single factory means every transport (stdio, HTTP) shares one
 * registration — see transport.ts.
 */
export function createServer(opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "genie generates UI components against your own UI kit, inside your coding " +
      "harness.",
  });

  // A single built-in tool. Registering it makes the SDK wire up the
  // tools/list + tools/call handlers (they are lazy-initialized on first
  // registration), so capability negotiation is honest from M0 onward.
  // It also gives every harness a trivial "is genie alive?" probe.
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

  if (opts.kitStore) {
    registerTools(server, opts.kitStore);
  }

  return server;
}
