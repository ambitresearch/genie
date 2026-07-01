/**
 * MCP tool: validate (M1-12).
 *
 * Counter-persistence facet: accepts aggregate validation counts after an
 * upload and persists them for telemetry. The full-scan validator facet
 * arrives in M3-04. Both facets share this single MCP verb.
 *
 * Input:  { kitId: string, counts: { total, bad, thin, variantsIdentical, iterations } }
 * Output: {}
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Counter, Registry } from "prom-client";

/** Input schema for validate (counter-persistence facet). */
const countsSchema = z.object({
  total: z.number().int().nonnegative().describe("Total component count"),
  bad: z.number().int().nonnegative().describe("Failed validation count"),
  thin: z.number().int().nonnegative().describe("Thin component count"),
  variantsIdentical: z
    .number()
    .int()
    .nonnegative()
    .describe("Variants identical count"),
  iterations: z.number().int().nonnegative().describe("Iteration count"),
});

const inputSchema = {
  kitId: z.string().min(1).describe("UI kit identifier"),
  counts: countsSchema,
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
  const reportPath = join(reportsDir, `${timestamp}.json`);
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
 * Register the `mcp__genie__validate` tool on the given MCP server.
 *
 * The reportsDir parameter specifies where telemetry reports are persisted
 * (defaults to `.genie/reports` relative to the current working directory).
 */
export function registerValidate(
  server: McpServer,
  reportsDir?: string,
): void {
  const resolvedReportsDir =
    reportsDir ??
    process.env.GENIE_REPORTS_DIR ??
    join(process.cwd(), ".genie", "reports");

  server.registerTool(
    "mcp__genie__validate",
    {
      title: "Validate",
      description:
        "Counter-persistence facet: accepts aggregate validation counts after " +
        "an upload and persists them for telemetry. Does NOT require a planId " +
        "(this is read-side telemetry, not a write operation).",
      inputSchema,
    },
    async ({ kitId, counts }: { kitId: string; counts: ValidateCounts }) => {
      // Persist the report to disk
      await persistReport(resolvedReportsDir, kitId, counts);

      // Emit Prometheus metrics
      emitMetrics(kitId, counts);

      // AC5: Returns {}
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({}),
          },
        ],
      };
    },
  );
}
