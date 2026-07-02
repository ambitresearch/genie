import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer } from "../server.js";
import type { KitStore } from "../store/interface.js";
import { LocalFsKitStore } from "../store/local.js";
import {
  LIST_COMPONENTS_DESCRIPTION,
  LIST_COMPONENTS_TOOL_NAME,
} from "./list_components.js";

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

  it("returns [] when group filter matches nothing", async () => {
    const kit = await store.createKit("Empty Kit");
    const components = await store.listComponents({
      kitId: kit.id,
      group: "nonexistent",
    });
    expect(components).toEqual([]);
  });

  it("throws NotFoundError when kit does not exist", async () => {
    await expect(
      store.listComponents({ kitId: "nonexistent-kit" }),
    ).rejects.toThrow("Kit");
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
    expect(Buffer.byteLength(LIST_COMPONENTS_DESCRIPTION, "utf8")).toBeLessThanOrEqual(
      2048,
    );
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
