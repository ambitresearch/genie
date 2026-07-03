import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { ProjectStore, registerCreateProjectTool } from "./tools/create_project.js";
import { registerListProjectsTool } from "./tools/list_projects.js";
import { registerGetProjectTool } from "./tools/get_project.js";
import { registerDeleteProjectTool } from "./tools/delete_project.js";
import { registerBindKitTool } from "./tools/bind_kit.js";
import { LocalScaffoldScreenGenerator, registerConjureScreenTool } from "./tools/conjure_screen.js";
import { registerCreateKit } from "./tools/create_kit.js";
import { registerReadFile } from "./tools/read_file.js";
import { registerValidate } from "./tools/validate.js";
import { KitFileStore, registerListFilesTool } from "./tools/list_files.js";
import { registerListKits } from "./tools/list_kits.js";
import { registerListComponents } from "./tools/list_components.js";
import { registerPlan } from "./tools/plan.js";
import { registerDeleteFilesTool } from "./tools/delete_files.js";
import { registerWriteFilesTool } from "./tools/write_files.js";
import { LocalFsKitStore } from "./store/local.js";
import { registerGetKitTool } from "./tools/get_kit.js";

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
  reportsDir?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "genie generates UI components against your own UI kit, inside your coding " +
      "harness. (Scaffold build — the registered tools are ping, kit listing, kit component " +
      "listing, kit creation, kit lookup, file listing, file reading, validation, project " +
      "create/list/get/delete/bind_kit, conjure_screen, plan creation (the capability-grant " +
      "boundary for write/delete verbs), write_files, and delete_files.)",
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

  const projectsRoot =
    options.projectsRoot ??
    process.env.GENIE_PROJECTS_ROOT ??
    join(process.cwd(), ".genie", "projects");
  // Resolve the kits root ONCE so every kit verb agrees on where kits live.
  // `create_kit` (via LocalFsKitStore) writes here, `read_file` reads here, and
  // `list_files` (via KitFileStore) walks here — threading the same value into
  // all of them is what keeps them consistent.
  const kitsRoot =
    options.kitsRoot ?? process.env.GENIE_KITS_ROOT ?? join(process.cwd(), ".genie", "kits");
  // Shared instance: `bind_kit` (via ProjectStore) validates kitId through the
  // same store `create_kit`/`get_kit` already write through, so a kit created
  // in this process is immediately bindable without a second construction.
  const kitStore = new LocalFsKitStore(kitsRoot);

  const projectStore = new ProjectStore(projectsRoot, kitStore);
  registerCreateProjectTool(server, projectStore);
  registerListProjectsTool(server, projectStore);
  registerGetProjectTool(server, projectStore);
  registerDeleteProjectTool(server, projectsRoot);
  registerBindKitTool(server, projectStore);

  // conjure_screen (M1-21): project-aware screen generation. The M1 generator is
  // an offline deterministic scaffold (LocalScaffoldScreenGenerator) — no model
  // call, so it runs in CI unchanged; M2 swaps in the real endpoint client
  // behind the same ScreenGenerator seam. It shares the same projectStore
  // (screen recording) and kitStore (explicit-kitId validation) the project and
  // kit verbs already use.
  registerConjureScreenTool(server, {
    projectStore,
    kitStore,
    generator: new LocalScaffoldScreenGenerator(),
  });

  registerListKits(server, kitStore);
  registerListComponents(server, kitStore);
  registerCreateKit(server, kitStore);
  registerGetKitTool(server, kitStore);

  // M1 tools
  registerReadFile(server, kitsRoot);
  registerListFilesTool(server, new KitFileStore(kitsRoot));

  // Plan capability-grant boundary (M1-07). Locks writes/deletes/localDir and
  // issues a planId; write_files (below) validates every call against it.
  // `plans/index.ts` owns its own persistence root (`${GENIE_HOME}/plans`) and
  // TTL (`GENIE_PLAN_TTL`) internally, so there's no store instance to thread
  // through here — both tools import the same module singleton.
  registerPlan(server);

  // write_files (M1-08): validates planId + writes-glob membership via
  // `plans/index.ts`, then commits atomically. Blocked-by M1-07, now shipped.
  registerWriteFilesTool(server);

  // Advisory telemetry facet (M1-12): persists validation counts + emits
  // Prometheus metrics. No planId required (read-side telemetry).
  registerValidate(
    server,
    options.reportsDir ?? process.env.GENIE_REPORTS_DIR ?? join(process.cwd(), ".genie", "reports"),
  );

  // Plan-gated destructive verb (M1-09): deletes are authorized by a plan's
  // `deletes` globs and hit the SAME kit tree read_file/list_files read
  // (kitsRoot). Shares the M1-07 plan boundary already registered above.
  registerDeleteFilesTool(server, kitsRoot);

  return server;
}
