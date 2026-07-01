import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  persistReport,
  emitMetrics,
  metricsRegistry,
} from "./validate.js";

async function tempReportsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-reports-"));
}

describe("validate tool", () => {
  let reportsDir: string;

  beforeEach(async () => {
    reportsDir = await tempReportsDir();
    // Clear the metrics registry before each test
    metricsRegistry.resetMetrics();
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(reportsDir, { recursive: true, force: true });
  });

  describe("persistReport", () => {
    it("creates a timestamped JSON report with kit and counts", async () => {
      const kitId = "test-kit-abc123";
      const counts = {
        total: 42,
        bad: 3,
        thin: 7,
        variantsIdentical: 2,
        iterations: 5,
      };

      const reportPath = await persistReport(reportsDir, kitId, counts);

      // Verify the report file was created
      expect(reportPath).toMatch(/\.json$/);

      // Read and parse the report
      const reportContent = await readFile(reportPath, "utf-8");
      const report = JSON.parse(reportContent);

      // AC3: Verify report structure
      expect(report).toMatchObject({
        kitId: "test-kit-abc123",
        counts: {
          total: 42,
          bad: 3,
          thin: 7,
          variantsIdentical: 2,
          iterations: 5,
        },
      });

      // Verify timestamp is ISO-8601
      expect(report.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("creates the reports directory if it does not exist", async () => {
      const nestedDir = join(reportsDir, "nested", "path");
      const kitId = "test-kit";
      const counts = {
        total: 1,
        bad: 0,
        thin: 0,
        variantsIdentical: 0,
        iterations: 1,
      };

      const reportPath = await persistReport(nestedDir, kitId, counts);

      // Verify the nested directory was created and file exists
      const reportContent = await readFile(reportPath, "utf-8");
      expect(reportContent).toBeTruthy();
    });
  });

  describe("emitMetrics", () => {
    it("increments Prometheus counters for each count field", async () => {
      const kitId = "test-kit-xyz";
      const counts = {
        total: 10,
        bad: 2,
        thin: 3,
        variantsIdentical: 1,
        iterations: 4,
      };

      emitMetrics(kitId, counts);

      // AC4: Verify Prometheus metrics are emitted
      const metrics = await metricsRegistry.metrics();

      // Check that all expected metrics are present with correct values
      expect(metrics).toContain('genie_validate_total{kitId="test-kit-xyz"} 10');
      expect(metrics).toContain('genie_validate_bad{kitId="test-kit-xyz"} 2');
      expect(metrics).toContain('genie_validate_thin{kitId="test-kit-xyz"} 3');
      expect(metrics).toContain(
        'genie_validate_variantsIdentical{kitId="test-kit-xyz"} 1',
      );
      expect(metrics).toContain(
        'genie_validate_iterations{kitId="test-kit-xyz"} 4',
      );
    });

    it("accumulates metrics across multiple calls", async () => {
      const kitId = "test-kit-multi";

      emitMetrics(kitId, {
        total: 5,
        bad: 1,
        thin: 0,
        variantsIdentical: 0,
        iterations: 1,
      });

      emitMetrics(kitId, {
        total: 3,
        bad: 0,
        thin: 1,
        variantsIdentical: 0,
        iterations: 1,
      });

      const metrics = await metricsRegistry.metrics();

      // Verify metrics accumulated across calls
      expect(metrics).toContain('genie_validate_total{kitId="test-kit-multi"} 8');
      expect(metrics).toContain('genie_validate_bad{kitId="test-kit-multi"} 1');
      expect(metrics).toContain('genie_validate_thin{kitId="test-kit-multi"} 1');
      expect(metrics).toContain(
        'genie_validate_iterations{kitId="test-kit-multi"} 2',
      );
    });
  });
});
