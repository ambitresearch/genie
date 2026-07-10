import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer } from "../server.js";
import type { ComponentEntry, KitStore } from "../store/interface.js";
import { LocalFsKitStore } from "../store/local.js";
import {
  LIST_COMPONENTS_DESCRIPTION,
  LIST_COMPONENTS_TOOL_NAME,
  MAX_COMPONENTS,
} from "./list_components.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Write a `.genie/manifest.json` into a kit dir under `kitsRoot`. */
async function writeManifest(
  kitsRoot: string,
  kitId: string,
  components: ComponentEntry[],
): Promise<void> {
  const genieDir = join(kitsRoot, kitId, ".genie");
  await mkdir(genieDir, { recursive: true });
  await writeFile(
    join(genieDir, "manifest.json"),
    JSON.stringify({ version: 1, components }, null, 2),
  );
}

const FIXTURE_GROUPS = ["actions", "data", "feedback", "forms", "navigation"];

/**
 * Build `perGroup` components in each of the 5 fixture groups, in a DELIBERATELY
 * REVERSED order (last group first, high index first) so a store that returns
 * manifest order rather than sorted order fails the AC6 assertion.
 */
function buildFixture(perGroup: number): ComponentEntry[] {
  const out: ComponentEntry[] = [];
  const pad = String(perGroup).length;
  for (let g = FIXTURE_GROUPS.length - 1; g >= 0; g--) {
    const group = FIXTURE_GROUPS[g]!;
    for (let i = perGroup - 1; i >= 0; i--) {
      const idx = String(i).padStart(pad, "0");
      out.push({
        name: `Comp${idx}`,
        group,
        path: `${group}/comp${idx}.html`,
        viewport: i % 2 === 0 ? "desktop" : "375x812",
        hash: `sha256-${group}-${idx}`,
        lastModified: "2026-07-01T00:00:00.000Z",
      });
    }
  }
  return out;
}

/** Reference AC6 ordering: group ASC, name ASC, path ASC (code-unit). */
function expectedOrder(components: ComponentEntry[]): string[] {
  return [...components]
    .sort(
      (a, b) =>
        (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .map((c) => `${c.group}/${c.name}/${c.path}`);
}

describe("LocalFsKitStore.listComponents", () => {
  let tempDir: string;
  let store: KitStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-components-"));
    store = new LocalFsKitStore(join(tempDir, "kits"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns [] for a kit with no components", async () => {
    const kit = await store.createKit("Empty Kit");
    const components = await store.listComponents({ kitId: kit.id });
    expect(components).toEqual([]);
  });

  it("propagates non-ENOENT manifest read errors instead of masking them as []", async () => {
    // Regression (PR #110 review): only a genuinely-absent manifest (ENOENT)
    // may map to []. If `.genie/manifest.json` is unreadable for another reason
    // — here it is a DIRECTORY, yielding EISDIR — the error must surface so a
    // real operability problem is not hidden behind an empty listing.
    const kit = await store.createKit("Broken Manifest Kit");
    const manifestAsDir = join(tempDir, "kits", kit.id, ".genie", "manifest.json");
    // createKit (DRO-764 AC3) now seeds a real empty manifest FILE at this
    // exact path — remove it first so the directory can take its place;
    // otherwise `mkdir` would fail with its own EEXIST before this test ever
    // reaches the EISDIR case it's actually exercising.
    await rm(manifestAsDir, { force: true });
    await mkdir(manifestAsDir, { recursive: true });

    await expect(store.listComponents({ kitId: kit.id })).rejects.toThrow();
  });

  it("returns [] when group filter matches nothing", async () => {
    const kit = await store.createKit("Empty Kit");
    const components = await store.listComponents({
      kitId: kit.id,
      group: "nonexistent",
    });
    expect(components).toEqual([]);
  });

  it("throws NotFoundError when kit does not exist", async () => {
    await expect(store.listComponents({ kitId: "nonexistent-kit" })).rejects.toThrow("Kit");
  });

  it("reads components from .genie/manifest.json and sorts deterministically (AC6)", async () => {
    const kit = await store.createKit("Fixture Kit");
    const fixture = buildFixture(3); // 15 components, 5 groups, reversed on disk
    await writeManifest(join(tempDir, "kits"), kit.id, fixture);

    const out = await store.listComponents({ kitId: kit.id });
    expect(out).toHaveLength(15);
    expect(out.map((c) => `${c.group}/${c.name}/${c.path}`)).toEqual(expectedOrder(fixture));
  });

  it("filters by group and preserves ordering (AC4/AC6)", async () => {
    const kit = await store.createKit("Fixture Kit");
    const fixture = buildFixture(4); // 20 components
    await writeManifest(join(tempDir, "kits"), kit.id, fixture);

    const forms = await store.listComponents({ kitId: kit.id, group: "forms" });
    expect(forms).toHaveLength(4);
    expect(forms.every((c) => c.group === "forms")).toBe(true);
    expect(forms.map((c) => c.name)).toEqual(["Comp0", "Comp1", "Comp2", "Comp3"]);
  });
});

describe("list_components guidance", () => {
  it("requires preview after both writes and deletions", () => {
    expect(LIST_COMPONENTS_DESCRIPTION).toContain("recent writes or deletions");
  });
});

describe("mcp__genie__list_components tool", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-components-mcp-"));
    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is listed in tools/list with kitId required and group optional", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === LIST_COMPONENTS_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description).toBe(LIST_COMPONENTS_DESCRIPTION);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        kitId: { type: "string" },
        group: { type: "string" },
      },
      required: ["kitId"],
      additionalProperties: false,
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["components"],
      additionalProperties: false,
    });
  });

  it("keeps the MCP tool description under Claude's 2 KB truncation limit", () => {
    expect(Buffer.byteLength(LIST_COMPONENTS_DESCRIPTION, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("advertises a Draft-7-clean schema — no anyOf / $ref / oneOf / allOf (AC3)", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === LIST_COMPONENTS_TOOL_NAME);
    const blob = JSON.stringify(tool?.inputSchema ?? {}) + JSON.stringify(tool?.outputSchema ?? {});
    expect(/anyOf|\$ref|oneOf|allOf/.test(blob)).toBe(false);
    // cursor is an accepted optional input (AC7 pagination).
    expect(
      (tool?.inputSchema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("cursor");
  });

  it("returns [] through MCP when the kit has no components", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Empty Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;

    const result = await client.callTool({
      name: LIST_COMPONENTS_TOOL_NAME,
      arguments: { kitId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ components: [] });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });

  it("returns [] when group filter matches nothing", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Empty Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;

    const result = await client.callTool({
      name: LIST_COMPONENTS_TOOL_NAME,
      arguments: { kitId, group: "nonexistent" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ components: [] });
  });

  it("rejects call when kitId is missing", async () => {
    const result = await client.callTool({
      name: LIST_COMPONENTS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBe(true);
  });
});

// ─── AC10 — 50-component / 5-group integration fixture ────────────────────────

describe("mcp__genie__list_components — AC10 integration fixture", () => {
  let tempDir: string;
  let kitsRoot: string;
  let client: Client;

  type ToolResult = {
    isError?: boolean;
    structuredContent?: { components: ComponentEntry[] };
    _meta?: { nextCursor?: string };
  };

  async function seedKit(name: string, components: ComponentEntry[]): Promise<string> {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;
    await writeManifest(kitsRoot, kitId, components);
    return kitId;
  }

  function call(kitId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return client.callTool({
      name: LIST_COMPONENTS_TOOL_NAME,
      arguments: { kitId, ...args },
    }) as Promise<ToolResult>;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-components-ac10-"));
    kitsRoot = join(tempDir, "kits");
    const server = createServer({ kitsRoot });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("asserts total count, group-filtered count, and deterministic ordering", async () => {
    const fixture = buildFixture(10); // 10 × 5 groups = 50 components (AC10)
    expect(fixture).toHaveLength(50);
    const kitId = await seedKit("Fifty Kit", fixture);

    // Total count — every component across all 5 groups.
    const all = await call(kitId);
    expect(all.isError).toBeFalsy();
    expect(all.structuredContent?.components).toHaveLength(50);

    // Deterministic ordering (AC6) — matches the independent reference sort.
    expect(all.structuredContent!.components.map((c) => `${c.group}/${c.name}/${c.path}`)).toEqual(
      expectedOrder(fixture),
    );

    // Group-filtered count — each of the 5 groups holds exactly 10.
    for (const group of FIXTURE_GROUPS) {
      const filtered = await call(kitId, { group });
      expect(filtered.structuredContent?.components).toHaveLength(10);
      expect(filtered.structuredContent!.components.every((c) => c.group === group)).toBe(true);
    }

    // 50 < 256 → single page, no continuation cursor (AC7 boundary).
    expect(all._meta?.nextCursor).toBeUndefined();
  });

  it("round-trips the 256-cap pagination cursor via _meta.nextCursor (AC7)", async () => {
    // 260 components in one group forces exactly two pages (256 + 4).
    const big: ComponentEntry[] = Array.from({ length: 260 }, (_, i) => {
      const idx = String(i).padStart(3, "0");
      return {
        name: `Comp${idx}`,
        group: "actions",
        path: `actions/comp${idx}.html`,
        viewport: "desktop",
        hash: `sha256-${idx}`,
        lastModified: "2026-07-01T00:00:00.000Z",
      };
    });
    const kitId = await seedKit("Big Kit", big);

    const page1 = await call(kitId);
    expect(page1.structuredContent?.components).toHaveLength(MAX_COMPONENTS);
    const cursor = page1._meta?.nextCursor;
    expect(cursor).toBeTypeOf("string");

    const page2 = await call(kitId, { cursor });
    expect(page2.structuredContent?.components).toHaveLength(260 - MAX_COMPONENTS);
    expect(page2._meta?.nextCursor).toBeUndefined();

    // Reassemble — every component exactly once, in deterministic order, no dupes.
    const names = [
      ...page1.structuredContent!.components,
      ...page2.structuredContent!.components,
    ].map((c) => c.name);
    expect(names).toHaveLength(260);
    expect(new Set(names).size).toBe(260);
    expect(names).toEqual(expectedOrder(big).map((k) => k.split("/")[1]));
  });
});
