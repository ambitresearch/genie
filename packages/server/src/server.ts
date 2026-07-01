import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import {
  ProjectStore,
  registerCreateProjectTool,
} from "./tools/create_project.js";
import { registerCreateKit } from "./tools/create_kit.js";
import { registerReadFile } from "./tools/read_file.js";
import { LocalFsKitStore } from "./store/local.js";

/** Server identity. Bumped independently of the workspace version. */
export const SERVER_INFO = {
  name: "genie",
  version: "0.0.0",
} as const;

/**
 * Build the genie MCP server.
 *
 * M0 ships an *empty but bootable* server: it negotiates the MCP handshake,
 * advertises capabilities, and answers `tools/list` — but the only tool is a
 * built-in `ping` health check. The real surfaces arrive in later milestones:
 *   - M1: genie's 19 core tools (13 kit verbs + 6 project verbs) (`mcp__genie__*`)
 *   - M2: generation tools (conjure, refine) via the configured LLM endpoint
 *   - M3: @genie marker validator + manifest compiler
 *   - M4: the ui://genie/grid MCP-Apps resource + Vite viewer
 *
 * Keeping this a single factory means every transport (stdio, HTTP) shares one
 * registration — see transport.ts.
 */
export interface CreateServerOptions {
  projectsRoot?: string;
  kitsRoot?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "genie generates UI components against your own UI kit, inside your coding " +
      "harness. (Scaffold build — project creation and the built-in ping tool are registered so far.)",
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

  registerCreateProjectTool(
    server,
    new ProjectStore(
      options.projectsRoot ??
        process.env.GENIE_PROJECTS_ROOT ??
        join(process.cwd(), ".genie", "projects"),
    ),
  );

  // Resolve the kits root ONCE so every kit verb agrees on where kits live.
  // `create_kit` (via LocalFsKitStore) writes here and `read_file` reads here —
  // threading the same value into both is what keeps them consistent.
  const kitsRoot =
    options.kitsRoot ??
    process.env.GENIE_KITS_ROOT ??
    join(process.cwd(), ".genie", "kits");

  registerCreateKit(server, new LocalFsKitStore(kitsRoot));

  // M1 tools
  registerReadFile(server, kitsRoot);

  return server;
}
