import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer } from "../server.js";
import { KIT_TYPE, type KitStore } from "../store/interface.js";
import { LocalFsKitStore } from "../store/local.js";
import { LIST_KITS_DESCRIPTION, LIST_KITS_TOOL_NAME, listWritableKits } from "./list_kits.js";

describe("listWritableKits", () => {
  it("maps editable GENIE_KIT store records to the public list_kits result", async () => {
    const store: KitStore = {
      async listKits() {
        return [
          {
            id: "commerce-kit",
            name: "Commerce Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ];
      },
      async getKit() {
        throw new Error("not used");
      },
      async listFiles() {
        throw new Error("not used");
      },
      async readFile() {
        throw new Error("not used");
      },
      async createKit() {
        throw new Error("not used");
      },
      async openPlan() {
        throw new Error("not used");
      },
      async commitPlan() {
        throw new Error("not used");
      },
      async closePlan() {
        throw new Error("not used");
      },
    };

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "commerce-kit",
        name: "Commerce Kit",
        owner: "local",
        updatedAt: "2026-06-01T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("returns [] when the store has no kits", async () => {
    const store = {
      async listKits() {
        return [];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([]);
  });

  it("filters out non-GENIE_KIT records returned by a store adapter", async () => {
    const store = {
      async listKits() {
        return [
          {
            id: "legacy-design-sync",
            name: "Legacy",
            type: "PROJECT_TYPE_DESIGN_SYSTEM",
            createdAt: "2026-06-01T10:00:00.000Z",
          },
          {
            id: "native-kit",
            name: "Native Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-02T10:00:00.000Z",
          },
        ];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "native-kit",
        name: "Native Kit",
        owner: "local",
        updatedAt: "2026-06-02T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("keeps the MCP tool description under Claude's 2 KB truncation limit", () => {
    expect(Buffer.byteLength(LIST_KITS_DESCRIPTION, "utf8")).toBeLessThanOrEqual(2048);
  });
});

describe("LocalFsKitStore.listKits", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("filters metadata files whose stored type is not GENIE_KIT", async () => {
    const store = new LocalFsKitStore(join(tempDir, "kits"));
    await store.createKit("Native Kit", "native-kit");

    await mkdir(join(tempDir, "kits", "foreign-kit"), { recursive: true });
    await writeFile(
      join(tempDir, "kits", "foreign-kit", ".kit.json"),
      JSON.stringify(
        {
          id: "foreign-kit",
          name: "Foreign Kit",
          type: "PROJECT_TYPE_DESIGN_SYSTEM",
          createdAt: "2026-06-01T10:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(store.listKits()).resolves.toHaveLength(1);
    await expect(store.listKits()).resolves.toEqual([
      expect.objectContaining({ id: "native-kit", type: KIT_TYPE }),
    ]);
  });
});

describe("mcp__genie__list_kits tool", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-mcp-"));
    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is listed in tools/list with an object-only input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === LIST_KITS_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description).toBe(LIST_KITS_DESCRIPTION);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["kits"],
      additionalProperties: false,
    });
  });

  it("returns [] through MCP when the user has no kits", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ kits: [] });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });

  it("lists editable LocalFsStore kits through MCP", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;
    const kitJson = JSON.parse(
      await readFile(join(tempDir, "kits", kitId, ".kit.json"), "utf8"),
    ) as { createdAt: string };

    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      kits: [
        {
          id: kitId,
          name: "Commerce Kit",
          owner: "local",
          updatedAt: kitJson.createdAt,
          canEdit: true,
        },
      ],
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      {
        id: kitId,
        name: "Commerce Kit",
        owner: "local",
        updatedAt: kitJson.createdAt,
        canEdit: true,
      },
    ]);
  });

  it("rejects unexpected arguments because the schema has no inputs", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: { owner: "someone" },
    });

    expect(result.isError).toBe(true);
  });
});
