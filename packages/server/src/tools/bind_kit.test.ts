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
import { KIT_ID_SAFETY_MESSAGE } from "../store/kit-files.js";

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
  // Every case asserts the ZodError's issue shape instead of a bare
  // `.rejects.toThrow()`. A bare throw cannot evidence this test's own
  // "before touching the store" name, because a `ProjectStoreError` throws too
  // — and no `projectId` below exists in the fixture, so a call that reached
  // the store would still throw and still pass, for an unrelated reason.
  // `ProjectStoreError` carries no `issues`, so this discriminates the two.
  it("rejects malformed args before touching the store", async () => {
    const { store } = await fixture();

    const cases: { args: unknown; issues: { code: string; path: string }[] }[] = [
      {
        args: { projectId: "AB", kitId: "commerce-kit" },
        issues: [{ code: "invalid_format", path: "projectId" }],
      },
      { args: { projectId: "valid-id" }, issues: [{ code: "invalid_type", path: "kitId" }] },
      {
        args: { projectId: "valid-id", kitId: "commerce-kit", extra: true },
        issues: [{ code: "unrecognized_keys", path: "" }],
      },
    ];

    for (const { args, issues } of cases) {
      const rejection = (await bindKit(store, args).catch((error: unknown) => error)) as {
        issues?: { code: string; path: PropertyKey[] }[];
      };

      expect(
        rejection.issues?.map((issue) => ({ code: issue.code, path: issue.path.join(".") })),
        `expected a schema rejection for ${JSON.stringify(args)}, got ${String(rejection)}`,
      ).toEqual(issues);
    }
  });

  // Split out of the block above so the kitId gate has its own named case with
  // a concrete assertion, rather than one of five bare `.rejects.toThrow()`s.
  //
  // A bare throw cannot evidence this file's own "before touching the store"
  // claim, because a store error throws too. Two guards make the claim real:
  //   1. `projectId` is a REAL project and `kitId` would otherwise be bindable,
  //      so a well-formed id here RESOLVES — a rejection can only be the gate.
  //   2. Asserting the ZodError's issue paths proves `kitId` was the rejected
  //      field. A `ProjectStoreError` carries no `issues`, so a rejection that
  //      reached the store fails this loudly instead of passing silently.
  //
  // Previously `kitId: "AB"`. That id only failed while `kitId` was gated on
  // the `create_kit`-minted slug shape; `kitId` is an opaque, adapter-assigned
  // string, so "AB" is now legitimate and would reach the store — passing for
  // the wrong reason. (Concretely: `ProjectStore.bindKit` checks the project
  // before the kit, so with the old absent `projectId: "valid-id"` it would
  // have surfaced as ERR_PROJECT_NOT_FOUND — a bare throw, and green.) The ids
  // below are rejected by the shared kit-id safety rule (`isSafeKitId`) itself,
  // which is the rule the store actually enforces.
  it("rejects a malformed kitId at the schema, before touching the store", async () => {
    const { store, projectId } = await fixture();

    for (const kitId of ["", ".", "..", "a/b", "a\\b"]) {
      const rejection = (await bindKit(store, { projectId, kitId }).catch(
        (error: unknown) => error,
      )) as { issues?: { path: PropertyKey[] }[] };

      expect(
        rejection.issues?.map((issue) => issue.path.join(".")),
        `expected a kitId schema rejection for ${JSON.stringify(kitId)}, got ${String(rejection)}`,
      ).toEqual(["kitId"]);
    }
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

  // Named "absent", not "invalid": `"no-such-kit"` passes every id rule genie
  // has — it simply doesn't exist. Malformed ids never reach the store from
  // here; they're rejected by this tool's own gate, covered above in
  // `it("rejects malformed args before touching the store")`. The store-side
  // mapping for a malformed id is pinned in `create_project.test.ts`.
  it("AC6 — an absent kitId raises ERR_KIT_NOT_FOUND", async () => {
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

  // Renamed from "rejects malformed projectId/kitId at the MCP protocol
  // layer". The name claimed both fields, but the body passes the seeded,
  // valid `commerce-kit` — so it only ever evidenced the projectId gate, and
  // no protocol-layer kitId coverage existed anywhere in this file. The name
  // answered "is malformed kitId covered here?" with a false yes. Its missing
  // sibling is the test below.
  it("rejects a malformed projectId at the MCP protocol layer", async () => {
    const { store } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      // `kitId` is deliberately VALID here: this case isolates the projectId gate.
      arguments: { projectId: "AB", kitId: "commerce-kit" },
    });

    expect(result.isError, `expected a protocol-layer rejection: ${JSON.stringify(result)}`).toBe(
      true,
    );
    // The SDK reports only the failing issue — it does not echo the arguments —
    // so naming one field and excluding the other proves which gate fired.
    const text = JSON.stringify(result);
    expect(text).toContain("projectId");
    expect(text).not.toContain("kitId");
  });

  // The sibling the test above has always named but never had.
  //
  // `registerBindKitTool` declares `inputSchema`, so the MCP SDK validates
  // arguments BEFORE the handler runs — the tool's own `catch` never sees a
  // schema failure and there is no `ERR_*` code to match on. The reason check
  // is therefore on the message: `projectId` is real and `commerce-kit` would
  // bind, so only `kitId` can fail, and naming that field proves which gate
  // fired rather than merely that something did.
  it("rejects a malformed kitId at the MCP protocol layer", async () => {
    const { store, projectId } = await fixture();
    const client = await connectClient(store);

    const result = await client.callTool({
      name: BIND_KIT_TOOL_NAME,
      arguments: { projectId, kitId: ".." },
    });

    expect(result.isError, `expected a protocol-layer rejection: ${JSON.stringify(result)}`).toBe(
      true,
    );
    // Asserted against the shared constant rather than a copied literal, so the
    // test tracks the single source of truth for the gate. If `kitId` were ever
    // re-gated on a different predicate, this fails instead of silently
    // continuing to pass on the word "kitId" alone.
    const text = JSON.stringify(result);
    expect(text).toContain(KIT_ID_SAFETY_MESSAGE);
    expect(text).not.toContain("projectId");
    // ...and the rejection had no side effect: nothing was bound.
    await expect(store.getProject(projectId)).resolves.toMatchObject({ kitBindings: [] });
  });
});
