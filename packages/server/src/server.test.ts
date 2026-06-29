import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_INFO } from "./server.js";

describe("createServer", () => {
  it("builds a server with the genie identity", () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(SERVER_INFO.name).toBe("genie");
  });

  it("can be constructed repeatedly without shared state", () => {
    const a = createServer();
    const b = createServer();
    expect(a).not.toBe(b);
  });

  it("answers tools/list with the built-in ping tool and create_project", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ping");
    expect(tools.map((t) => t.name)).toContain("mcp__genie__create_project");

    await client.close();
  });

  it("ping returns pong with the server version", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({ name: "ping", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("pong");
    expect(text).toContain(SERVER_INFO.version);

    await client.close();
  });

  it("mcp__genie__create_project creates a project through the MCP tool", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "genie-tool-projects-"));
    const server = createServer({ projectsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Tool Workspace", kind: "workspace" },
    });

    expect(result.structuredContent).toEqual({ projectId: "tool-workspace" });
    await expect(
      readFile(join(projectsRoot, "tool-workspace", ".genie", "project.json"), "utf8"),
    ).resolves.toContain('"kind": "workspace"');

    await client.close();
  });
});
