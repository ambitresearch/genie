import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { ProjectStore, registerCreateProjectTool } from "./tools/create_project.js";
import { registerListProjectsTool } from "./tools/list_projects.js";
import { registerGetProjectTool } from "./tools/get_project.js";
import { registerDeleteProjectTool } from "./tools/delete_project.js";
import { registerBindKitTool } from "./tools/bind_kit.js";
import { LocalScaffoldScreenGenerator, registerConjureScreenTool } from "./tools/conjure_screen.js";
import { registerConjureTool } from "./tools/conjure.js";
import { registerRefineTool } from "./tools/refine.js";
import { registerCreateKit } from "./tools/create_kit.js";
import { registerReadFile } from "./tools/read_file.js";
import { registerValidate } from "./tools/validate.js";
import { registerListFilesTool } from "./tools/list_files.js";
import { registerListKits } from "./tools/list_kits.js";
import { registerListComponents } from "./tools/list_components.js";
import { registerPlan } from "./tools/plan.js";
import { registerDeleteFilesTool } from "./tools/delete_files.js";
import { registerWriteFilesTool } from "./tools/write_files.js";
import {
  MCP_APP_MIME,
  UI_EXTENSION_ID,
  registerPreviewTool,
  type PreviewLocality,
} from "./tools/preview.js";
import { registerGridResource } from "./ui/grid-resource.js";
import { LocalFsKitStore } from "./store/local.js";
import type { KitStore } from "./store/interface.js";
import { registerGetKitTool } from "./tools/get_kit.js";
import type { TransportKind } from "./transport.js";

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
  /**
   * Transport used by an embedder that connects the returned server directly.
   * Pass `"http"` for Streamable HTTP so preview never opens a browser on the
   * server machine. {@link startTransport} records its own resolved kind when
   * the built-in transport launcher is used.
   */
  transportKind?: TransportKind;
  /** Whether the viewer URL is reachable from the host running the MCP client. */
  previewLocality?: PreviewLocality;
  projectsRoot?: string;
  kitsRoot?: string;
  reportsDir?: string;
  /**
   * Injectable kit backend (AC1 / DRO-523; kit-file verbs added in
   * M1-14a-1a / DRO-540). When supplied, the kit verbs route through this store
   * instead of the default `LocalFsKitStore(kitsRoot)`:
   *   - metadata: `create_kit`, `get_kit`, `list_kits`, `list_components`,
   *     plus `conjure_screen`'s explicit-kitId validation and `bind_kit`'s
   *     kit-existence check (via `KitStore.getKit`/`listKits`/`createKit`/…);
   *   - files: `read_file`, `list_files`, `delete_files` (via
   *     `KitStore.readFile`/`listFiles`/`deleteFile`).
   * Defaulting to LocalFs keeps every existing caller (`createServer()`,
   * `createServer({ kitsRoot })`) byte-for-byte unchanged, so injecting a
   * `GitHostKitStore` points the whole kit surface at the git host.
   *
   * Remaining holdout (tracked, deliberately out of scope here): `write_files`
   * still binds to `kitsRoot` + the on-disk plan registry — its atomic
   * rename-to-temp / streaming / rollback transaction doesn't map onto the
   * git-host REST model without its own design, so it is a sibling follow-up.
   * The rich project family (`create_project`/`get_project`/`bind_kit` write
   * side/`recordScreen`) also still uses the concrete fs-backed `ProjectStore`
   * (see `projectStore` below); `delete_project` already routes through it
   * (M1-14a-1 / DRO-531).
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
   * routes through this store too (M1-14a-1 / DRO-531); the kit-file verbs
   * (`read_file`/`list_files`/`delete_files` via DRO-540, and `write_files` via
   * M1-14a-1b / DRO-565) all now route through `kitStore` — no fs-native holdout
   * remains.
   */
  projectStore?: ProjectStore;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      extensions: {
        [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] },
      },
    },
    instructions:
      "genie generates UI components against your own UI kit, inside your coding " +
      "harness. (Scaffold build — the registered tools are ping, kit listing, kit component " +
      "listing, kit creation, kit lookup, file listing, file reading, validation, project " +
      "create/list/get/delete/bind_kit, conjure_screen, conjure (LLM component generation), " +
      "refine (LLM component iteration — diff + updated files against existing kit source), " +
      "plan creation (the capability-grant " +
      "boundary for write/delete verbs), write_files, delete_files, and preview (returns the " +
      "viewer URL + a local-only file:// fallback plus a ui://genie/grid resource pointer in " +
      "_meta.ui.resourceUri). write_files and " +
      "delete_files share one plan-boundary validation middleware — every call is checked " +
      "for planId presence/existence/expiry and per-path glob membership before the tool " +
      "handler runs.)",
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
  // `list_files` walks here — threading the same value into all of them (via the
  // shared kitStore below) is what keeps them consistent.
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

  // conjure (M2-03): genie's headline verb — real LLM component generation
  // against the caller's UI kit. Calls the configured OpenAI-compatible endpoint
  // (M2-01 client) with a COMPONENT_SCHEMA json_schema response_format (M2-02),
  // validates the reply with Ajv, and retries once on a validation failure. Pure
  // generation: it does NOT write files (AC9) and takes no store — the default
  // `chat` seam lazily imports the LLM client only on first call, so registering
  // it here never requires GENIE_LLM_* to be set just to build the server.
  registerConjureTool(server);

  // refine (M2-04): iterate on an existing component. Loads the component's
  // current files from the kit (`kitStore.listFiles`/`readFile`), sends them plus
  // a free-form instruction (and, for a canvas-style edit, an optional region
  // rect rendered as a crop) to the configured endpoint behind the SAME
  // request/validate/retry harness `conjure` uses, and returns a unified diff +
  // the full updated files. The region crop uses Playwright as an OPTIONAL peer
  // dependency (M3-02's validator setup) via a lazy import that degrades
  // gracefully when absent, so registering it here never requires Playwright or
  // GENIE_LLM_* to be set just to build the server.
  registerRefineTool(server, { kitStore });

  registerListKits(server, kitStore);
  registerListComponents(server, kitStore);
  registerCreateKit(server, kitStore);
  registerGetKitTool(server, kitStore);

  // M1 kit-file verbs. Re-plumbed onto the injected `kitStore` (M1-14a-1a /
  // DRO-540): `read_file`, `list_files`, and `delete_files` now route through
  // `KitStore.readFile`/`listFiles`/`deleteFile` instead of a raw `kitsRoot`
  // path, so injecting a `GitHostKitStore` carries these verbs onto the git
  // host too (not just the metadata verbs). The store owns MIME/encoding, the
  // 256 KiB cap, SRI hashing, and `.genieignore`/default-dir exclusion; the
  // tools keep plan-gating (delete_files) and request-shape guards.
  registerReadFile(server, kitStore);
  registerListFilesTool(server, kitStore);

  // Plan capability-grant boundary (M1-07). Locks writes/deletes/localDir and
  // issues a planId; write_files (below) validates every call against it via
  // the M1-13 plan-guard middleware (`middleware/plan-guard.ts`).
  // `plans/index.ts` owns its own persistence root (`${GENIE_HOME}/plans`) and
  // TTL (`GENIE_PLAN_TTL`) internally, so there's no store instance to thread
  // through here — the module singleton is shared across the guard and the
  // plan tool.
  registerPlan(server);

  // write_files (M1-08; store-routed in M1-14a-1b / DRO-565): validates planId +
  // writes-glob membership via the M1-13 plan-guard middleware (one shared seam
  // with delete_files, below), then commits the batch atomically into the kit
  // via the injected `kitStore.writeFiles(plan.kitId, ops)` — the same store the
  // read/list/delete verbs route through. `plan.localDir` is now only the
  // local SOURCE base for `localPath` reads; the kit is the write destination.
  registerWriteFilesTool(server, kitStore);

  // validate (D-A — one verb, two facets):
  //   • Counter-persistence facet (M1-12): persists caller-supplied validation
  //     counts + emits Prometheus metrics. No planId required (read-side).
  //   • Full-scan facet (M3-04 / DRO-260): when called WITHOUT `counts`, walks
  //     every `.html` in the kit through the injected `kitStore` and runs the
  //     @genie-marker / thin-render / variants-identical checks, returning
  //     structured findings and persisting the derived counters via the same
  //     path. The headless render uses Playwright as an OPTIONAL peer dependency
  //     (createDefaultRenderer degrades to marker-only when it is absent), so
  //     registering this here never requires Playwright to build/run the server.
  registerValidate(server, {
    reportsDir:
      options.reportsDir ??
      process.env.GENIE_REPORTS_DIR ??
      join(process.cwd(), ".genie", "reports"),
    kitStore,
  });

  // Plan-gated destructive verb (M1-09): deletes are authorized by a plan's
  // `deletes` globs and hit the SAME kit tree read_file/list_files read (via
  // the shared `kitStore`, M1-14a-1a). Shares the M1-07 plan boundary and the
  // M1-13 plan-guard middleware (`middleware/plan-guard.ts`) with write_files
  // so the two verbs enforce plan authorization through one identical seam.
  registerDeleteFilesTool(server, kitStore);

  // preview (M4-05 / DRO-267): returns local viewer/file URLs only to local
  // clients, and points ui://-capable hosts at the inline `ui://genie/grid`
  // resource (registered by M4-06) via `_meta.ui.resourceUri`. Boots the Vite
  // viewer on demand and reuses it across calls (its own ViewerRegistry),
  // falling back to a local file URL or CSP-safe embedded manifest when needed.
  // Bound to the same `kitsRoot` the kit verbs resolve against so a `kitId`
  // maps to the same on-disk kit dir the viewer serves.
  registerPreviewTool(server, {
    kitsRoot,
    transportKind: options.transportKind,
    locality: options.previewLocality,
  });

  // ui://genie/grid (M4-06 / DRO-268): the embedded MCP-Apps resource the
  // `preview` tool's `_meta.ui.resourceUri` points at. A ui://-capable host
  // (Claude, VS Code ≥Jan 2026, ChatGPT, Cursor) reads this resource and renders
  // the card grid inline in its own sandboxed iframe. The handler compiles the
  // requested kit's manifest (M3-03) and inlines it as
  // `<script type="application/json" id="manifest">` so the iframe — whose CSP
  // is `connect-src 'none'` — needs no fetch. Bound to the same `kitsRoot` as
  // the kit verbs + `preview`, so a `kitId` resolves to the same on-disk kit.
  registerGridResource(server, { kitsRoot });

  return server;
}
