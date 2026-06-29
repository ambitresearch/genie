import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import type { KitStore, KitSummary } from "../store/interface.js";
import { KIT_TYPE_GENIE } from "../store/interface.js";

/** Helper: create a connected client+server pair with the given store. */
async function setup(store: KitStore) {
  const server = createServer({ kitStore: store });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

/** Minimal mock that returns the supplied array. */
function mockStore(kits: KitSummary[]): KitStore {
  return { listKits: async () => kits };
}

describe("list_kits tool (mocked store)", () => {
  it("is advertised in tools/list", async () => {
    const { client } = await setup(mockStore([]));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_kits");
    await client.close();
  });

  it("description is ≤ 2 KB (AC2)", async () => {
    const { client } = await setup(mockStore([]));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_kits")!;
    expect(tool.description).toBeDefined();
    expect(new TextEncoder().encode(tool.description!).length).toBeLessThanOrEqual(2048);
    await client.close();
  });

  it("returns [] when the store is empty (AC6)", async () => {
    const { client } = await setup(mockStore([]));
    const result = await client.callTool({ name: "list_kits", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
    await client.close();
  });

  it("returns kit summaries with the correct shape (AC4)", async () => {
    const kit: KitSummary = {
      id: "k1",
      name: "My Kit",
      owner: "alice",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canEdit: true,
      type: KIT_TYPE_GENIE,
    };
    const { client } = await setup(mockStore([kit]));
    const result = await client.callTool({ name: "list_kits", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: "k1",
      name: "My Kit",
      owner: "alice",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canEdit: true,
    });
    await client.close();
  });

  it("does not leak the type field in the output (AC4)", async () => {
    const kit: KitSummary = {
      id: "k1",
      name: "Kit",
      owner: "o",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canEdit: true,
      type: KIT_TYPE_GENIE,
    };
    const { client } = await setup(mockStore([kit]));
    const result = await client.callTool({ name: "list_kits", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed[0]).not.toHaveProperty("type");
    await client.close();
  });

  it("filters out non-GENIE_KIT records (AC5)", async () => {
    const genieKit: KitSummary = {
      id: "gk",
      name: "Genie Kit",
      owner: "o",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canEdit: true,
      type: KIT_TYPE_GENIE,
    };
    const otherKit: KitSummary = {
      id: "ok",
      name: "Other Kit",
      owner: "o",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canEdit: true,
      type: "PROJECT_TYPE_DESIGN_SYSTEM",
    };
    const { client } = await setup(mockStore([genieKit, otherKit]));
    const result = await client.callTool({ name: "list_kits", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe("gk");
    await client.close();
  });

  it("returns multiple kits", async () => {
    const kits: KitSummary[] = [
      { id: "a", name: "A", owner: "o", updatedAt: "2026-01-01T00:00:00.000Z", canEdit: true, type: KIT_TYPE_GENIE },
      { id: "b", name: "B", owner: "o", updatedAt: "2026-02-01T00:00:00.000Z", canEdit: false, type: KIT_TYPE_GENIE },
    ];
    const { client } = await setup(mockStore(kits));
    const result = await client.callTool({ name: "list_kits", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    await client.close();
  });

  it("ping still works when kitStore is provided", async () => {
    const { client } = await setup(mockStore([]));
    const result = await client.callTool({ name: "ping", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("pong");
    await client.close();
  });
});
