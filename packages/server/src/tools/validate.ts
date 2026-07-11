/**
 * MCP tool: validate (D-A — one verb, two facets).
 *
 * genie's `validate` verb has two facets that share this single MCP tool
 * (`00-decisions.md` D-A folds `report_validate` + `validate_design_system`
 * into one verb):
 *
 *   1. **Counter-persistence facet (M1-12).** The caller already ran validation
 *      client-side and passes aggregate `counts`; this facet persists them to a
 *      timestamped report + emits Prometheus metrics. Read-side telemetry, no
 *      planId semantics.
 *        Input:  { kitId, counts: { total, bad, thin, variantsIdentical, iterations } }
 *        Output: {}
 *
 *   2. **Full-scan facet (M3-04 · DRO-260).** The caller passes NO `counts`;
 *      this facet does the heavyweight walk itself — the `@genie` marker check,
 *      the "thin render" check, and the "variants identical" perceptual-hash
 *      check across every `.html` file in the kit — and returns structured
 *      findings the model can act on, THEN persists the derived counters via the
 *      exact same `persistReport`/`emitMetrics` path as facet 1 (AC8: one verb,
 *      one persistence path).
 *        Input:  { kitId, planId? }
 *        Output: { markerMissing, thin, variantsIdentical, total, bad }
 *
 * The presence of `counts` in the input discriminates the two facets — the MCP
 * verb has one input schema, so `counts` is optional and its presence selects
 * the persist-only path; its absence selects the full scan.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Counter, Registry } from "prom-client";
import {
  fullScan,
  createDefaultRenderer,
  type FullScanKitStore,
  type FullScanResult,
  type Renderer,
} from "../validate/index.js";

/** Input schema for validate (counter-persistence facet). */
const countsSchema = z.object({
  total: z.number().int().nonnegative().describe("Total component count"),
  bad: z.number().int().nonnegative().describe("Failed validation count"),
  thin: z.number().int().nonnegative().describe("Thin component count"),
  variantsIdentical: z.number().int().nonnegative().describe("Variants identical count"),
  iterations: z.number().int().nonnegative().describe("Iteration count"),
});

const inputSchema = {
  kitId: z.string().min(1).describe("UI kit identifier"),
  // Facet 1 (counter-persistence, M1-12): when present, the caller supplies
  // pre-computed counts and this verb only persists them. When ABSENT, facet 2
  // (full-scan, M3-04) runs the checks itself. Optional so one MCP input schema
  // serves both facets (D-A: one verb).
  counts: countsSchema
    .optional()
    .describe(
      "Pre-computed validation counts (counter-persistence facet). Omit to run " +
        "the full-scan facet, which computes findings by scanning the kit.",
    ),
  // Facet 2 (full-scan, M3-04 · AC2): optional planId, accepted per the verb's
  // declared `validate({ kitId, planId? })` signature. Ignored by facet 1.
  planId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional plan id (full-scan facet); accepted per the verb signature."),
} as const;

type ValidateCounts = z.infer<typeof countsSchema>;

/**
 * Prometheus metrics registry and counters.
 * Exposed as a module singleton so M6-01 can register it with the HTTP endpoint.
 */
export const metricsRegistry = new Registry();

const totalCounter = new Counter({
  name: "genie_validate_total",
  help: "Total components validated",
  labelNames: ["kitId"],
  registers: [metricsRegistry],
});

const badCounter = new Counter({
  name: "genie_validate_bad",
  help: "Components that failed validation",
  labelNames: ["kitId"],
  registers: [metricsRegistry],
});

const thinCounter = new Counter({
  name: "genie_validate_thin",
  help: "Thin components (minimal content)",
  labelNames: ["kitId"],
  registers: [metricsRegistry],
});

const variantsIdenticalCounter = new Counter({
  name: "genie_validate_variantsIdentical",
  help: "Components with identical variants",
  labelNames: ["kitId"],
  registers: [metricsRegistry],
});

const iterationsCounter = new Counter({
  name: "genie_validate_iterations",
  help: "Validation iterations performed",
  labelNames: ["kitId"],
  registers: [metricsRegistry],
});

/**
 * Persist validation counts to a timestamped JSON report file.
 *
 * @param reportsDir - Directory where reports are stored (.genie/reports)
 * @param kitId - Kit identifier
 * @param counts - Validation counts to persist
 * @returns The path to the created report file
 */
export async function persistReport(
  reportsDir: string,
  kitId: string,
  counts: ValidateCounts,
): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // Sanitize for Windows-safe filenames (`:` is forbidden) and append a
  // random hex suffix so concurrent calls within the same millisecond never
  // collide or overwrite each other.
  const safeTimestamp = timestamp.replace(/:/g, "-");
  const suffix = Math.random().toString(16).slice(2, 8);
  const reportPath = join(reportsDir, `${safeTimestamp}-${suffix}.json`);
  const report = {
    timestamp,
    kitId,
    counts,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  return reportPath;
}

/**
 * Emit Prometheus metrics for the given validation counts.
 *
 * @param kitId - Kit identifier (used as metric label)
 * @param counts - Validation counts to emit
 */
export function emitMetrics(kitId: string, counts: ValidateCounts): void {
  totalCounter.inc({ kitId }, counts.total);
  badCounter.inc({ kitId }, counts.bad);
  thinCounter.inc({ kitId }, counts.thin);
  variantsIdenticalCounter.inc({ kitId }, counts.variantsIdentical);
  iterationsCounter.inc({ kitId }, counts.iterations);
}

/**
 * Derive the M1-12 counter shape from a full-scan result (AC8: the full-scan
 * facet persists its run via the SAME `persistReport`/`emitMetrics` path as the
 * counter facet). `iterations` is 1 — a single scan pass — and the four
 * validation dimensions come straight off the scan. `bad` is the scan's own
 * literal sum (`markerMissing + thin + variantsIdentical`).
 */
export function countsFromScan(result: FullScanResult): ValidateCounts {
  return {
    total: result.total,
    bad: result.bad,
    thin: result.thin.length,
    variantsIdentical: result.variantsIdentical.length,
    iterations: 1,
  };
}

/** Options for {@link registerValidate}. */
export interface RegisterValidateOptions {
  /** Where the counter facet + full-scan facet persist their JSON reports.
   * Defaults to `GENIE_REPORTS_DIR` / `.genie/reports`. */
  reportsDir?: string;
  /**
   * The kit read-port the full-scan facet walks (`listFiles`/`readFile`). When
   * omitted, the full-scan facet is unavailable and a no-`counts` call returns a
   * typed error — the counter-persistence facet still works standalone (so a
   * deployment that only uses telemetry needs no store wired here). `server.ts`
   * passes the shared `kitStore`.
   */
  kitStore?: FullScanKitStore;
  /**
   * Factory for the one headless renderer the full-scan facet reuses across a
   * scan (AC7). Defaults to {@link createDefaultRenderer} (lazy Playwright,
   * `null` when unavailable → the scan degrades to marker-only). Injectable so
   * tests supply a stub and never launch a browser.
   */
  createRenderer?: () => Promise<Renderer | null>;
}

/**
 * Register the `mcp__genie__validate` tool on the given MCP server (both
 * facets — see the module header).
 *
 * Backward-compatible call shape: `registerValidate(server, reportsDir?)` still
 * works (the M1-12 wiring), and `registerValidate(server, options)` opts into
 * the full-scan facet by supplying a `kitStore`.
 */
export function registerValidate(
  server: McpServer,
  reportsDirOrOptions?: string | RegisterValidateOptions,
): void {
  const options: RegisterValidateOptions =
    typeof reportsDirOrOptions === "string"
      ? { reportsDir: reportsDirOrOptions }
      : (reportsDirOrOptions ?? {});

  const resolvedReportsDir =
    options.reportsDir ?? process.env.GENIE_REPORTS_DIR ?? join(process.cwd(), ".genie", "reports");

  const createRenderer = options.createRenderer ?? createDefaultRenderer;

  server.registerTool(
    "mcp__genie__validate",
    {
      title: "Validate",
      description:
        "genie's validate verb (two facets, one tool). WITH `counts`: persists " +
        "pre-computed validation counts for telemetry (no planId needed — read-" +
        "side). WITHOUT `counts`: runs the full-scan facet — @genie marker check " +
        "+ thin-render check + variants-identical perceptual-hash check across " +
        "the kit — and returns { markerMissing, thin, variantsIdentical, total, " +
        "bad }, persisting the derived counters via the same path. Reach for this as an " +
        "advisory quality audit after conjure/refine + write_files — its findings are " +
        "counts, not blocking errors.",
      inputSchema,
    },
    async ({
      kitId,
      counts,
      planId,
    }: {
      kitId: string;
      counts?: ValidateCounts;
      planId?: string;
    }) => {
      // ── Facet 1: counter-persistence (M1-12) ────────────────────────────────
      // Explicit `counts` → persist-only, exactly as before.
      if (counts) {
        await persistReport(resolvedReportsDir, kitId, counts);
        emitMetrics(kitId, counts);
        return { content: [{ type: "text" as const, text: JSON.stringify({}) }] };
      }

      // ── Facet 2: full-scan (M3-04 · DRO-260) ────────────────────────────────
      // No `counts` → run the checks ourselves. Needs a kit store to read the
      // tree; without one, the facet is not available in this deployment.
      if (!options.kitStore) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "ERR_FULLSCAN_UNAVAILABLE",
                message:
                  "The full-scan facet requires a kit store; this validate tool was " +
                  "registered without one. Pass pre-computed `counts` to use the " +
                  "counter-persistence facet instead.",
              }),
            },
          ],
        };
      }

      // One renderer per scan (AC7), created here and closed after — the
      // orchestrator never closes a renderer it did not create. A `null`
      // renderer (Playwright/Chromium unavailable) makes the scan degrade to
      // marker-only rather than fail (same posture as `refine`'s region crop).
      const renderer = await createRenderer();
      let result: FullScanResult;
      try {
        result = await fullScan({ kitStore: options.kitStore, renderer }, { kitId, planId });
      } finally {
        if (renderer) await renderer.close();
      }

      // AC8 — persist the derived counters through the SAME path as facet 1.
      const derived = countsFromScan(result);
      await persistReport(resolvedReportsDir, kitId, derived);
      emitMetrics(kitId, derived);

      // Return the structured findings (the heavyweight facet's whole point).
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
