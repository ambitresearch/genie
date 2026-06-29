import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { LocalFsStore } from "../store/local.js";
import { KIT_TYPE_GENIE } from "../store/interface.js";

describe("list_kits integration (LocalFsStore)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "genie-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const store = new LocalFsStore(root);
    const server = createServer({ kitStore: store });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return { client };
  }

  function callListKits(client: Client) {
    return client.callTool({ name: "list_kits", arguments: {} });
  }

  function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown>[] {
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "[]";
    return JSON.parse(text) as Record<string, unknown>[];
  }

  it("returns [] when the kits directory does not exist (AC6)", async () => {
    const { client } = await setup();
    const result = await callListKits(client);
    expect(parseResult(result)).toEqual([]);
    await client.close();
  });

  it("returns [] when the kits directory is empty", async () => {
    await mkdir(join(root, "kits"), { recursive: true });
    const { client } = await setup();
    const result = await callListKits(client);
    expect(parseResult(result)).toEqual([]);
    await client.close();
  });

  it("discovers a kit directory and uses defaults for missing meta.json", async () => {
    const kitDir = join(root, "kits", "my-kit");
    await mkdir(kitDir, { recursive: true });

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    expect(kits).toHaveLength(1);
    expect(kits[0]!.id).toBe("my-kit");
    expect(kits[0]!.name).toBe("my-kit");
    expect(kits[0]!.owner).toBe("local");
    expect(kits[0]!.canEdit).toBe(true);
    expect(typeof kits[0]!.updatedAt).toBe("string");
    await client.close();
  });

  it("reads meta.json for name and owner", async () => {
    const kitDir = join(root, "kits", "k1");
    await mkdir(kitDir, { recursive: true });
    await writeFile(
      join(kitDir, "meta.json"),
      JSON.stringify({ name: "Design Tokens", owner: "alice", type: KIT_TYPE_GENIE }),
    );

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    expect(kits).toHaveLength(1);
    expect(kits[0]!.name).toBe("Design Tokens");
    expect(kits[0]!.owner).toBe("alice");
    await client.close();
  });

  it("filters out kits with non-GENIE_KIT type in meta.json (AC5)", async () => {
    const kitsDir = join(root, "kits");
    await mkdir(join(kitsDir, "native"), { recursive: true });
    await writeFile(
      join(kitsDir, "native", "meta.json"),
      JSON.stringify({ name: "Native", type: KIT_TYPE_GENIE }),
    );
    await mkdir(join(kitsDir, "foreign"), { recursive: true });
    await writeFile(
      join(kitsDir, "foreign", "meta.json"),
      JSON.stringify({ name: "Foreign", type: "PROJECT_TYPE_DESIGN_SYSTEM" }),
    );

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    expect(kits).toHaveLength(1);
    expect(kits[0]!.id).toBe("native");
    await client.close();
  });

  it("ignores regular files in the kits directory", async () => {
    const kitsDir = join(root, "kits");
    await mkdir(kitsDir, { recursive: true });
    await writeFile(join(kitsDir, "README.md"), "# kits");
    await mkdir(join(kitsDir, "real-kit"), { recursive: true });

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    expect(kits).toHaveLength(1);
    expect(kits[0]!.id).toBe("real-kit");
    await client.close();
  });

  it("handles invalid meta.json gracefully (defaults)", async () => {
    const kitDir = join(root, "kits", "bad-meta");
    await mkdir(kitDir, { recursive: true });
    await writeFile(join(kitDir, "meta.json"), "not valid json{{{");

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    expect(kits).toHaveLength(1);
    expect(kits[0]!.name).toBe("bad-meta");
    expect(kits[0]!.owner).toBe("local");
    await client.close();
  });

  it("updatedAt is ISO 8601 format (AC4)", async () => {
    const kitDir = join(root, "kits", "ts-kit");
    await mkdir(kitDir, { recursive: true });

    const { client } = await setup();
    const result = await callListKits(client);
    const kits = parseResult(result);
    const ts = kits[0]!.updatedAt as string;
    expect(new Date(ts).toISOString()).toBe(ts);
    await client.close();
  });
});
