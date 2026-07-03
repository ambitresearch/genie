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
import type { KitStore } from "./store/interface.js";
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
  /**
   * Injectable kit-metadata backend (AC1 / DRO-523). When supplied, the
   * kit-*metadata* verbs — `create_kit`, `get_kit`, `list_kits`,
   * `list_components`, and `conjure_screen`'s explicit-kitId validation, plus
   * `bind_kit`'s kit-existence check — route through this store instead of the
   * default `LocalFsKitStore(kitsRoot)`. Defaulting to LocalFs keeps every
   * existing caller (`createServer()`, `createServer({ kitsRoot })`) byte-for-
   * byte unchanged.
   *
   * IMPORTANT — partial seam (tracked, see below). This injects ONLY the
   * `KitStore`-interface consumers. The file-content verbs (`read_file`,
   * `list_files`, `write_files`, `delete_files`) and the whole rich project
   * family (`create_project`/`get_project`/`bind_kit` write side/
   * `delete_project`/`recordScreen`) still bind to `kitsRoot`/`projectsRoot`
   * filesystem paths and the on-disk plan registry — they were never written
   * against the `KitStore`/`ProjectStore` interfaces. So injecting a
   * `GitHostKitStore` today makes the metadata verbs talk to the git host while
   * the file/project verbs still hit local disk (a deliberately-scoped split).
   * Re-plumbing those verbs onto the store interfaces — and building a rich
   * `GitHostProjectStore` — is the real remainder of the end-to-end AC5 walk
   * and is tracked as its own follow-up issue(s), kept out of this seam PR so
   * the fs-native tool contracts (atomic rename, streaming, base64/MIME, SHA
   * hashes) aren't rewritten under a test-only change.
   */
  kitStore?: KitStore;
  /**
   * Injectable project backend (AC1 / DRO-523). When supplied, the project
   * family (`create_project`, `list_projects`, `get_project`, `bind_kit`, and
   * `conjure_screen`'s project read/record) route through this store instead of
   * the default `new ProjectStore(projectsRoot, kitStore)`. Defaulting to the
   * LocalFs-backed `ProjectStore` keeps every existing caller unchanged.
   *
   * Same partial-seam caveat as `kitStore`: this is the concrete
   * fs-backed `ProjectStore` class (create_project.ts), which owns blueprints,
   * kitBindings, screens, and `canEdit` — capabilities the thin
   * `GitHostProjectStore` in the store layer does NOT yet implement. So a
   * git-host project backend that satisfies the full tool-surface contract is
   * still to-build (tracked follow-up); this seam is what lets it be dropped in
   * once it exists, and lets tests substitute a fake. `delete_project` now
   * routes through this store too (M1-14a-1 / DRO-531); the remaining holdouts
   * are the fs-native kit-file verbs (`read_file`/`list_files`/`delete_files`),
   * which still bind to `kitsRoot` (see `kitStore` above).
   */
  projectStore?: ProjectStore;
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
  //
  // AC1 (DRO-523): an injected `options.kitStore` overrides the default so an
  // in-process MCP walk can be pointed at `GitHostKitStore` (or any KitStore).
  // Absent injection, this is exactly the pre-seam `new LocalFsKitStore(kitsRoot)`.
  const kitStore = options.kitStore ?? new LocalFsKitStore(kitsRoot);

  // AC1 (DRO-523): an injected `options.projectStore` overrides the default so
  // the project family can be pointed at an alternate backend. Absent injection
  // this is exactly the pre-seam `new ProjectStore(projectsRoot, kitStore)` —
  // sharing the same `kitStore` above so `bind_kit`/`conjure_screen` validate
  // kitIds through the store `create_kit` writes to.
  const projectStore = options.projectStore ?? new ProjectStore(projectsRoot, kitStore);
  registerCreateProjectTool(server, projectStore);
  registerListProjectsTool(server, projectStore);
  registerGetProjectTool(server, projectStore);
  // delete_project (M1-14a-1 / DRO-531): routes through the injected
  // `projectStore` — the same instance the rest of the project family uses —
  // instead of a raw `projectsRoot` path, so a non-LocalFs backend reaches this
  // verb too. Persistence + read-only policy live in `ProjectStore.deleteProject`.
  registerDeleteProjectTool(server, projectStore);
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
