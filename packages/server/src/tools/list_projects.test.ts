import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./create_project.js";
import {
  LIST_PROJECTS_TOOL_NAME,
  ProjectBackendUnreachableError,
  registerListProjectsTool,
} from "./list_projects.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-list-projects-"));
}

describe("registerListProjectsTool", () => {
  it("registers mcp__genie__list_projects with an empty input schema", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const store = new ProjectStore(await tempProjectsRoot());

    registerListProjectsTool(server, store);

    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === LIST_PROJECTS_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.description?.length).toBeLessThanOrEqual(2048);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["projects"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    await client.close();
  });

  it("rejects non-empty input", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const store = new ProjectStore(await tempProjectsRoot());
    registerListProjectsTool(server, store);

    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    await expect(
      client.callTool({
        name: LIST_PROJECTS_TOOL_NAME,
        arguments: { unexpected: true },
      }),
    ).resolves.toMatchObject({ isError: true });
    await client.close();
  });

  it("returns local projects and warnings when an additional backend is unreachable", async () => {
    const store = new ProjectStore(await tempProjectsRoot());
    await store.createProject({ name: "Workspace A", kind: "workspace" });
    const server = new McpServer({ name: "test", version: "0" });
    registerListProjectsTool(server, store, [
      {
        name: "git-host",
        listProjects: async () => {
          throw new ProjectBackendUnreachableError(
            "ERR_BACKEND_UNREACHABLE",
            "Git host https://git.example.test/api unreachable; showing local projects only.",
          );
        },
      },
    ]);

    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const result = await client.callTool({ name: LIST_PROJECTS_TOOL_NAME, arguments: {} });

    expect(result).toMatchObject({
      structuredContent: {
        projects: [
          {
            id: "workspace-a",
            name: "Workspace A",
            kind: "workspace",
            kitBindings: [],
            canEdit: true,
          },
        ],
      },
      _meta: {
        warnings: [
          {
            code: "ERR_BACKEND_UNREACHABLE",
            message:
              "Git host https://git.example.test/api unreachable; showing local projects only.",
            backend: "git-host",
          },
        ],
      },
    });
    await client.close();
  });

  it("turns generic git-host failures into backend warnings", async () => {
    const store = new ProjectStore(await tempProjectsRoot());
    await store.createProject({ name: "Workspace A", kind: "workspace" });
    const server = new McpServer({ name: "test", version: "0" });
    registerListProjectsTool(server, store, [
      {
        name: "git-host",
        listProjects: async () => {
          throw new TypeError("fetch failed");
        },
      },
    ]);

    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const result = await client.callTool({ name: LIST_PROJECTS_TOOL_NAME, arguments: {} });

    expect(result).toMatchObject({
      structuredContent: {
        projects: [{ id: "workspace-a" }],
      },
      _meta: {
        warnings: [
          {
            code: "ERR_BACKEND_UNREACHABLE",
            backend: "git-host",
          },
        ],
      },
    });
    expect(
      ((result._meta as { warnings?: { message: string }[] } | undefined)?.warnings ?? [])[0]
        ?.message,
    ).toContain("fetch failed");
    await client.close();
  });
});
