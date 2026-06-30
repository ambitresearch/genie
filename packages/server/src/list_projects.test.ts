import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { InMemoryProjectStore } from "./store/memory.js";
import type { Project, ProjectStore, StoreWarning } from "./store/interface.js";

// ── Fixtures ─────────────────────────────────────────────────

const WORKSPACE_A: Project = {
  id: "proj-alpha",
  name: "Alpha Site",
  kind: "workspace",
  defaultKitId: "kit-acme",
  kitBindings: [{ kitId: "kit-acme", isDefault: true }],
  updatedAt: "2026-06-01T00:00:00Z",
  canEdit: true,
};

const WORKSPACE_B: Project = {
  id: "proj-beta",
  name: "Beta App",
  kind: "workspace",
  defaultKitId: null,
  kitBindings: [],
  updatedAt: "2026-06-02T00:00:00Z",
  canEdit: false,
};

const BLUEPRINT_A: Project = {
  id: "bp-starter",
  name: "Starter Blueprint",
  kind: "blueprint",
  defaultKitId: "kit-base",
  kitBindings: [
    { kitId: "kit-base", isDefault: true },
    { kitId: "kit-icons", isDefault: false },
  ],
  updatedAt: "2026-05-15T00:00:00Z",
  canEdit: true,
};

const BLUEPRINT_B: Project = {
  id: "bp-admin",
  name: "Admin Blueprint",
  kind: "blueprint",
  defaultKitId: "kit-admin",
  kitBindings: [{ kitId: "kit-admin", isDefault: true }],
  updatedAt: "2026-05-20T00:00:00Z",
  canEdit: true,
};

// ── Helpers ──────────────────────────────────────────────────

/** Connect a test client to a genie server and return both. */
async function makeClient(store?: ProjectStore) {
  const server = createServer({ projectStore: store });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

/** Call mcp__genie__list_projects and parse the JSON result. */
async function callListProjects(client: Client) {
  const result = await client.callTool({
    name: "mcp__genie__list_projects",
    arguments: {},
  });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    projects: Project[];
    _meta?: { warnings: StoreWarning[] };
  };
}

// ── A ProjectStore that simulates an unreachable backend ──────

class PartialFailureStore implements ProjectStore {
  constructor(
    private localProjects: Project[],
    private warnings: StoreWarning[],
  ) {}

  async listProjects(): Promise<[Project[], StoreWarning[]]> {
    return [[...this.localProjects], [...this.warnings]];
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("list_projects tool", () => {
  let store: InMemoryProjectStore;

  beforeEach(() => {
    store = new InMemoryProjectStore();
  });

  // AC1 — Tool name is mcp__genie__list_projects
  it("is listed in tools/list as mcp__genie__list_projects", async () => {
    const { client } = await makeClient(store);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp__genie__list_projects");
    await client.close();
  });

  // AC2 — Description ≤ 2 KB and JSON Schema is Draft 7 only
  it("has a description under 2 KB", async () => {
    const { client } = await makeClient(store);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "mcp__genie__list_projects");
    expect(tool).toBeDefined();
    const descBytes = new TextEncoder().encode(tool!.description ?? "").length;
    expect(descBytes).toBeLessThanOrEqual(2048);
    await client.close();
  });

  // AC3 — Input is {}
  it("accepts empty input", async () => {
    const { client } = await makeClient(store);
    // Should not throw
    const result = await callListProjects(client);
    expect(result).toHaveProperty("projects");
    await client.close();
  });

  // AC3 — Input is {} (rejects extra properties)
  it("rejects non-empty input arguments", async () => {
    const { client } = await makeClient(store);
    const result = await client.callTool({
      name: "mcp__genie__list_projects",
      arguments: { unexpected: "value" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unrecognized");
    await client.close();
  });

  // AC6 — Returns [] when no projects exist
  it("returns empty array when no projects exist", async () => {
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result.projects).toEqual([]);
    expect(result._meta).toBeUndefined();
    await client.close();
  });

  // AC4 — Returns projects with expected fields
  it("returns projects with id, name, kind, defaultKitId, kitBindings, updatedAt, canEdit", async () => {
    store.seed([WORKSPACE_A]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result.projects).toHaveLength(1);
    const p = result.projects[0]!;
    expect(p).toMatchObject({
      id: "proj-alpha",
      name: "Alpha Site",
      kind: "workspace",
      defaultKitId: "kit-acme",
      canEdit: true,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    expect(p.kitBindings).toEqual([{ kitId: "kit-acme", isDefault: true }]);
    await client.close();
  });

  // AC5 — Includes both workspace and blueprint projects
  it("includes both workspace and blueprint projects", async () => {
    store.seed([WORKSPACE_A, BLUEPRINT_A]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result.projects).toHaveLength(2);
    const kinds = result.projects.map((p) => p.kind);
    expect(kinds).toContain("workspace");
    expect(kinds).toContain("blueprint");
    await client.close();
  });

  // AC8 — Results are deterministically sorted by kind, then name, then id
  it("sorts results by kind, then name, then id", async () => {
    // Seed in non-sorted order
    store.seed([WORKSPACE_B, BLUEPRINT_A, WORKSPACE_A, BLUEPRINT_B]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    const ids = result.projects.map((p) => p.id);
    // Expected order:
    // blueprint: "Admin Blueprint" (bp-admin), "Starter Blueprint" (bp-starter)
    // workspace: "Alpha Site" (proj-alpha), "Beta App" (proj-beta)
    expect(ids).toEqual(["bp-admin", "bp-starter", "proj-alpha", "proj-beta"]);
    await client.close();
  });

  it("sorts by id when kind and name are identical", async () => {
    const dup1: Project = {
      ...WORKSPACE_A,
      id: "proj-zzz",
      name: "Same Name",
    };
    const dup2: Project = {
      ...WORKSPACE_A,
      id: "proj-aaa",
      name: "Same Name",
    };
    store.seed([dup1, dup2]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result.projects.map((p) => p.id)).toEqual(["proj-aaa", "proj-zzz"]);
    await client.close();
  });

  // AC7 — Local results still return with _meta.warnings when backend unreachable
  it("returns local results with _meta.warnings when backend is unreachable", async () => {
    const failStore = new PartialFailureStore(
      [WORKSPACE_A],
      [{ code: "BACKEND_UNREACHABLE", message: "git host timed out" }],
    );
    const { client } = await makeClient(failStore);
    const result = await callListProjects(client);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.id).toBe("proj-alpha");
    expect(result._meta).toBeDefined();
    expect(result._meta!.warnings).toHaveLength(1);
    expect(result._meta!.warnings[0]).toMatchObject({
      code: "BACKEND_UNREACHABLE",
      message: "git host timed out",
    });
    await client.close();
  });

  it("omits _meta when there are no warnings", async () => {
    store.seed([WORKSPACE_A]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result._meta).toBeUndefined();
    await client.close();
  });

  // Multiple kit bindings
  it("preserves all kit bindings for a project", async () => {
    store.seed([BLUEPRINT_A]);
    const { client } = await makeClient(store);
    const result = await callListProjects(client);
    expect(result.projects[0]!.kitBindings).toEqual([
      { kitId: "kit-base", isDefault: true },
      { kitId: "kit-icons", isDefault: false },
    ]);
    await client.close();
  });

  // Default server (no store injected) works
  it("works with default server options (no store injected)", async () => {
    const { client } = await makeClient();
    const result = await callListProjects(client);
    expect(result.projects).toEqual([]);
    await client.close();
  });
});
