/**
 * Plan-vs-write guard middleware (M1-13).
 *
 * Centralises the plan-capability check that every plan-gated verb
 * (`write_files`, `delete_files`, and — later — `register`/`unregister`) must
 * perform, so the contract lives in ONE place instead of being reimplemented
 * per tool and drifting apart. Without this, the four verbs each re-derive
 * "is this planId valid, and does every path stay inside what the plan
 * authorised?" — and a fix to one (e.g. the dot-segment traversal guard that
 * landed in delete_files) silently fails to protect the others.
 *
 * ── What the guard enforces (M1-13 AC2) ──────────────────────────────────────
 *   (a) `planId` is present (a non-empty string),
 *   (b) `planId` resolves to a live plan (exists in the registry / on disk),
 *   (c) that plan is not expired,
 *   (d) every input `path` matches a glob in the relevant allow-list
 *       (`writes` for write-class verbs, `deletes` for delete-class verbs) AND
 *       stays inside the plan's boundary once resolved — no `.`/`..` segment,
 *       no absolute-path or traversal escape.
 *
 * (b) and (c) are delegated to `getPlan` (the M1-07 registry), which throws
 * `PlanNotFoundError` for either failure mode. (a) is normally enforced upstream
 * by each tool's Zod schema (a required, `.min(1)` `planId`), so the SDK returns
 * `-32602` before the handler runs; the guard re-checks it so a direct
 * (non-MCP) caller can't bypass it.
 *
 * ── Why the guard PRESERVES each tool's own error taxonomy ────────────────────
 * `write_files` (M1-08) and `delete_files` (M1-09) each ship a security-reviewed,
 * test-locked error contract: a path outside the plan surfaces as a structured
 * `PathOutsidePlanError` payload (NOT a bare `-32602`), and the conformance
 * suite asserts that exact shape. So this guard does NOT convert failures into a
 * single wire format. Instead it throws a typed `PlanGuardError` carrying a
 * machine-readable `reason`, and each tool maps that reason onto its own
 * existing error via `mapReason` — keeping M1-08/M1-09's public contract byte
 * for byte while still funnelling every check through one implementation.
 *
 * The guard's own MCP error rendering (`-32602` + `data.reason`, AC3) applies
 * only when a tool opts into the default rendering (no `mapReason` supplied) —
 * e.g. a future `register`/`unregister` verb with no legacy contract to keep.
 */

import {
  getPlan,
  isPathInsideLocalDir,
  pathMatchesGlobs,
  PlanNotFoundError,
  type PlanState,
} from "../plans/index.js";

/** The allow-list a verb gates against: writes for write-class, deletes for delete-class. */
export type PlanVerbKind = "write" | "delete";

/**
 * Why a guard check failed. Stable, machine-readable — safe to log and to
 * surface to a client for introspection (AC3/AC6). Never carries file contents.
 */
export type PlanGuardRejectReason =
  | "MISSING_PLAN_ID" // (a) planId absent / empty
  | "PLAN_NOT_FOUND" // (b)/(c) unknown, malformed, or expired planId
  | "PATH_DOT_SEGMENT" // (d) path contains a "." or ".." segment
  | "PATH_NOT_IN_PLAN" // (d) path matches no glob in the relevant allow-list
  | "PATH_ESCAPES_PLAN"; // (d) resolved path escapes the plan boundary (kitRoot/localDir)

/**
 * Structured, client-facing guard error. `reason` is the stable discriminant;
 * `path` is present for the per-path reasons (d). Tools either map this onto
 * their own error taxonomy (`mapReason`) or let the middleware render it as an
 * MCP `-32602` with `data.reason` (AC3).
 */
export class PlanGuardError extends Error {
  readonly reason: PlanGuardRejectReason;
  readonly path?: string;

  constructor(reason: PlanGuardRejectReason, message: string, path?: string) {
    super(message);
    this.name = "PlanGuardError";
    this.reason = reason;
    this.path = path;
  }
}

/**
 * Reject any path containing a `.` or `..` segment (on either separator).
 *
 * A glob check runs against the RAW request string, but the tool later resolves
 * the path (`resolve(root, path)`). Those two views disagree for a dot-segment
 * input like `allowed/../secret.txt` — it can match a permissive glob yet
 * resolve outside the authorised subtree. Rejecting dot-segments up front makes
 * plan gating depend only on the literal authorised path, never on how
 * micromatch or `path.resolve` happens to treat traversal. This is the exact
 * check delete_files shipped inline (M1-09); centralised here so write-class
 * verbs get it too.
 */
export function hasDotSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
}

/**
 * The validated result of a successful guard pass, threaded into the wrapped
 * handler so it never re-resolves the plan or re-checks paths.
 */
export interface PlanGuardContext {
  /** The live, unexpired plan the call is authorised against. */
  readonly plan: PlanState;
  /** The de-duplicated request paths, in first-seen order, all validated. */
  readonly paths: string[];
}

/** Options describing how a specific verb wants the guard to behave. */
export interface PlanGuardOptions<Args> {
  /** Which allow-list to gate against — `writes` or `deletes`. */
  readonly kind: PlanVerbKind;
  /** Extract the planId from the tool's args (may be undefined/empty). */
  readonly getPlanId: (args: Args) => string | undefined;
  /** Extract the list of request paths to validate from the tool's args. */
  readonly getPaths: (args: Args) => readonly string[];
  /**
   * The boundary a resolved path must stay inside. For write-class verbs this
   * is the plan's `localDir`; for delete-class verbs it is the kit root
   * (`resolve(kitsRoot, plan.kitId)`), which the caller supplies here since only
   * the tool knows its kitsRoot. Returns the absolute boundary directory.
   *
   * The guard additionally verifies the boundary itself stays inside its parent
   * root when `rootForBoundary` is provided (defence in depth against a plan
   * authored with a traversal `kitId`).
   */
  readonly resolveBoundary: (plan: PlanState) => string;
  /**
   * Optional parent root the boundary must stay within (e.g. kitsRoot). When
   * supplied, a boundary that escapes it (a `kitId: ".."` plan) is rejected with
   * `PATH_ESCAPES_PLAN` before any path is examined.
   */
  readonly rootForBoundary?: string;
}

/**
 * Core guard: resolve+validate the plan and every path, returning a validated
 * context. Throws `PlanGuardError` on the first failure. Pure w.r.t. the
 * filesystem except for the plan-registry read `getPlan` performs.
 *
 * This is the single implementation of M1-13 AC2 (a)–(d). Exposed directly (not
 * only via `withPlanGuard`) so a tool that isn't structured as a simple HOF —
 * e.g. one that must interleave its own pre-checks — can still funnel through
 * the same logic.
 */
export async function runPlanGuard<Args>(
  args: Args,
  options: PlanGuardOptions<Args>,
): Promise<PlanGuardContext> {
  // (a) planId present.
  const planId = options.getPlanId(args);
  if (planId === undefined || planId === "") {
    throw new PlanGuardError("MISSING_PLAN_ID", "A non-empty planId is required.");
  }

  // (b)/(c) plan exists and is not expired — getPlan throws PlanNotFoundError
  // for unknown, malformed-UUID, or expired ids. Re-throw as a guard reason so
  // callers see one error type.
  let plan: PlanState;
  try {
    plan = await getPlan(planId);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw new PlanGuardError(
        "PLAN_NOT_FOUND",
        `Plan "${planId}" not found or expired.`,
      );
    }
    throw error;
  }

  // Resolve the boundary this verb's paths must stay inside, and (defence in
  // depth) verify the boundary itself hasn't escaped its parent root via a
  // traversal kitId. isPathInsideLocalDir(root, boundary) is symmetric enough
  // for a containment test: boundary must be inside (or equal to) the root.
  const boundary = options.resolveBoundary(plan);
  if (options.rootForBoundary !== undefined) {
    const insideRoot =
      boundary === options.rootForBoundary ||
      isPathInsideLocalDir(boundary, options.rootForBoundary);
    if (!insideRoot) {
      throw new PlanGuardError(
        "PATH_ESCAPES_PLAN",
        `Plan boundary "${boundary}" resolves outside its root.`,
      );
    }
  }

  const allow = options.kind === "write" ? plan.writes : plan.deletes;

  // De-duplicate while preserving first-seen order so a repeated path isn't
  // validated (or later acted on) twice.
  const paths = [...new Set(options.getPaths(args))];

  // (d) every path: no dot-segment, matches the allow-list, stays in-boundary.
  for (const path of paths) {
    if (hasDotSegment(path)) {
      throw new PlanGuardError(
        "PATH_DOT_SEGMENT",
        `Path "${path}" contains a "." or ".." segment.`,
        path,
      );
    }
    if (!pathMatchesGlobs(path, allow)) {
      throw new PlanGuardError(
        "PATH_NOT_IN_PLAN",
        `Path "${path}" is not covered by the plan's ${options.kind === "write" ? "writes" : "deletes"}.`,
        path,
      );
    }
    if (!isPathInsideLocalDir(path, boundary)) {
      throw new PlanGuardError(
        "PATH_ESCAPES_PLAN",
        `Path "${path}" resolves outside the plan boundary.`,
        path,
      );
    }
  }

  return { plan, paths };
}

/**
 * Emit the AC6 audit line for a guard rejection: a structured
 * `plan.guard.reject` event carrying `{ planId, reason, path? }` and NOTHING
 * else — never file contents. Goes to stderr, never stdout: on the stdio
 * transport stdout *is* the JSON-RPC stream, so a stray line there corrupts
 * every client's message framing (same rule as plan.ts's plan.created line).
 */
export function logPlanGuardReject(
  planId: string | undefined,
  error: PlanGuardError,
  sink: { write: (chunk: string) => void } = process.stderr,
): void {
  const record: Record<string, unknown> = {
    event: "plan.guard.reject",
    planId: planId ?? null,
    reason: error.reason,
  };
  if (error.path !== undefined) record.path = error.path;
  sink.write(JSON.stringify(record) + "\n");
}

/** A minimal MCP tool-result shape — mirrors what registerTool handlers return. */
export interface McpToolResult {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Higher-order function form of the guard (M1-13 AC1).
 *
 * Wraps a tool `handler` so that, before the handler runs, the plan and every
 * path are validated exactly once through `runPlanGuard`. On success the
 * handler is invoked with the original args plus the validated
 * `PlanGuardContext`. On failure the guard:
 *   1. logs `plan.guard.reject` (AC6), then
 *   2. either maps the failure onto the tool's own error via `mapReason`
 *      (preserving M1-08/M1-09's structured contract), or — if no `mapReason`
 *      is supplied — renders the default MCP `-32602` + `data.reason` (AC3).
 *
 * `mapReason` returns the tool's own error object to THROW (so the tool's
 * existing catch/render path formats it), keeping this middleware agnostic of
 * each tool's wire format.
 */
export function withPlanGuard<Args, R extends McpToolResult>(
  handler: (args: Args, ctx: PlanGuardContext) => Promise<R>,
  options: PlanGuardOptions<Args> & {
    /**
     * Map a guard failure onto the tool's own error to throw. Omit to use the
     * middleware's default `-32602` rendering.
     */
    mapReason?: (error: PlanGuardError) => Error;
  },
): (args: Args) => Promise<R | McpToolResult> {
  return async (args: Args) => {
    let ctx: PlanGuardContext;
    try {
      ctx = await runPlanGuard(args, options);
    } catch (error) {
      if (error instanceof PlanGuardError) {
        logPlanGuardReject(options.getPlanId(args), error);
        if (options.mapReason) {
          throw options.mapReason(error);
        }
        // Default rendering (AC3): MCP InvalidParams (-32602) + data.reason.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: -32602,
                message: error.message,
                data: { reason: error.reason, ...(error.path ? { path: error.path } : {}) },
              }),
            },
          ],
        };
      }
      throw error;
    }
    return handler(args, ctx);
  };
}
