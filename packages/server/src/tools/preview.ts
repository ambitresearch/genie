/**
 * MCP tool: preview (M4-05 / DRO-267).
 *
 * Returns a human-readable summary — the live viewer URL plus a `file://`
 * fallback — as `content`, and points capable hosts at the inline grid via
 * `_meta.ui.resourceUri: "ui://genie/grid?…"`. The four host families that
 * render `ui://` today (Claude, VS Code ≥Jan 2026, ChatGPT, Cursor, plus
 * Goose/Postman/MCPJam) show the inline grid; everyone else falls back to the
 * printed URLs (RFC §8.3, progressive enhancement).
 *
 * ── Contract (RFC §6.2.3 / §8.3; this issue's AC1–AC7) ───────────────────────
 *   input : { kitId, componentName?, group? }                          (AC2)
 *   output: { content: [{ type:"text", text }],
 *             _meta: { ui: { resourceUri: "ui://genie/grid?…" } } }     (AC3/AC4)
 * The `ui://genie/grid` RESOURCE itself is registered by M4-06 — this tool only
 * emits the URI string that references it. `_meta.ui.resourceUri` is emitted
 * UNCONDITIONALLY (a host that can't read it just renders the text); AC7's
 * client sniff is observability only, it never gates the payload.
 *
 * ── Viewer boot seam (AC5/AC6) ───────────────────────────────────────────────
 * Booting the Vite dev server is behind an injectable `ViewerBooter` so the
 * tool has NO hard dependency on `@genie/viewer` or Vite — the server core
 * stays independent of the preview framework (CLAUDE.md; RFC §4). The default
 * booter lazily `import()`s `@genie/viewer` through a NON-LITERAL specifier
 * (so `tsc` never hard-resolves it) and degrades gracefully when it is absent —
 * exactly the OPTIONAL-peer-dependency pattern `refine` uses for Playwright.
 * A failed boot (Vite missing, port unbindable, kit dir invalid) is caught and
 * turned into AC6's `file://<kitDir>/index.html` fallback; `_meta` is still
 * emitted. A `ViewerRegistry` caches one running viewer per kit dir (AC5).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { KIT_ID_PATTERN } from "./get_kit.js";

export const PREVIEW_TOOL_NAME = "mcp__genie__preview";

/** The MCP-Apps resource this tool references (registered by M4-06). */
export const GRID_RESOURCE_BASE = "ui://genie/grid";

/**
 * Vite dev-server default port. Duplicated as a local literal (rather than
 * imported from `@genie/viewer`) so this module carries no build-time edge to
 * the viewer package — the whole point of the lazy boot seam below. Kept in
 * sync with `@genie/viewer`'s `DEFAULT_VIEWER_PORT` (RFC §6.9/§14).
 */
export const DEFAULT_VIEWER_PORT = 5173;

// ─── Client → ui:// capability sniff (AC7) ───────────────────────────────────

/**
 * Substrings that mark a harness known to render `ui://` MCP-Apps resources
 * today (RFC §8.3 / research report §3.4): Claude, VS Code, ChatGPT, Cursor,
 * plus the Goose / Postman / MCPJam trio. Matched case-insensitively as a
 * SUBSTRING because harnesses report varied client names ("Claude Code",
 * "claude-ai", "Visual Studio Code", "openai-chatgpt", …). This list drives an
 * observability LOG only (AC7) — it never gates `_meta.ui.resourceUri`, which
 * is always emitted so a host we don't recognize can still opt to render it.
 */
const UI_HOST_MARKERS = [
  "claude",
  "vscode",
  "visual studio code",
  "chatgpt",
  "openai",
  "cursor",
  "goose",
  "postman",
  "mcpjam",
] as const;

/**
 * True when `clientName` names a harness known to render `ui://` resources.
 * Undefined / empty / unrecognized names → false (AC7's "everyone else").
 */
export function clientSupportsUi(clientName: string | undefined): boolean {
  if (clientName === undefined) return false;
  const lower = clientName.toLowerCase();
  return UI_HOST_MARKERS.some((marker) => lower.includes(marker));
}

// ─── Structured stderr log (never stdout — it IS the stdio JSON-RPC stream) ───

/**
 * Emit one structured audit/telemetry line to stderr. On the stdio transport
 * stdout carries the JSON-RPC frames, so any diagnostic MUST go to stderr —
 * the same convention `plan-guard`, `plan`, and the LLM verbs follow.
 */
function logStderr(payload: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(payload) + "\n");
}

// ─── AC4: resource URI builder ───────────────────────────────────────────────

export interface ResourceUriParams {
  kitId: string;
  componentName?: string;
  group?: string;
}

/**
 * Build the `ui://genie/grid?…` resource URI (AC3/AC4). The query string always
 * carries `kitId` and appends the optional `componentName` / `group` filters in
 * a STABLE order (kitId → componentName → group) so the URI — and thus the
 * resource M4-06 resolves and any cache keyed on it — is deterministic for a
 * given argument set. Values are percent-encoded via `URLSearchParams`.
 */
export function buildResourceUri(params: ResourceUriParams): string {
  const qs = new URLSearchParams();
  qs.set("kitId", params.kitId);
  if (params.componentName !== undefined) qs.set("componentName", params.componentName);
  if (params.group !== undefined) qs.set("group", params.group);
  return `${GRID_RESOURCE_BASE}?${qs.toString()}`;
}

// ─── kitId → kit dir (path safety) ───────────────────────────────────────────

/** A `kitId` that fails the shared `KIT_ID_PATTERN` shape (traversal guard). */
export class InvalidKitIdError extends Error {
  readonly code = "InvalidKitIdError";
  constructor(readonly kitId: string) {
    super(
      `Invalid kitId "${kitId}": must be a 3-64 char lowercase slug ([a-z0-9-]). ` +
        "This guards against path traversal into the kits root.",
    );
    this.name = "InvalidKitIdError";
  }
}

/**
 * Resolve a `kitId` to its on-disk kit directory under `kitsRoot`, rejecting
 * any id that isn't a well-formed slug BEFORE the `join` — an unvalidated id
 * like `../../etc` would otherwise escape the kits root (RFC §10 T-13, the same
 * traversal class `write_files`/`read_file` guard). Only shape is checked here;
 * whether the dir actually exists is the booter's concern (a missing/uncompiled
 * kit surfaces as AC6's `file://` fallback, not a hard tool error).
 */
export function resolveKitDir(kitsRoot: string, kitId: string): string {
  if (!KIT_ID_PATTERN.test(kitId)) {
    throw new InvalidKitIdError(kitId);
  }
  return join(kitsRoot, kitId);
}

// ─── Viewer boot seam (AC5/AC6) ──────────────────────────────────────────────

/** A request to boot (or reuse) a viewer for one kit directory. */
export interface BootRequest {
  /** Absolute kit directory the viewer serves as its Vite root. */
  kitDir: string;
  /** Requested dev-server port; the booter may fall back to the next free one. */
  port?: number;
}

/** A running viewer the registry hands back to the tool. */
export interface BootedViewer {
  /** The browsable preview URL (what the text content advertises). */
  url: string;
  /** The port the viewer actually bound. */
  port: number;
  /** Tear the viewer down (used by {@link ViewerRegistry.closeAll}). */
  close: () => Promise<void>;
}

/** Boots a viewer for a kit dir, or rejects if it cannot (→ AC6 fallback). */
export type ViewerBooter = (req: BootRequest) => Promise<BootedViewer>;

/**
 * Caches one running viewer per kit directory so repeated `preview` calls reuse
 * it instead of booting a fresh Vite each time (AC5). Keyed on the resolved kit
 * dir; concurrent calls for the same dir share ONE in-flight boot (the promise
 * is cached, not just the resolved value). A boot that REJECTS is evicted so a
 * later call retries rather than replaying the dead promise forever.
 */
export class ViewerRegistry {
  private readonly viewers = new Map<string, Promise<BootedViewer>>();

  constructor(private readonly booter: ViewerBooter) {}

  /**
   * Return the viewer for `kitDir`, booting it on first request. Subsequent
   * calls for the same dir return the cached (in-flight or resolved) promise.
   */
  ensure(kitDir: string, port = DEFAULT_VIEWER_PORT): Promise<BootedViewer> {
    const existing = this.viewers.get(kitDir);
    if (existing !== undefined) return existing;

    const booting = this.booter({ kitDir, port }).catch((error: unknown) => {
      // Evict the failed boot so the next call retries with a fresh attempt
      // rather than being handed this same rejected promise (AC5 durability).
      this.viewers.delete(kitDir);
      throw error;
    });
    this.viewers.set(kitDir, booting);
    return booting;
  }

  /** Tear down every booted viewer (best-effort). For clean shutdown/tests. */
  async closeAll(): Promise<void> {
    const handles = Array.from(this.viewers.values());
    this.viewers.clear();
    await Promise.allSettled(
      handles.map(async (p) => {
        const viewer = await p;
        await viewer.close();
      }),
    );
  }
}

// ─── Default (production) booter: lazy @genie/viewer, graceful degradation ────
//
// `@genie/viewer` is an OPTIONAL peer (a workspace devDependency here) — the
// server core must not hard-depend on the preview framework (CLAUDE.md; RFC
// §4). Loaded through a NON-LITERAL specifier so `tsc` doesn't resolve it at
// build; when it (or Vite) is absent, or the boot throws, the rejection flows
// up to `runPreview` and becomes AC6's `file://` fallback. Structural types are
// declared locally rather than imported, so this file carries no type edge to
// the viewer package either — same shape as `refine.ts`'s Playwright seam.

interface ViewerCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

interface ViewerHandleLike {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface ViewerModuleLike {
  bootViewer: (
    options: { root: string; port: number; open: boolean },
    io: ViewerCliIo,
  ) => Promise<ViewerHandleLike>;
}

/**
 * The default `ViewerBooter`. Lazily loads `@genie/viewer` and boots its Vite
 * dev server against the kit dir with `open:false` (a headless server must
 * never try to pop a browser) and ALL of the viewer's own stdout routed to
 * STDERR — on the stdio transport the tool's stdout is the JSON-RPC stream, so
 * the viewer's `Preview:` banner would corrupt framing if left on stdout.
 */
export const defaultViewerBooter: ViewerBooter = async ({ kitDir, port }) => {
  // Non-literal specifier: keeps `tsc` from resolving the optional dep at build.
  const specifier = "@genie/viewer";
  let mod: ViewerModuleLike;
  try {
    mod = (await import(specifier)) as ViewerModuleLike;
  } catch (error) {
    logStderr({
      event: "preview.viewer.unavailable",
      reason: "viewer-package-not-installed",
      error: String(error),
    });
    throw error;
  }

  // Route the viewer's stdout to stderr; keep its stderr on stderr.
  const io: ViewerCliIo = {
    stdout: (chunk) => process.stderr.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  };
  const handle = await mod.bootViewer(
    { root: kitDir, port: port ?? DEFAULT_VIEWER_PORT, open: false },
    io,
  );
  return { url: handle.url, port: handle.port, close: () => handle.close() };
};

// ─── Core: runPreview ────────────────────────────────────────────────────────

/** Injected collaborators for {@link runPreview} (kits location + viewer cache). */
export interface PreviewDeps {
  kitsRoot: string;
  registry: ViewerRegistry;
}

/** The three-field tool input (AC2). */
export interface PreviewArgs {
  kitId: string;
  componentName?: string;
  group?: string;
}

/** Per-request context sniffed off the wire (AC7). */
export interface PreviewContext {
  clientName?: string;
}

/** The tool's return shape (AC3): text URLs + the ui:// resource pointer. */
export interface PreviewResult {
  content: { type: "text"; text: string }[];
  _meta: { ui: { resourceUri: string } };
}

/**
 * Core `preview` logic (exported for direct unit testing without the MCP
 * transport). Resolves the kit dir, tries to boot/reuse the viewer, and builds
 * the text summary — the live URL when the viewer is up (AC5), else a
 * `file://` fallback (AC6). `_meta.ui.resourceUri` is emitted either way
 * (AC3/AC4), and one `preview.request` line is logged recording the client and
 * its `ui://` support (AC7).
 */
export async function runPreview(
  deps: PreviewDeps,
  args: PreviewArgs,
  ctx: PreviewContext,
): Promise<PreviewResult> {
  // Path-safety BEFORE anything touches the filesystem or boots a server.
  const kitDir = resolveKitDir(deps.kitsRoot, args.kitId);

  const resourceUri = buildResourceUri({
    kitId: args.kitId,
    componentName: args.componentName,
    group: args.group,
  });

  const uiSupported = clientSupportsUi(ctx.clientName);
  // AC7 — one structured line per request; the sniffed client + its ui:// support.
  logStderr({
    event: "preview.request",
    kitId: args.kitId,
    client: ctx.clientName ?? null,
    uiSupported,
    ...(args.group !== undefined ? { group: args.group } : {}),
    ...(args.componentName !== undefined ? { componentName: args.componentName } : {}),
  });

  const fileUrl = pathToFileURL(join(kitDir, "index.html")).href;

  let text: string;
  try {
    const viewer = await deps.registry.ensure(kitDir, DEFAULT_VIEWER_PORT); // AC5
    text = `Preview running at ${viewer.url}\n` + `Or open the kit directly: ${fileUrl}`;
  } catch (error) {
    // AC6 — the viewer could not boot (Vite/@genie/viewer absent, port
    // unbindable, …). Degrade to the file:// vehicle; still emit _meta so a
    // ui:// host can render the inline grid regardless.
    logStderr({
      event: "preview.fallback",
      kitId: args.kitId,
      reason: "viewer-boot-failed",
      error: String(error),
    });
    text =
      `Preview viewer could not start; open the kit directly: ${fileUrl}\n` +
      "(Start the genie viewer manually, or a ui://-capable host can render the inline grid.)";
  }

  return { content: [{ type: "text", text }], _meta: { ui: { resourceUri } } };
}

// ─── MCP registration ────────────────────────────────────────────────────────

const previewInputSchema = {
  kitId: z
    .string()
    .regex(KIT_ID_PATTERN)
    .describe("The kit to preview (a genie kitId — lowercase slug)."),
  componentName: z
    .string()
    .min(1)
    .optional()
    .describe("Optional single-component focus; carried into the ui:// resource query."),
  group: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional group filter; carried into the ui:// resource query. Empty string rejected.",
    ),
} as const;

/** Options for {@link registerPreviewTool}. `booter` defaults to the lazy one. */
export interface PreviewToolOptions {
  kitsRoot: string;
  /** Injectable for tests; production uses {@link defaultViewerBooter}. */
  booter?: ViewerBooter;
}

/**
 * Extract the requesting harness's client name from `params._meta.client.name`
 * (AC7). MCP's `RequestMeta` is a loose object, so this custom key survives to
 * the handler's `extra._meta`. Defensive about shape — any missing/oddly-typed
 * level yields `undefined` (→ treated as a non-ui:// host).
 */
function sniffClientName(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const client = (meta as { client?: unknown }).client;
  if (typeof client !== "object" || client === null) return undefined;
  const name = (client as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Register `mcp__genie__preview`. One {@link ViewerRegistry} is created per
 * registration and shared across every call so viewers are reused (AC5). The
 * handler reads the client name off `extra._meta` (AC7) and delegates to
 * {@link runPreview}.
 */
export function registerPreviewTool(server: McpServer, options: PreviewToolOptions): void {
  const registry = new ViewerRegistry(options.booter ?? defaultViewerBooter);
  const deps: PreviewDeps = { kitsRoot: options.kitsRoot, registry };

  server.registerTool(
    PREVIEW_TOOL_NAME,
    {
      title: "Preview kit",
      description:
        "Preview a UI kit as a live card grid. Returns the viewer URL (booting the " +
        "Vite viewer on demand and reusing it across calls) plus a file:// fallback, " +
        "and points ui://-capable hosts (Claude, VS Code, ChatGPT, Cursor) at the " +
        "inline grid via _meta.ui.resourceUri. Optionally focus one component or group.",
      inputSchema: previewInputSchema,
    },
    async (args: PreviewArgs, extra: { _meta?: unknown }) => {
      const clientName = sniffClientName(extra._meta);
      const result = await runPreview(deps, args, { clientName });
      return {
        content: result.content,
        _meta: result._meta,
      };
    },
  );
}
