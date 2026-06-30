import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { InMemoryKitStore } from "../store/memory.js";
import { GENIE_KIT_TYPE } from "../store/types.js";
import type { KitMeta } from "../store/types.js";

const NOW = "2025-06-01T00:00:00.000Z";

function makeKit(overrides: Partial<KitMeta> = {}): KitMeta {
  return {
    id: "kit-1",
    name: "Acme UI Kit",
    type: GENIE_KIT_TYPE,
    canEdit: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type TextContent = { type: string; text: string };

async function setup(kits: KitMeta[] = []) {
  const store = new InMemoryKitStore(kits);
  const server = createServer({ kitStore: store });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client, store };
}

describe("get_kit tool", () => {
  let client: Client;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  describe("happy path", () => {
    const kit = makeKit();

    beforeEach(async () => {
      ({ client } = await setup([kit]));
    });

    it("is listed in tools/list", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("mcp__genie__get_kit");
    });

    it("returns kit metadata as JSON text content", async () => {
      const result = await client.callTool({
        name: "mcp__genie__get_kit",
        arguments: { kitId: "kit-1" },
      });

      expect(result.isError).toBeFalsy();

      const text = (result.content as TextContent[])[0]?.text ?? "";
      const payload = JSON.parse(text) as Record<string, unknown>;

      expect(payload).toEqual({
        id: "kit-1",
        name: "Acme UI Kit",
        type: "GENIE_KIT",
        canEdit: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
  });

  describe("ProjectNotFoundError", () => {
    beforeEach(async () => {
      ({ client } = await setup([]));
    });

    it("returns isError with code -32602 for unknown kitId", async () => {
      const result = await client.callTool({
        name: "mcp__genie__get_kit",
        arguments: { kitId: "does-not-exist" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as TextContent[])[0]?.text ?? "";
      expect(text).toContain("-32602");
      expect(text).toContain("ProjectNotFoundError");
      expect(text).toContain("does-not-exist");
    });
  });

  describe("WrongProjectTypeError", () => {
    const nonKit = makeKit({ id: "repo-1", type: "OTHER" });

    beforeEach(async () => {
      ({ client } = await setup([nonKit]));
    });

    it("returns isError with code -32602 when project is not a UI kit", async () => {
      const result = await client.callTool({
        name: "mcp__genie__get_kit",
        arguments: { kitId: "repo-1" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as TextContent[])[0]?.text ?? "";
      expect(text).toContain("-32602");
      expect(text).toContain("WrongProjectTypeError");
      expect(text).toContain("repo-1");
    });
  });
});
