/**
 * M5-13 (DRO-285) — Cursor harness smoke test.
 *
 * Cursor talks MCP over the same protocol every other harness uses (stdio /
 * Streamable HTTP via `@modelcontextprotocol/sdk`), so there is nothing
 * Cursor-specific to fake at the wire level — this suite drives the real
 * server over the SDK's `InMemoryTransport` (same harness pattern as
 * `m1-conformance.test.ts`) and asserts the two things `docs/harness/cursor.md`
 * documents as executable claims:
 *
 *   AC3 — the four-verb chain (`conjure → plan → write_files → preview`) is
 *         reachable end-to-end and `preview` emits the `ui://genie/grid`
 *         resource pointer Cursor's inline Apps extension consumes. `conjure`
 *         requires `GENIE_LLM_*` (M2-01); this suite drives `plan →
 *         write_files → preview` directly (the three verbs that don't need an
 *         LLM call) and separately asserts `conjure` is registered and fails
 *         closed with a typed error when no LLM endpoint is configured — so
 *         the chain is proven reachable without a live model dependency.
 *
 *   AC4 — the historical "Cursor caps tool lists at 40" claim (research §4/§8,
 *         unverified against current docs) is tested empirically here: this
 *         suite registers 50+ additional dummy tools on the SAME MCP server
 *         instance used by the real chain, then asserts `tools/list` returns
 *         ALL of them. Nothing server-side or protocol-side truncates the
 *         list — genie makes no assumption about, or enforcement of, a
 *         40-tool cap. Any capping is a CLIENT-side (Cursor) behavior outside
 *         this process's control, which is exactly the finding recorded in
 *         `docs/harness/cursor.md`.
 *
 * AC1/AC2/AC5 (documenting the snippet's `auth` block, `env:` tokens, and the
 * static OAuth callback URL) are pure documentation — see `cursor.md` — and
 * have no executable surface: Cursor's OAuth exchange happens in Cursor's own
 * process, not genie's, so there is nothing here to drive live.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server/src/server.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
  _meta?: Record<string, unknown>;
}

function payload(result: ToolResult): any {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

interface Harness {
  client: Client;
  roots: { projectsRoot: string; kitsRoot: string; reportsDir: string };
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

async function newHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "genie-m5-cursor-"));
  const roots = {
    projectsRoot: join(base, "projects"),
    kitsRoot: join(base, "kits"),
    reportsDir: join(base, "reports"),
  };
  const server = createServer(roots);
  const client = new Client({ name: "m5-smoke-cursor", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    roots,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(async () => {
  harness = await newHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("AC3 — Cursor's four-verb chain is reachable and preview emits ui://genie/grid", () => {
  it("plan -> write_files -> preview round-trips and preview's _meta.ui.resourceUri points at ui://genie/grid", async () => {
    const kitResult = await harness.call("mcp__genie__create_kit", { name: "Cursor Smoke Kit" });
    const kitId = (payload(kitResult) as { kitId: string }).kitId;
    expect(kitId).toMatch(/^[a-z0-9-]{3,64}$/);

    const planResult = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["components/hello.html"],
      deletes: [],
    });
    const planId = (payload(planResult) as { planId: string }).planId;
    expect(typeof planId).toBe("string");

    const writeResult = await harness.call("mcp__genie__write_files", {
      planId,
      files: [
        {
          path: "components/hello.html",
          data: "<!doctype html><body>@genie-marker hello</body>",
        },
      ],
    });
    expect(writeResult.isError).not.toBe(true);

    const previewResult = await harness.call("mcp__genie__preview", { kitId });
    expect(previewResult.isError).not.toBe(true);
    const meta = previewResult._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\/genie\/grid/);
    expect(meta?.ui?.resourceUri).toContain(`kitId=${kitId}`);
  });

  it("conjure is registered on the same server and fails closed (typed error, no silent no-op) without GENIE_LLM_*", async () => {
    const previousBaseUrl = process.env.GENIE_LLM_BASE_URL;
    const previousApiKey = process.env.GENIE_LLM_API_KEY;
    delete process.env.GENIE_LLM_BASE_URL;
    delete process.env.GENIE_LLM_API_KEY;
    try {
      const { tools } = await harness.client.listTools();
      expect(tools.some((t) => t.name === "mcp__genie__conjure")).toBe(true);

      const result = await harness.call("mcp__genie__conjure", {
        prompt: "a button",
      });
      // Missing LLM config must surface as a tool-level error, not a silent
      // pass-through or a crash of the MCP connection itself.
      expect(result.isError).toBe(true);
    } finally {
      if (previousBaseUrl !== undefined) process.env.GENIE_LLM_BASE_URL = previousBaseUrl;
      if (previousApiKey !== undefined) process.env.GENIE_LLM_API_KEY = previousApiKey;
    }
  });
});

describe("AC4 — tool-cap probe: does genie (server-side) truncate tools/list at 40?", () => {
  it("registers 50+ dummy tools alongside the real surface and tools/list returns every one of them", async () => {
    const DUMMY_TOOL_COUNT = 55;

    const base = await mkdtemp(join(tmpdir(), "genie-m5-cursor-toolcap-"));
    const roots = {
      projectsRoot: join(base, "projects"),
      kitsRoot: join(base, "kits"),
      reportsDir: join(base, "reports"),
    };
    const server = createServer(roots);

    const baselineNames = new Set<string>();
    // Peek at the real surface size first via a throwaway client, so the
    // dummy-tool assertion below is against a known baseline, not a guess.
    {
      const probeClient = new Client({ name: "m5-smoke-cursor-baseline", version: "0" });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverT), probeClient.connect(clientT)]);
      const { tools } = await probeClient.listTools();
      for (const t of tools) baselineNames.add(t.name);
      await probeClient.close();
    }
    const realToolCount = baselineNames.size;
    expect(realToolCount).toBeGreaterThan(0);

    for (let i = 0; i < DUMMY_TOOL_COUNT; i++) {
      server.registerTool(
        `dummy_tool_${i}`,
        { title: `Dummy ${i}`, description: "M5-13 tool-cap probe filler tool.", inputSchema: {} },
        () => ({ content: [{ type: "text", text: "dummy" }] }),
      );
    }

    const client = new Client({ name: "m5-smoke-cursor-toolcap", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const { tools } = await client.listTools();
      const dummyNames = tools.filter((t) => t.name.startsWith("dummy_tool_"));

      // Empirical finding (AC4): the MCP SDK / genie server impose no
      // server-side cap. All registered tools — real + dummy — are returned
      // by tools/list in this in-process transport. A historical "Cursor caps
      // at 40" claim, if true today, is enforced CLIENT-side inside Cursor's
      // own tool-list rendering, not by genie or the SDK's tools/list
      // response. Not in current Cursor docs (research §4) — treat as
      // unverified for Cursor's actual UI behavior; this suite only proves
      // genie ships the full list for Cursor to choose from.
      expect(dummyNames).toHaveLength(DUMMY_TOOL_COUNT);
      expect(tools.length).toBe(realToolCount + DUMMY_TOOL_COUNT);
      expect(tools.length).toBeGreaterThan(40);
    } finally {
      await client.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
