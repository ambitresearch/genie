/**
 * `withPlanGuard` — centralised plan-vs-write guard middleware (M1-13,
 * DRO-239).
 *
 * BEFORE this file, every plan-gated verb (`write_files`, `delete_files`) had
 * to reimplement the same four checks — planId presence, planId existence,
 * planId expiry, and per-path glob membership. When they drifted (as they
 * already had: `write_files` split path-outside-plan into `"glob"` vs
 * `"escapesLocalDir"` sub-reasons while `delete_files` used a single message,
 * and only `plan.ts` emitted a structured audit log), a request that would be
 * rejected by one verb could slip through another with the same shape.
 *
 * This middleware makes the guard one seam: every plan-gated tool wraps its
 * handler in `withPlanGuard(...)`, and the four checks (AC2 (a)–(d)) live
 * here, produce one canonical JSON-RPC `-32602 InvalidParams`-shaped payload
 * (AC3), and emit one canonical `plan.guard.reject` audit line (AC6). The
 * refactored write/delete tools stop re-implementing these checks entirely.
 *
 * Tool-side error taxonomies (e.g. `write_files`' `PayloadTooLargeError`,
 * `delete_files`' `DeleteFailed`) stay in the tools — this middleware only
 * owns the plan-boundary check, matching the issue's scope ("one middleware
 * so every write/delete/register/unregister call funnels through identical
 * validation"), and stops at that boundary so tools remain responsible for
 * their own downstream error shapes.
 */
import { getPlan, pathMatchesGlobs, PlanNotFoundError, type PlanState } from "../plans/index.js";

/**
 * Reasons the guard can reject a call, in the enum shape mandated by AC3
 * (`data.reason` is a client-consumable string). Kept intentionally coarse:
 * a client should be able to branch on this without knowing the guard's
 * internals. The order here matches the order the guard performs its checks
 * (see `withPlanGuard`), which is also the order they short-circuit in.
 */
export type PlanGuardRejectReason =
  /** AC2(a) — `planId` was missing, empty, or not a string. */
  | "planIdMissing"
  /**
   * AC2(b)+(c) — `planId` was well-formed but the plan doesn't exist, or
   * has expired. Both surface identically because the underlying plan
   * registry (`plans/index.ts`) already collapses them into a single
   * `PlanNotFoundError` — there is no separate `PlanExpiredError` for the
   * middleware to distinguish, and shipping two reasons here for what the
   * registry treats as one state would just push clients to guess which one
   * they got.
   */
  | "planNotFound"
  /**
   * AC2(d) — a path in the request doesn't match any glob in the plan's
   * `writes` (mode `"writes"`) or `deletes` (mode `"deletes"`) list.
   */
  | "pathOutsidePlan";

/**
 * The guard operates in one of two modes: it checks paths against either the
 * plan's `writes` or its `deletes` glob list. This is a discriminator on the
 * middleware options — not a runtime toggle on a single "check either" mode,
 * because a `write_files` call must NOT be authorised by a `deletes` glob
 * (and vice versa; a plan's two glob lists are strictly separate). Encoding
 * this as an option, rather than inferring it from the tool name, keeps the
 * middleware tool-agnostic and locks the strict separation as a per-call
 * choice.
 */
export type PlanGuardMode = "writes" | "deletes";

/**
 * Options controlling how the guard extracts paths from a given tool call.
 *
 * The two shipping consumers name their path list differently:
 *   - `write_files` uses `{ files: [{ path, … }] }` (default when `mode: "writes"`)
 *   - `delete_files` uses `{ paths: [] }`             (default when `mode: "deletes"`, or via `pathsKey: "paths"`)
 *
 * Future consumers (`register_assets`, per AC4's forward-compat hook) have
 * their own shapes — the `extractPaths` escape hatch lets any tool plug in
 * without adding another built-in shape variant here.
 */
export interface PlanGuardOptions {
  mode: PlanGuardMode;
  /**
   * For array-of-strings shapes: the top-level key whose value is a
   * `string[]` of paths. Defaults to `"paths"` when `mode: "deletes"` (the
   * shape delete_files uses).
   */
  pathsKey?: string;
  /**
   * For non-standard shapes: a custom function that returns the flat list
   * of paths to check. Overrides `pathsKey` and the built-in
   * `files[].path` extraction when set. Used e.g. by `register_assets`
   * (whose paths live under `assets[].path`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractPaths?: (args: any) => string[];
}

/**
 * The MCP tool-result shape returned by the SDK's `registerTool` handler
 * signature — kept structural (rather than pulling in the SDK's own
 * `CallToolResult` type) so this middleware doesn't force a `@modelcontextprotocol/sdk`
 * import on files that don't otherwise need one. The `content` items are
 * declared with a discriminated-literal `type` so the returned value slots
 * directly into the SDK's own `CallToolResult` typing (which uses a union
 * over `type: "text" | "image" | ...` and would reject a `string`).
 */
export interface ToolResultContentText {
  type: "text";
  text: string;
  [key: string]: unknown;
}
export interface ToolResult {
  isError?: boolean;
  content: Array<ToolResultContentText>;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Context passed as the second argument to the wrapped handler on success —
 * the resolved plan. The handler would otherwise have to call `getPlan` a
 * second time to reach `plan.localDir` / `plan.kitId`, doubling the
 * plan-registry hit for every request; passing it through means every
 * downstream write/delete op sees the exact PlanState that authorised the
 * call (not one refreshed a few ms later on a separate `getPlan`).
 */
export interface PlanGuardContext {
  plan: PlanState;
}

/**
 * A tool handler as `withPlanGuard` sees it: takes the raw args and an
 * optional guard context (the resolved plan), returns an MCP tool result.
 *
 * The `Args` and `Result` type parameters flow through the HOF so a
 * caller-side type assertion isn't needed at the handler's signature.
 */
export type GuardedHandler<Args, Result extends ToolResult> = (
  args: Args,
  ctx: PlanGuardContext,
) => Promise<Result>;

// ─── AC3: canonical JSON-RPC-shaped rejection payload ────────────────────

/**
 * Build the structured tool-result for a rejection. Mirrors the JSON-RPC
 * `-32602 InvalidParams` error object (`{ code, message, data }`) exactly, so
 * an MCP client can parse the tool response as JSON and branch on
 * `code`/`data.reason` the same way it would branch on a wire-level error —
 * without needing to know which specific tool it called.
 *
 * `isError: true` makes the SDK surface this as a tool failure (not a
 * regular result) so the client's `isError` check trips.
 */
function guardErrorResult(
  message: string,
  reason: PlanGuardRejectReason,
  extra: { planId?: string; path?: string } = {},
): ToolResult {
  const data: { reason: PlanGuardRejectReason; planId?: string; path?: string } = { reason };
  if (extra.planId !== undefined) data.planId = extra.planId;
  if (extra.path !== undefined) data.path = extra.path;

  const payload = { code: -32602, message, data };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

// ─── AC6: structured plan.guard.reject audit log ─────────────────────────

/**
 * Emit an audit-log line to stderr (never stdout — on the stdio MCP
 * transport, stdout IS the protocol stream and a stray line there corrupts
 * every client's message framing; `plan.ts` follows the same convention for
 * its `plan.created` event, see the comment there).
 *
 * Only the guard's own metadata is logged: `event`, `planId` (when known),
 * `reason`, `path` (when path-specific). Never the file contents, `data`
 * payloads, `localPath` bytes, or anything else that came off the wire — a
 * plan-boundary rejection is a security-relevant event, and the log is what
 * an operator inspects afterwards; leaking the rejected payload defeats the
 * point.
 */
function logGuardReject(
  planId: string | undefined,
  reason: PlanGuardRejectReason,
  path?: string,
): void {
  const line: Record<string, unknown> = { event: "plan.guard.reject", reason };
  if (planId !== undefined) line.planId = planId;
  if (path !== undefined) line.path = path;
  process.stderr.write(JSON.stringify(line) + "\n");
}

// ─── Path extraction ─────────────────────────────────────────────────────

/**
 * Default path extractor for the two shipping tool shapes:
 *   - `mode: "writes"` (write_files) → `args.files[].path`
 *   - `mode: "deletes"` (delete_files) → `args[pathsKey ?? "paths"]` as a `string[]`
 *
 * A malformed shape (e.g. `files` isn't an array) is treated as "no paths to
 * check": the guard will then delegate to the wrapped handler, which owns
 * shape validation via its Zod input schema (see `deleteFilesArgsSchema` in
 * delete_files.ts, `fileInputSchema` in write_files.ts). This split matches
 * the wrapped tools' own precedent — plan checks answer "is this authorised?",
 * shape checks answer "is this well-formed?" — and keeps the guard from
 * needing to know each tool's input schema.
 */
function defaultExtractPaths(args: unknown, mode: PlanGuardMode, pathsKey?: string): string[] {
  if (typeof args !== "object" || args === null) return [];

  if (mode === "writes") {
    const files = (args as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];
    const out: string[] = [];
    for (const file of files) {
      if (
        typeof file === "object" &&
        file !== null &&
        typeof (file as { path?: unknown }).path === "string"
      ) {
        out.push((file as { path: string }).path);
      }
    }
    return out;
  }

  // mode === "deletes"
  const key = pathsKey ?? "paths";
  const paths = (args as Record<string, unknown>)[key];
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string");
}

// ─── The guard itself ────────────────────────────────────────────────────

/**
 * Wrap a plan-gated tool handler so every call funnels through one plan-vs-
 * write validation seam.
 *
 * Order of checks — matches AC2 (a)→(d), and is intentionally the same order
 * the tool would fail-fast on today:
 *
 *   1. **planId present** (AC2(a)) — string, non-empty. Missing values are
 *      rejected before touching the plan registry: a `getPlan("")` would
 *      throw as "not found", which would lose the distinction the reason
 *      enum draws between "you forgot to send a planId" and "the planId you
 *      sent doesn't match any plan we have." Clients act on those
 *      differently (the first is a client bug; the second may be an expired
 *      capability grant that needs re-issuing).
 *
 *   2. **planId exists + not expired** (AC2(b)+(c)) — `getPlan` throws
 *      `PlanNotFoundError` for both, so they surface as one `planNotFound`
 *      reason (see the enum comment above for why).
 *
 *   3. **path matches plan globs** (AC2(d)) — every extracted path is
 *      checked against `plan.writes` or `plan.deletes` per `options.mode`.
 *      Fails on the FIRST offending path: the exact offending path is
 *      surfaced (both in the returned payload and the audit log), so an
 *      operator investigating a rejection knows which specific path
 *      tripped the guard without having to diff the whole request against
 *      the plan's glob list.
 *
 * Only if all three pass does the wrapped handler run — with the resolved
 * plan handed through in `ctx.plan`, so it doesn't re-fetch (see
 * `PlanGuardContext`).
 *
 * Non-guard errors (a `getPlan` throw that isn't `PlanNotFoundError`, or
 * a handler throw) are NOT swallowed — they propagate as-is, so a
 * disk-corrupt plan snapshot or an internal handler bug is still visible to
 * the transport layer (as an MCP internal error), rather than being masked
 * as a plan-boundary rejection.
 */
export function withPlanGuard<Args, Result extends ToolResult>(
  options: PlanGuardOptions,
  handler: GuardedHandler<Args, Result>,
): (args: Args) => Promise<Result | ToolResult> {
  return async (args: Args): Promise<Result | ToolResult> => {
    // AC2(a) — planId presence.
    const planIdRaw = (args as { planId?: unknown } | null | undefined)?.planId;
    if (typeof planIdRaw !== "string" || planIdRaw.length === 0) {
      logGuardReject(undefined, "planIdMissing");
      return guardErrorResult(
        "planId is required: every plan-gated call must present a planId returned by mcp__genie__plan.",
        "planIdMissing",
      );
    }
    const planId = planIdRaw;

    // AC2(b)+(c) — planId exists + not expired. `getPlan` collapses both into
    // one PlanNotFoundError; anything else (disk read failure, corrupt JSON,
    // …) is genuinely internal and should propagate rather than masquerade
    // as a plan-boundary rejection.
    let plan: PlanState;
    try {
      plan = await getPlan(planId);
    } catch (error) {
      if (error instanceof PlanNotFoundError) {
        logGuardReject(planId, "planNotFound");
        return guardErrorResult(
          `Plan "${planId}" not found or expired. Plans expire after 1h of inactivity — request a new one via mcp__genie__plan.`,
          "planNotFound",
          { planId },
        );
      }
      throw error;
    }

    // AC2(d) — path membership.
    //
    // `extractPaths` is opt-in (for non-standard input shapes); otherwise
    // fall back to the default extractor per mode.
    const paths = options.extractPaths
      ? options.extractPaths(args)
      : defaultExtractPaths(args, options.mode, options.pathsKey);
    const globs = options.mode === "writes" ? plan.writes : plan.deletes;

    for (const path of paths) {
      if (!pathMatchesGlobs(path, globs)) {
        logGuardReject(planId, "pathOutsidePlan", path);
        return guardErrorResult(
          `Path "${path}" is not covered by the plan's ${options.mode}.`,
          "pathOutsidePlan",
          { planId, path },
        );
      }
    }

    // Passthrough — hand the resolved plan to the wrapped handler.
    return handler(args, { plan });
  };
}
