import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "../server.js";
import { LocalFsStore } from "../store/index.js";

/** Helper: compute expected SRI hash for content. */
function expectedHash(content: string): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

describe("list_files tool (MCP integration)", () => {
  let baseDir: string;
  let client: Client | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "genie-mcp-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const store = new LocalFsStore(baseDir);
    const server = createServer({ store });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
  }

  it("is registered and appears in tools/list", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_files");
  });

  it("returns empty array for an empty kit", async () => {
    await mkdir(join(baseDir, "kits", "empty"), { recursive: true });
    const c = await connect();
    const result = await c.callTool({
      name: "list_files",
      arguments: { kitId: "empty" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "[]";
    const files = JSON.parse(text);
    expect(files).toEqual([]);
  });

  it("returns file entries with correct shape for a non-empty kit", async () => {
    const kitDir = join(baseDir, "kits", "my-kit");
    await mkdir(kitDir, { recursive: true });
    const content = "export const x = 1;";
    await writeFile(join(kitDir, "index.ts"), content);

    const c = await connect();
    const result = await c.callTool({
      name: "list_files",
      arguments: { kitId: "my-kit" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "[]";
    const files = JSON.parse(text) as {
      path: string;
      size: number;
      hash: string;
      lastModified: string;
    }[];

    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("index.ts");
    expect(f.size).toBe(Buffer.byteLength(content));
    expect(f.hash).toBe(expectedHash(content));
    expect(f.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("excludes node_modules and includes hidden files", async () => {
    const kitDir = join(baseDir, "kits", "mixed");
    await mkdir(join(kitDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(kitDir, ".genie"), { recursive: true });
    await writeFile(join(kitDir, "node_modules", "pkg", "index.js"), "mod");
    await writeFile(join(kitDir, ".genie", "sync.json"), "{}");
    await writeFile(join(kitDir, "app.ts"), "app");

    const c = await connect();
    const result = await c.callTool({
      name: "list_files",
      arguments: { kitId: "mixed" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "[]";
    const files = JSON.parse(text) as { path: string }[];
    const paths = files.map((f) => f.path);

    expect(paths).toContain(".genie/sync.json");
    expect(paths).toContain("app.ts");
    expect(paths).not.toContain("node_modules/pkg/index.js");
  });
});
