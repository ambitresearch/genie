import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { LocalProjectStore } from "../store/local.js";
import type { ProjectMeta } from "../store/interface.js";

/** Parse the text content from an MCP tool result. */
function parseResult(result: { content: unknown }): unknown {
  const items = result.content as { type: string; text: string }[];
  return JSON.parse(items[0]!.text);
}

describe("create_project tool", () => {
  let baseDir: string;
  let store: LocalProjectStore;
  let client: Client;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    store = new LocalProjectStore(baseDir);
    const server = createServer({ store: { project: store } });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    return async () => {
      await client.close();
      await rm(baseDir, { recursive: true, force: true });
    };
  });

  // ── AC1: Tool name ──────────────────────────────────────────────────────

  it("AC1 — tool is registered as create_project", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("create_project");
  });

  // ── AC2: Input schema ───────────────────────────────────────────────────

  it("AC2 — input schema accepts name, kind, fromBlueprintId, kitBindings", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_project");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema;
    expect(schema.properties).toHaveProperty("name");
    expect(schema.properties).toHaveProperty("kind");
    expect(schema.properties).toHaveProperty("fromBlueprintId");
    expect(schema.properties).toHaveProperty("kitBindings");
  });

  // ── AC3: Blank workspace ────────────────────────────────────────────────

  it("AC3 — blank workspace writes .genie/project.json with kind workspace", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "My App", kind: "workspace" },
    });

    const project = parseResult(result) as ProjectMeta;
    expect(project.name).toBe("My App");
    expect(project.kind).toBe("workspace");
    expect(project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(project.kitBindings).toEqual([]);
    expect(project.sourceBlueprintId).toBeUndefined();

    // Verify on-disk
    const raw = await readFile(
      join(baseDir, "projects", project.id, ".genie", "project.json"),
      "utf-8",
    );
    const ondisk = JSON.parse(raw);
    expect(ondisk.kind).toBe("workspace");
    expect(ondisk.name).toBe("My App");
  });

  // ── AC4: Blank blueprint ────────────────────────────────────────────────

  it("AC4 — blank blueprint writes .genie/project.json with kind blueprint", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "Starter Kit", kind: "blueprint" },
    });

    const project = parseResult(result) as ProjectMeta;
    expect(project.kind).toBe("blueprint");
    expect(project.name).toBe("Starter Kit");

    const raw = await readFile(
      join(baseDir, "projects", project.id, ".genie", "project.json"),
      "utf-8",
    );
    const ondisk = JSON.parse(raw);
    expect(ondisk.kind).toBe("blueprint");
  });

  // ── AC5: Workspace from blueprint ───────────────────────────────────────

  it("AC5 — workspace from blueprint copies starter files and kit bindings", async () => {
    // Create a blueprint with kit bindings
    const bpResult = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Dashboard Blueprint",
        kind: "blueprint",
        kitBindings: [{ kitId: "kit-1", alias: "primary" }],
      },
    });
    const blueprint = parseResult(bpResult) as ProjectMeta;

    // Add a starter file to the blueprint
    const starterFile = join(
      baseDir,
      "projects",
      blueprint.id,
      "src",
      "App.tsx",
    );
    await mkdir(join(baseDir, "projects", blueprint.id, "src"), {
      recursive: true,
    });
    await writeFile(starterFile, 'export const App = () => <div>Hello</div>;\n');

    // Create workspace from blueprint
    const wsResult = await client.callTool({
      name: "create_project",
      arguments: {
        name: "My Dashboard",
        kind: "workspace",
        fromBlueprintId: blueprint.id,
      },
    });
    const workspace = parseResult(wsResult) as ProjectMeta;

    expect(workspace.kind).toBe("workspace");
    expect(workspace.sourceBlueprintId).toBe(blueprint.id);
    expect(workspace.kitBindings).toEqual([
      { kitId: "kit-1", alias: "primary" },
    ]);

    // Verify starter file was copied
    const copiedFile = await readFile(
      join(baseDir, "projects", workspace.id, "src", "App.tsx"),
      "utf-8",
    );
    expect(copiedFile).toContain("Hello");
  });

  it("AC5 — kitBindings override blueprint bindings when provided", async () => {
    const bpResult = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Base BP",
        kind: "blueprint",
        kitBindings: [{ kitId: "old-kit" }],
      },
    });
    const blueprint = parseResult(bpResult) as ProjectMeta;

    const wsResult = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Custom WS",
        kind: "workspace",
        fromBlueprintId: blueprint.id,
        kitBindings: [{ kitId: "new-kit", alias: "override" }],
      },
    });
    const workspace = parseResult(wsResult) as ProjectMeta;
    expect(workspace.kitBindings).toEqual([
      { kitId: "new-kit", alias: "override" },
    ]);
  });

  // ── AC6: Blueprint isolation ────────────────────────────────────────────

  it("AC6 — later blueprint edits do not mutate derived workspaces", async () => {
    // Create blueprint
    const bpResult = await client.callTool({
      name: "create_project",
      arguments: { name: "Isolated BP", kind: "blueprint" },
    });
    const blueprint = parseResult(bpResult) as ProjectMeta;

    // Add a file to blueprint
    const bpFile = join(
      baseDir,
      "projects",
      blueprint.id,
      "starter.txt",
    );
    await writeFile(bpFile, "original");

    // Create workspace from blueprint
    const wsResult = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Derived WS",
        kind: "workspace",
        fromBlueprintId: blueprint.id,
      },
    });
    const workspace = parseResult(wsResult) as ProjectMeta;

    // Modify the blueprint file AFTER workspace creation
    await writeFile(bpFile, "modified");

    // Workspace file should still have the original content
    const wsFile = await readFile(
      join(baseDir, "projects", workspace.id, "starter.txt"),
      "utf-8",
    );
    expect(wsFile).toBe("original");
  });

  // ── AC7: Duplicate name ─────────────────────────────────────────────────

  it("AC7 — duplicate name raises ERR_PROJECT_EXISTS with a suggested slug", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { name: "Dupe", kind: "workspace" },
    });

    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "Dupe", kind: "workspace" },
    });

    expect(result.isError).toBe(true);
    const err = parseResult(result) as {
      error: string;
      suggestedSlug: string;
    };
    expect(err.error).toBe("ERR_PROJECT_EXISTS");
    expect(err.suggestedSlug).toMatch(/^Dupe-/);
  });

  // ── AC8: Invalid blueprint ──────────────────────────────────────────────

  it("AC8 — invalid fromBlueprintId raises ERR_BLUEPRINT_NOT_FOUND", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Bad Ref",
        kind: "workspace",
        fromBlueprintId: "nonexistent-id",
      },
    });

    expect(result.isError).toBe(true);
    const err = parseResult(result) as { error: string };
    expect(err.error).toBe("ERR_BLUEPRINT_NOT_FOUND");
  });

  it("AC8 — referencing a workspace as blueprint raises ERR_BLUEPRINT_NOT_FOUND", async () => {
    // Create a workspace, then try to use it as a blueprint
    const wsResult = await client.callTool({
      name: "create_project",
      arguments: { name: "Not a blueprint", kind: "workspace" },
    });
    const workspace = parseResult(wsResult) as ProjectMeta;

    const result = await client.callTool({
      name: "create_project",
      arguments: {
        name: "From WS",
        kind: "workspace",
        fromBlueprintId: workspace.id,
      },
    });

    expect(result.isError).toBe(true);
    const err = parseResult(result) as { error: string };
    expect(err.error).toBe("ERR_BLUEPRINT_NOT_FOUND");
  });
});

describe("create_project — server without store", () => {
  it("does not register create_project when no store is provided", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("create_project");
    expect(tools.map((t) => t.name)).toContain("ping");

    await client.close();
  });
});
