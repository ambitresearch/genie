import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, afterEach } from "vitest";
import type { FileOp, KitMeta, KitStore, PlanId } from "../store/interface.js";
import { NotFoundError, KIT_TYPE } from "../store/interface.js";
import {
  GET_KIT_TOOL_NAME,
  registerGetKitTool,
} from "./get_kit.js";

class MockKitStore implements KitStore {
  constructor(private readonly kits: Map<string, KitMeta>) {}

  async listKits(): Promise<KitMeta[]> {
    return Array.from(this.kits.values());
  }

  async getKit(kitId: string): Promise<KitMeta> {
    const kit = this.kits.get(kitId);
    if (!kit) throw new NotFoundError("Kit", kitId);
    return kit;
  }

  async listFiles(): Promise<string[]> {
    return [];
  }

  async readFile(): Promise<string> {
    return "";
  }

  async createKit(): Promise<KitMeta> {
    throw new Error("not implemented");
  }

  async openPlan(): Promise<PlanId> {
    return "plan";
  }

  async commitPlan(_kitId: string, _planId: PlanId, _ops: FileOp[]): Promise<void> {}

  async closePlan(): Promise<void> {}
}

let testClient: Client | null = null;

async function connectClient(kits: Map<string, KitMeta>): Promise<Client> {
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerGetKitTool(server, new MockKitStore(kits));
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  testClient = client;
  return client;
}

afterEach(async () => {
  if (testClient) {
    await testClient.close();
    testClient = null;
  }
});

describe("mcp__genie__get_kit", () => {
  it("returns kit metadata with the GENIE_KIT type", async () => {
    const client = await connectClient(
      new Map([
        [
          "core-kit",
          {
            id: "core-kit",
            name: "Core UI Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await client.callTool({
      name: GET_KIT_TOOL_NAME,
      arguments: { kitId: "core-kit" },
    });

    expect(result.structuredContent).toEqual({
      id: "core-kit",
      name: "Core UI Kit",
      type: "GENIE_KIT",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("returns ProjectNotFoundError with MCP invalid params for an unknown kitId", async () => {
    const client = await connectClient(new Map());

    const result = await client.callTool({
      name: GET_KIT_TOOL_NAME,
      arguments: { kitId: "missing-kit" },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("MCP error -32602");
    expect(text).toContain("ProjectNotFoundError");
  });

  it("returns WrongProjectTypeError when the project exists but is not a UI kit", async () => {
    const client = await connectClient(
      new Map([
        [
          "workspace-project",
          {
            id: "workspace-project",
            name: "Workspace Project",
            type: "GENIE_PROJECT" as unknown as typeof KIT_TYPE, // Simulate a different project type
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await client.callTool({
      name: GET_KIT_TOOL_NAME,
      arguments: { kitId: "workspace-project" },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("MCP error -32602");
    expect(text).toContain("WrongProjectTypeError");
  });
});
