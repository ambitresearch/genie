import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../project-store.js";
import { createServer } from "../server.js";

async function connectClient(rootDir: string): Promise<Client> {
  const server = createServer({ projectStore: new ProjectStore({ rootDir }) });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("mcp__genie__create_project", () => {
  it("is advertised by tools/list", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "genie-create-project-tool-"));
    const client = await connectClient(rootDir);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain("mcp__genie__create_project");
    await client.close();
  });

  it("creates a project and returns the projectId through MCP", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "genie-create-project-tool-"));
    const client = await connectClient(rootDir);

    const result = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Tool Workspace", kind: "workspace" },
    });

    expect(result.structuredContent).toEqual({ projectId: "tool-workspace" });
    await client.close();
  });

  it("surfaces duplicate project errors through MCP", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "genie-create-project-tool-"));
    const client = await connectClient(rootDir);
    await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Duplicate Project", kind: "workspace" },
    });

    const result = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Duplicate Project", kind: "blueprint" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "ERR_PROJECT_EXISTS",
      details: { suggestedSlug: "duplicate-project-2" },
    });
    await client.close();
  });

  it("surfaces missing blueprint errors through MCP", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "genie-create-project-tool-"));
    const client = await connectClient(rootDir);

    const result = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: {
        name: "Traversal Workspace",
        kind: "workspace",
        fromBlueprintId: "../external-blueprint",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "ERR_BLUEPRINT_NOT_FOUND",
      details: { blueprintId: "../external-blueprint" },
    });
    await client.close();
  });
});
