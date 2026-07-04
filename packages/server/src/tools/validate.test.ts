import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  persistReport,
  emitMetrics,
  metricsRegistry,
  countsFromScan,
  registerValidate,
} from "./validate.js";
import type {
  FullScanKitStore,
  FullScanResult,
  Renderer,
  RenderedCard,
} from "../validate/index.js";

async function tempReportsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-reports-"));
}

// ── Full-scan facet fixtures (mirrors `validate/full-scan.test.ts`'s stubs) ────
//
// These drive `registerValidate`'s dispatch/wiring THROUGH the MCP transport
// (in-process client/server over InMemoryTransport, same harness
// `refine.test.ts` uses) — `full-scan.ts`/`phash.ts` already have thorough
// direct unit coverage; what's untested (Copilot review, PR #152) is the
// TOOL-level wiring: the `counts`-present-vs-absent dispatch, the
// `ERR_FULLSCAN_UNAVAILABLE` no-store branch, the per-call renderer
// create/close lifecycle, and `countsFromScan`'s mapping.

const MARKER = '<!-- @genie group="actions" viewport="400x200" -->';

/** A kit store backed by a fixed file list — same shape as `FullScanKitStore`. */
function stubKitStore(files: Array<{ path: string; content: string }>): FullScanKitStore {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    async listFiles() {
      return files.map((f) => ({ path: f.path }));
    },
    async readFile(_kitId: string, path: string) {
      const f = byPath.get(path);
      if (!f) throw new Error(`no such file: ${path}`);
      return { content: f.content };
    },
  };
}

// A FLAT solid-color image hashes identically regardless of its color (every
// block ties at the image-wide median — same fact `phash.test.ts`'s own doc
// comment calls out), so distinct-per-file fixtures need internal structure: a
// left/right split, exactly like `phash.test.ts`/`full-scan.test.ts`'s own
// `splitImage` builders (empirically re-verified pairwise-distinct here too).
function splitImage(
  left: [number, number, number, number],
  right: [number, number, number, number],
  size = 64,
): RenderedCard["image"] {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = x < size / 2 ? left : right;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  return { data, width: size, height: size };
}

/** Three pairwise-distinct (non-colliding) card images — verified against the
 * real `computePHash`/blockhash-core, same fixture shape as
 * `full-scan.test.ts`'s `IMAGE_A`/`IMAGE_B` plus a third bucket. */
const DISTINCT_IMAGES = [
  splitImage([200, 124, 94, 255], [32, 64, 96, 255]),
  splitImage([32, 64, 96, 255], [200, 124, 94, 255]),
  splitImage([1, 2, 3, 255], [250, 240, 230, 255]),
];

/** A renderer stub that records whether it was closed — proves the tool's
 * per-call create/close lifecycle (the `finally` around `fullScan`). Renders a
 * TALL (never thin) card whose image is picked from {@link DISTINCT_IMAGES} by
 * a cheap parity of the html's length (same idea as `full-scan.test.ts`'s
 * `tallDistinct`), so unrelated source files never accidentally collide into
 * `variantsIdentical` — a test that WANTS a duplicate-cluster hit passes an
 * explicit `image` override instead. */
function stubRenderer(overrides: { image?: RenderedCard["image"] } = {}): Renderer & {
  closed: boolean;
} {
  const state = { closed: false };
  return {
    get closed() {
      return state.closed;
    },
    async render(html: string): Promise<RenderedCard> {
      const image = overrides.image ?? DISTINCT_IMAGES[html.length % DISTINCT_IMAGES.length]!;
      return { contentHeight: 300, image };
    },
    async close(): Promise<void> {
      state.closed = true;
    },
  };
}

/** Connect an in-process client to a server with `registerValidate(options)`
 * already applied, call `mcp__genie__validate`, and hand back the parsed JSON
 * payload — same connect/call/close shape `refine.test.ts`'s tool-boundary
 * tests use. */
async function callValidate(
  options: Parameters<typeof registerValidate>[1],
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const server = new McpServer({ name: "t", version: "0" });
  registerValidate(server, options);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const res = (await client.callTool({ name: "mcp__genie__validate", arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: res.isError, payload: JSON.parse(res.content[0]!.text) };
  } finally {
    await client.close();
    await server.close();
  }
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
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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
      expect(metrics).toContain('genie_validate_variantsIdentical{kitId="test-kit-xyz"} 1');
      expect(metrics).toContain('genie_validate_iterations{kitId="test-kit-xyz"} 4');
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
      expect(metrics).toContain('genie_validate_iterations{kitId="test-kit-multi"} 2');
    });
  });

  describe("countsFromScan (AC8 — full-scan → counter-shape mapping)", () => {
    it("maps total/bad straight off the scan and derives the per-array lengths, with iterations pinned to 1", () => {
      const result: FullScanResult = {
        markerMissing: ["a.html", "b.html"],
        thin: ["c.html"],
        variantsIdentical: ["d.html", "e.html", "f.html"],
        total: 10,
        bad: 6,
      };
      expect(countsFromScan(result)).toEqual({
        total: 10,
        bad: 6,
        thin: 1,
        variantsIdentical: 3,
        iterations: 1,
      });
    });

    it("maps an all-clean scan to all-zero counts", () => {
      const result: FullScanResult = {
        markerMissing: [],
        thin: [],
        variantsIdentical: [],
        total: 5,
        bad: 0,
      };
      expect(countsFromScan(result)).toEqual({
        total: 5,
        bad: 0,
        thin: 0,
        variantsIdentical: 0,
        iterations: 1,
      });
    });
  });

  // ── Facet dispatch + full-scan wiring (tool level) ──────────────────────────
  //
  // `full-scan.ts`/`phash.ts` already have thorough direct-unit coverage; these
  // tests instead drive `registerValidate` THROUGH the MCP transport (in-process
  // client/server, same harness `refine.test.ts` uses) to prove the WIRING: which
  // facet a call selects, the per-call renderer lifecycle, the unavailable-store
  // error path, and that the full-scan facet persists through the same
  // `persistReport`/`emitMetrics` path as the counter facet (AC8).
  describe("facet dispatch (counts present vs. absent)", () => {
    it("with `counts`: persists + emits metrics and returns {} (counter facet unchanged)", async () => {
      const kitId = "dispatch-counts-kit";
      const { isError, payload } = await callValidate(
        { reportsDir },
        {
          kitId,
          counts: { total: 5, bad: 0, thin: 1, variantsIdentical: 0, iterations: 1 },
        },
      );
      expect(isError).toBeFalsy();
      expect(payload).toEqual({});
      const metrics = await metricsRegistry.metrics();
      expect(metrics).toContain(`genie_validate_total{kitId="${kitId}"} 5`);
    });

    it("without `counts`: runs the full-scan facet and returns structured findings", async () => {
      const kitId = "dispatch-scan-kit";
      const kitStore = stubKitStore([
        { path: "a/Ok.html", content: `${MARKER}\n<div>fine</div>` },
        { path: "a/Bad.html", content: `<div>no marker</div>` },
      ]);
      const renderer = stubRenderer();
      const { isError, payload } = await callValidate(
        { reportsDir, kitStore, createRenderer: async () => renderer },
        { kitId },
      );
      expect(isError).toBeFalsy();
      expect(payload).toEqual({
        markerMissing: ["a/Bad.html"],
        thin: [],
        variantsIdentical: [],
        total: 2,
        bad: 1,
      });
    });

    it("without `counts`: persists the SCAN's derived counters via the same persistReport/emitMetrics path (AC8)", async () => {
      const kitId = "dispatch-scan-persist-kit";
      const kitStore = stubKitStore([{ path: "a/Bad.html", content: `<div>no marker</div>` }]);
      const renderer = stubRenderer();
      await callValidate({ reportsDir, kitStore, createRenderer: async () => renderer }, { kitId });

      // AC8's own report-persistence contract (same shape `persistReport`'s
      // direct tests assert on): one JSON report file under reportsDir.
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(reportsDir);
      const reportFile = files.find((f) => f.endsWith(".json"));
      expect(reportFile).toBeDefined();
      const report = JSON.parse(await readFile(join(reportsDir, reportFile!), "utf-8"));
      // total=1 (one .html), bad=1 (markerMissing), thin=0, variantsIdentical=0.
      expect(report).toMatchObject({
        kitId,
        counts: { total: 1, bad: 1, thin: 0, variantsIdentical: 0, iterations: 1 },
      });

      const metrics = await metricsRegistry.metrics();
      expect(metrics).toContain(`genie_validate_bad{kitId="${kitId}"} 1`);
    });

    it("creates exactly one renderer per call and closes it after the scan (even though no counts are passed)", async () => {
      const kitId = "dispatch-lifecycle-kit";
      const kitStore = stubKitStore([{ path: "a/Ok.html", content: `${MARKER}\n<div>x</div>` }]);
      const renderer = stubRenderer();
      const createRenderer = vi.fn(async () => renderer);
      await callValidate({ reportsDir, kitStore, createRenderer }, { kitId });
      expect(createRenderer).toHaveBeenCalledTimes(1);
      expect(renderer.closed).toBe(true);
    });

    it("closes the renderer even when fullScan throws (finally, not just the happy path)", async () => {
      const kitId = "dispatch-lifecycle-throw-kit";
      // listFiles rejects outright — fullScan's own read pass never gets to run.
      const kitStore: FullScanKitStore = {
        async listFiles() {
          throw new Error("kit store exploded");
        },
        async readFile() {
          throw new Error("unreachable");
        },
      };
      const renderer = stubRenderer();
      // Unlike the deliberate `ERR_FULLSCAN_UNAVAILABLE` JSON branch, this
      // handler does NOT catch a `fullScan` throw itself — it propagates past
      // the `finally` (which still runs, closing the renderer) and out of the
      // handler, where the MCP SDK's own tool-call machinery maps it to an
      // `isError: true` result with a plain-text (not JSON) message — same
      // top-level boundary behavior `refine.ts`'s handler relies on for any
      // error it does NOT explicitly recognize as its own typed error. So this
      // asserts on the raw content text, not `callValidate`'s JSON parse.
      const server = new McpServer({ name: "t", version: "0" });
      registerValidate(server, { reportsDir, kitStore, createRenderer: async () => renderer });
      const client = new Client({ name: "c", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        const res = (await client.callTool({
          name: "mcp__genie__validate",
          arguments: { kitId },
        })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("kit store exploded");
      } finally {
        await client.close();
        await server.close();
      }
      // The lifecycle guarantee this test exists to prove: the renderer THIS
      // call created is still closed even though `fullScan` never returned.
      expect(renderer.closed).toBe(true);
    });

    it("does not create a renderer at all for the counts-present (counter) facet", async () => {
      const createRenderer = vi.fn(async () => stubRenderer());
      await callValidate(
        { reportsDir, createRenderer },
        {
          kitId: "dispatch-no-renderer-kit",
          counts: { total: 1, bad: 0, thin: 0, variantsIdentical: 0, iterations: 1 },
        },
      );
      expect(createRenderer).not.toHaveBeenCalled();
    });

    it("returns ERR_FULLSCAN_UNAVAILABLE when no `counts` are given and no kitStore was registered", async () => {
      const { isError, payload } = await callValidate({ reportsDir }, { kitId: "no-store-kit" });
      expect(isError).toBe(true);
      expect(payload).toMatchObject({ error: "ERR_FULLSCAN_UNAVAILABLE" });
    });

    it("the counter facet still works standalone with no kitStore registered (backward compatible)", async () => {
      const { isError, payload } = await callValidate(
        { reportsDir },
        {
          kitId: "standalone-counter-kit",
          counts: { total: 2, bad: 1, thin: 0, variantsIdentical: 0, iterations: 1 },
        },
      );
      expect(isError).toBeFalsy();
      expect(payload).toEqual({});
    });

    it("backward-compatible call shape: registerValidate(server, reportsDirString) still works for the counter facet", async () => {
      const server = new McpServer({ name: "t", version: "0" });
      registerValidate(server, reportsDir); // string form, not the options object
      const client = new Client({ name: "c", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        const res = (await client.callTool({
          name: "mcp__genie__validate",
          arguments: {
            kitId: "string-form-kit",
            counts: { total: 1, bad: 0, thin: 0, variantsIdentical: 0, iterations: 1 },
          },
        })) as { isError?: boolean };
        expect(res.isError).toBeFalsy();
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("passes planId through to the scan without error (AC2 — accepted, not required)", async () => {
      const kitId = "dispatch-planid-kit";
      const kitStore = stubKitStore([{ path: "a/Ok.html", content: `${MARKER}\n<div>x</div>` }]);
      const renderer = stubRenderer();
      const { isError, payload } = await callValidate(
        { reportsDir, kitStore, createRenderer: async () => renderer },
        { kitId, planId: "11111111-1111-4111-8111-111111111111" },
      );
      expect(isError).toBeFalsy();
      expect(payload.total).toBe(1);
    });
  });
});
