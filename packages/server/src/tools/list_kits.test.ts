import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer } from "../server.js";
import { KIT_TYPE, type KitStore } from "../store/interface.js";
import { LocalFsKitStore } from "../store/local.js";
import { LIST_KITS_DESCRIPTION, LIST_KITS_TOOL_NAME, listWritableKits } from "./list_kits.js";

describe("listWritableKits", () => {
  it("maps editable GENIE_KIT store records to the public list_kits result", async () => {
    const store: KitStore = {
      async listKits() {
        return [
          {
            id: "commerce-kit",
            name: "Commerce Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ];
      },
      async getKit() {
        throw new Error("not used");
      },
      async listFiles() {
        throw new Error("not used");
      },
      async listComponents() {
        throw new Error("not used");
      },
      async readFile() {
        throw new Error("not used");
      },
      async createKit() {
        throw new Error("not used");
      },
      async openPlan() {
        throw new Error("not used");
      },
      async commitPlan() {
        throw new Error("not used");
      },
      async closePlan() {
        throw new Error("not used");
      },
    };

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "commerce-kit",
        name: "Commerce Kit",
        owner: "local",
        updatedAt: "2026-06-01T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("returns [] when the store has no kits", async () => {
    const store = {
      async listKits() {
        return [];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([]);
  });

  it("filters out non-GENIE_KIT records returned by a store adapter", async () => {
    const store = {
      async listKits() {
        return [
          {
            id: "legacy-design-sync",
            name: "Legacy",
            type: "PROJECT_TYPE_DESIGN_SYSTEM",
            createdAt: "2026-06-01T10:00:00.000Z",
          },
          {
            id: "native-kit",
            name: "Native Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-02T10:00:00.000Z",
          },
        ];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "native-kit",
        name: "Native Kit",
        owner: "local",
        updatedAt: "2026-06-02T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("keeps the MCP tool description under Claude's 2 KB truncation limit", () => {
    expect(Buffer.byteLength(LIST_KITS_DESCRIPTION, "utf8")).toBeLessThanOrEqual(2048);
  });
});

describe("LocalFsKitStore.listKits", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("filters metadata files whose stored type is not GENIE_KIT", async () => {
    const store = new LocalFsKitStore(join(tempDir, "kits"));
    await store.createKit("Native Kit", "native-kit");

    await mkdir(join(tempDir, "kits", "foreign-kit"), { recursive: true });
    await writeFile(
      join(tempDir, "kits", "foreign-kit", ".kit.json"),
      JSON.stringify(
        {
          id: "foreign-kit",
          name: "Foreign Kit",
          type: "PROJECT_TYPE_DESIGN_SYSTEM",
          createdAt: "2026-06-01T10:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(store.listKits()).resolves.toHaveLength(1);
    await expect(store.listKits()).resolves.toEqual([
      expect.objectContaining({ id: "native-kit", type: KIT_TYPE }),
    ]);
  });
});

describe("mcp__genie__list_kits tool", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-mcp-"));
    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is listed in tools/list with an object-only input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === LIST_KITS_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description).toBe(LIST_KITS_DESCRIPTION);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["kits"],
      additionalProperties: false,
    });
  });

  it("returns [] through MCP when the user has no kits", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ kits: [] });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });

  it("lists editable LocalFsStore kits through MCP", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;
    const kitJson = JSON.parse(
      await readFile(join(tempDir, "kits", kitId, ".kit.json"), "utf8"),
    ) as { createdAt: string };

    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      kits: [
        {
          id: kitId,
          name: "Commerce Kit",
          owner: "local",
          updatedAt: kitJson.createdAt,
          canEdit: true,
        },
      ],
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      {
        id: kitId,
        name: "Commerce Kit",
        owner: "local",
        updatedAt: kitJson.createdAt,
        canEdit: true,
      },
    ]);
  });

  /**
   * 🔒 REGRESSION LOCK — one malformed neighbour must not take out the whole listing.
   *
   * `readMetaIfReadable`'s docblock in `store/local.ts` promises exactly this:
   * "one bad entry must not fail the whole listing". It keeps that promise ONLY
   * for bytes that fail to PARSE. A `.kit.json` that is valid JSON but omits a
   * field `KitMeta` declares REQUIRED sails straight through it — and `KitMeta`
   * is enforced by a cast (`JSON.parse(raw) as T`), not a schema, so nothing
   * downstream catches it either. The promise was kept for the rarer fault and
   * broken for the commoner one.
   *
   * The blast radius is why this is pinned at the PROTOCOL layer and not only in
   * the store contract. `listWritableKits` maps `updatedAt: kit.updatedAt ??
   * kit.createdAt`, so an absent `createdAt` yields `undefined`; the MCP SDK then
   * validates the result against `outputSchema`, where `updatedAt` is a required
   * string, and rejects the ENTIRE response with -32602. Every healthy kit
   * disappears with it, and the error names `kits[N].updatedAt` rather than the
   * offending kit's id — so the user cannot tell which directory to repair.
   *
   * Both assertions are load-bearing and neither implies the other:
   *   - `isError` falsy proves the response survived output validation at all
   *   - the healthy kit being PRESENT proves that survival was not achieved by
   *     returning an empty list
   */
  it("🔒 lists healthy kits when a neighbour's .kit.json omits a required field", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;

    // Hand-written rather than seeded: the shared `test/helpers/seed-kit.ts`
    // always writes a complete `createdAt`, so a malformed-meta fixture has to
    // bypass it by construction. This is the same seeding shape as "filters
    // metadata files whose stored type is not GENIE_KIT" above — the only
    // difference is WHICH part of the declared shape is violated: a wrong `type`
    // there, an absent `createdAt` here. That filter proves the kits root was
    // always known to hold foreign `.kit.json` files; this is the sibling class
    // it did not cover.
    await mkdir(join(tempDir, "kits", "legacy-kit"), { recursive: true });
    await writeFile(
      join(tempDir, "kits", "legacy-kit", ".kit.json"),
      JSON.stringify({ id: "legacy-kit", name: "Legacy Kit", type: KIT_TYPE }, null, 2),
      "utf8",
    );

    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBeFalsy();

    const { kits } = result.structuredContent as { kits: { id: string }[] };
    expect(kits.map((kit) => kit.id)).toEqual([kitId]);
  });

  it("rejects unexpected arguments because the schema has no inputs", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: { owner: "someone" },
    });

    expect(result.isError).toBe(true);
  });
});
