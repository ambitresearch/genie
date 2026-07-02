import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./create_project.js";
import {
  ERR_PROJECT_NOT_FOUND,
  GET_PROJECT_TOOL_NAME,
  getProject,
  registerGetProjectTool,
} from "./get_project.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-get-project-"));
}

let testClient: Client | null = null;

async function connectClient(store: ProjectStore): Promise<Client> {
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerGetProjectTool(server, store);
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

describe("getProject (standalone function)", () => {
  it("rejects malformed args before touching the store", async () => {
    const store = new ProjectStore(await tempProjectsRoot());
    await expect(getProject(store, { projectId: "AB" })).rejects.toThrow();
    await expect(getProject(store, {})).rejects.toThrow();
    await expect(getProject(store, { projectId: "valid-id", extra: true })).rejects.toThrow();
  });

  it("returns project detail for a valid id", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

    await expect(getProject(store, { projectId })).resolves.toMatchObject({
      id: projectId,
      name: "Checkout Flow",
      kind: "workspace",
      screens: [],
      canEdit: true,
    });
  });
});

describe("mcp__genie__get_project", () => {
  it("registers the tool with a strict input schema and an output schema", async () => {
    const client = await connectClient(new ProjectStore(await tempProjectsRoot()));
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === GET_PROJECT_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description?.length).toBeLessThanOrEqual(2048);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["projectId"],
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["id", "name", "kind", "kitBindings", "updatedAt", "canEdit", "screens"],
      additionalProperties: false,
    });
  });

  it("AC3 — returns id, name, kind, defaultKitId, kitBindings, screens, canEdit for a valid workspace", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({
      name: "Checkout Flow",
      kind: "workspace",
      kitBindings: [{ kitId: "commerce-kit", default: true }],
    });
    const client = await connectClient(store);

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      id: projectId,
      name: "Checkout Flow",
      kind: "workspace",
      defaultKitId: "commerce-kit",
      kitBindings: [{ kitId: "commerce-kit", default: true }],
      updatedAt: expect.any(String),
      canEdit: true,
      screens: [],
    });
  });

  it('AC4 — a blueprint project returns kind: "blueprint" through the same shape', async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({
      name: "Admin Starter",
      kind: "blueprint",
    });
    const client = await connectClient(store);

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId },
    });

    expect(result.structuredContent).toMatchObject({ id: projectId, kind: "blueprint" });
  });

  it("returns sourceBlueprintId for a workspace instantiated from a blueprint", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const blueprint = await store.createProject({ name: "Dashboard Blueprint", kind: "blueprint" });
    const workspace = await store.createProject({
      name: "Merchant Dashboard",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });
    const client = await connectClient(store);

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId: workspace.projectId },
    });

    expect(result.structuredContent).toMatchObject({
      id: workspace.projectId,
      sourceBlueprintId: blueprint.projectId,
    });
  });

  it("AC5 — an invalid id raises ERR_PROJECT_NOT_FOUND with the id echoed", async () => {
    const store = new ProjectStore(await tempProjectsRoot());
    const client = await connectClient(store);

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId: "no-such-project" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; message: string; projectId: string };
    expect(payload.code).toBe(ERR_PROJECT_NOT_FOUND);
    expect(payload.projectId).toBe("no-such-project");
    expect(payload.message).toContain("no-such-project");
  });

  it("AC6 — a read-only project returns canEdit: false", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({ name: "Read Only Project", kind: "workspace" });
    await writeFile(join(root, projectId, ".genie", ".readonly"), "", "utf8");
    const client = await connectClient(store);

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId },
    });

    expect(result.structuredContent).toMatchObject({ canEdit: false });
  });

  it("rejects malformed projectId at the MCP protocol layer", async () => {
    const client = await connectClient(new ProjectStore(await tempProjectsRoot()));

    const result = await client.callTool({
      name: GET_PROJECT_TOOL_NAME,
      arguments: { projectId: "AB" },
    });

    expect(result.isError).toBe(true);
  });

  // Note: unlike `list_projects` (whose `{}` input schema is a pre-built strict
  // ZodObject), `get_project`'s inputSchema is a raw shape — the same pattern
  // `get_kit`/`delete_project`/`list_files` use. The MCP SDK does not enforce
  // "no extra properties" at the protocol layer for raw shapes, only per-field
  // validators (hence the regex-rejection test above). Strict rejection of
  // unexpected keys IS enforced — just one layer down, in the standalone
  // `getProject()` function's `.strict()` schema — see the "standalone function"
  // describe block above for that coverage (defense-in-depth for direct callers).
});
