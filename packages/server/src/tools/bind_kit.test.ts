import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./create_project.js";
import { LocalFsKitStore } from "../store/local.js";
import { BIND_KIT_TOOL_NAME, bindKit, registerBindKitTool } from "./bind_kit.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-bind-kit-projects-"));
}

async function tempKitsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-bind-kit-kits-"));
}

/** A ready-to-bind fixture: a workspace project plus a real, existing kit. */
async function fixture(): Promise<{
  store: ProjectStore;
  kitStore: LocalFsKitStore;
  projectId: string;
}> {
  const kitStore = new LocalFsKitStore(await tempKitsRoot());
  await kitStore.createKit("Commerce Kit", "commerce-kit");
  const store = new ProjectStore(await tempProjectsRoot(), kitStore);
  const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });
  return { store, kitStore, projectId };
}

let testClient: Client | null = null;

async function connectClient(store: ProjectStore): Promise<Client> {
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerBindKitTool(server, store);
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

describe("bindKit (standalone function)", () => {
  it("rejects malformed args before touching the store", async () => {
    const { store } = await fixture();
    await expect(bindKit(store, { projectId: "AB", kitId: "commerce-kit" })).rejects.toThrow();
    await expect(bindKit(store, { projectId: "valid-id" })).rejects.toThrow();
    await expect(
      bindKit(store, { projectId: "valid-id", kitId: "commerce-kit", extra: true }),
    ).rejects.toThrow();
    await expect(bindKit(store, { projectId: "valid-id", kitId: "AB" })).rejects.toThrow();
  });

  it("AC2 — accepts { projectId, kitId, default? } and returns the updated ProjectSummary", async () => {
    const { store, projectId } = await fixture();

    await expect(bindKit(store, { projectId, kitId: "commerce-kit" })).resolves.toMatchObject({
      id: projectId,
      kitBindings: [{ kitId: "commerce-kit" }],
    });
  });
});

describe("mcp__genie__bind_kit", () => {
  it("registers the tool with a strict input schema and an output schema", async () => {
    const { store } = await fixture();
    const client = await connectClient(store);
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === BIND_KIT_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description?.length).toBeLessThanOrEqual(2048);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["projectId", "kitId"],
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["id", "name", "kind", "kitBindings", "updatedAt", "canEdit"],
      additionalProperties: false,
    });
  });

  it("AC1 — tool name is mcp__genie__bind_kit", () => {
    expect(BIND_KIT_TOOL_NAME).toBe("mcp__genie__bind_kit");
  });

  it("AC3 — given a valid project and kit, writes the binding to .genie/project.json", async () => {
    const { store, projectId } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "commerce-kit" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: projectId,
      kitBindings: [{ kitId: "commerce-kit" }],
    });
  });

  it("AC4 — default: true sets defaultKitId and clears default from a previous binding", async () => {
    const { store, kitStore, projectId } = await fixture();
    await kitStore.createKit("Admin Kit", "admin-kit");
    const client = await connectClient(store);

    await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "commerce-kit", default: true },
    });
    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "admin-kit", default: true },
    });

    expect(result.structuredContent).toMatchObject({
      defaultKitId: "admin-kit",
      kitBindings: [{ kitId: "commerce-kit" }, { kitId: "admin-kit", default: true }],
    });
  });

  it("AC5 — an invalid projectId raises ERR_PROJECT_NOT_FOUND", async () => {
    const { store } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId: "no-such-project", kitId: "commerce-kit" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; message: string; projectId: string };
    expect(payload.code).toBe("ERR_PROJECT_NOT_FOUND");
    expect(payload.projectId).toBe("no-such-project");
    expect(payload.message).toContain("no-such-project");
  });

  it("AC6 — an invalid kitId raises ERR_KIT_NOT_FOUND", async () => {
    const { store, projectId } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "no-such-kit" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; message: string; kitId: string };
    expect(payload.code).toBe("ERR_KIT_NOT_FOUND");
    expect(payload.kitId).toBe("no-such-kit");
  });

  it("AC7 — a blueprint project accepts a binding, which copies into a derived workspace", async () => {
    const kitStore = new LocalFsKitStore(await tempKitsRoot());
    await kitStore.createKit("Core Kit", "core-kit");
    const store = new ProjectStore(await tempProjectsRoot(), kitStore);
    const blueprint = await store.createProject({ name: "Admin Starter", kind: "blueprint" });
    const client = await connectClient(store);

    const boundResult = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId: blueprint.projectId, kitId: "core-kit", default: true },
    });
    expect(boundResult.isError).toBeFalsy();

    const workspace = await store.createProject({
      name: "Merchant Dashboard",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });

    await expect(store.getProject(workspace.projectId)).resolves.toMatchObject({
      kitBindings: [{ kitId: "core-kit", default: true }],
      defaultKitId: "core-kit",
    });
  });

  it("AC8 — binding the same kit twice is idempotent", async () => {
    const { store, projectId } = await fixture();
    const client = await connectClient(store);

    await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "commerce-kit" },
    });
    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "commerce-kit" },
    });

    expect(result.structuredContent).toMatchObject({
      kitBindings: [{ kitId: "commerce-kit" }],
    });
  });

  it("raises ERR_PROJECT_READONLY for a read-only project", async () => {
    const { store, projectId } = await fixture();
    await writeFile(join(store.root, projectId, ".genie", ".readonly"), "", "utf8");
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: "commerce-kit" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("ERR_PROJECT_READONLY");
  });

  it("rejects malformed projectId/kitId at the MCP protocol layer", async () => {
    const { store } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId: "AB", kitId: "commerce-kit" },
    });

    expect(result.isError).toBe(true);
  });
});
