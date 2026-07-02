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

  it("answers tools/list with the built-in ping tool and the registered M1 tools", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ping");
    expect(names).toContain("mcp__genie__list_kits");
    expect(names).toContain("mcp__genie__create_project");
    expect(names).toContain("mcp__genie__list_projects");
    expect(names).toContain("mcp__genie__get_project");
    expect(names).toContain("mcp__genie__list_files");
    expect(names).toContain("mcp__genie__bind_kit");

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

  it("mcp__genie__list_projects lists fixture workspace and blueprint projects", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "genie-tool-projects-"));
    const server = createServer({ projectsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Fixture Workspace", kind: "workspace" },
    });
    await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Fixture Blueprint", kind: "blueprint" },
    });

    const result = await client.callTool({
      name: "mcp__genie__list_projects",
      arguments: {},
    });

    expect(result.structuredContent).toMatchObject({
      projects: [
        { id: "fixture-blueprint", name: "Fixture Blueprint", kind: "blueprint" },
        { id: "fixture-workspace", name: "Fixture Workspace", kind: "workspace" },
      ],
    });

    await client.close();
  });

  it("mcp__genie__get_project returns full detail for a fixture workspace", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "genie-tool-projects-"));
    const server = createServer({ projectsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Fixture Workspace", kind: "workspace" },
    });

    const result = await client.callTool({
      name: "mcp__genie__get_project",
      arguments: { projectId: "fixture-workspace" },
    });

    expect(result.structuredContent).toMatchObject({
      id: "fixture-workspace",
      name: "Fixture Workspace",
      kind: "workspace",
      screens: [],
      canEdit: true,
    });

    await client.close();
  });

  it("mcp__genie__get_project raises ERR_PROJECT_NOT_FOUND for a missing project", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "genie-tool-projects-"));
    const server = createServer({ projectsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({
      name: "mcp__genie__get_project",
      arguments: { projectId: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("ERR_PROJECT_NOT_FOUND");
    expect(text).toContain("does-not-exist");

    await client.close();
  });

  it("mcp__genie__bind_kit binds a real create_kit-created kit to a project end-to-end", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "genie-tool-projects-"));
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-tool-kits-"));
    const server = createServer({ projectsRoot, kitsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const kitResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const { kitId } = JSON.parse(
      (kitResult.content as { type: string; text: string }[])[0]?.text ?? "{}",
    ) as { kitId: string };

    await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Bound Workspace", kind: "workspace" },
    });

    const result = await client.callTool({
      name: "mcp__genie__bind_kit",
      arguments: { projectId: "bound-workspace", kitId, default: true },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: "bound-workspace",
      defaultKitId: kitId,
      kitBindings: [{ kitId, default: true }],
    });

    await client.close();
  });
});
