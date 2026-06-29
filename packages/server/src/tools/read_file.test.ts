import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { MAX_FILE_BYTES } from "./read_file.js";

/** Parsed response payload from read_file. */
interface ReadFileResult {
  content: string;
  encoding: "utf-8" | "base64";
  mimeType: string;
}

/** MCP tool call result. */
interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Helper: call read_file and return the raw tool result. */
async function callRaw(
  client: Client,
  kitId: string,
  path: string,
): Promise<ToolResult> {
  return (await client.callTool({
    name: "read_file",
    arguments: { kitId, path },
  })) as ToolResult;
}

/** Helper: call read_file and parse the JSON text result. */
async function callReadFile(
  client: Client,
  kitId: string,
  path: string,
): Promise<ReadFileResult> {
  const result = await callRaw(client, kitId, path);
  if (result.isError) {
    throw new Error(`Tool error: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0]?.text ?? "") as ReadFileResult;
}

describe("read_file tool", () => {
  let genieHome: string;
  let kitRoot: string;
  let client: Client;
  const kitId = "test-kit";

  beforeAll(async () => {
    // Set up a temporary GENIE_HOME with a kit directory
    genieHome = await mkdtemp(join(tmpdir(), "genie-test-"));
    process.env.GENIE_HOME = genieHome;

    kitRoot = join(genieHome, "kits", kitId);
    await mkdir(kitRoot, { recursive: true });

    // Create test fixtures
    await writeFile(join(kitRoot, "hello.txt"), "Hello, world!");
    await writeFile(
      join(kitRoot, "sync.json"),
      JSON.stringify({ version: 1 }),
    );

    // Create nested directory
    await mkdir(join(kitRoot, "components"), { recursive: true });
    await writeFile(
      join(kitRoot, "components", "Button.tsx"),
      'export const Button = () => <button>Click</button>;',
    );

    // Create a file exactly at the 256 KiB limit
    const exactBuffer = Buffer.alloc(MAX_FILE_BYTES, "A");
    await writeFile(join(kitRoot, "exact-limit.txt"), exactBuffer);

    // Create a file 1 byte over the 256 KiB limit
    const overBuffer = Buffer.alloc(MAX_FILE_BYTES + 1, "B");
    await writeFile(join(kitRoot, "over-limit.txt"), overBuffer);

    // Create a binary file (PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(join(kitRoot, "icon.png"), pngHeader);

    // Connect server + client over in-memory transport
    const server = createServer();
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client.close();
    delete process.env.GENIE_HOME;
    await rm(genieHome, { recursive: true, force: true });
  });

  // ── AC1: tool name ──
  it("registers as 'read_file' in tools/list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("read_file");
  });

  // ── AC2 + AC3: small text file ──
  it("reads a small text file and returns utf-8 content", async () => {
    const result = await callReadFile(client, kitId, "hello.txt");
    expect(result.content).toBe("Hello, world!");
    expect(result.encoding).toBe("utf-8");
    expect(result.mimeType).toBe("text/plain");
  });

  it("reads a JSON file with correct MIME type", async () => {
    const result = await callReadFile(client, kitId, "sync.json");
    expect(result.encoding).toBe("utf-8");
    expect(result.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual({ version: 1 });
  });

  it("reads a nested .tsx file as text", async () => {
    const result = await callReadFile(client, kitId, "components/Button.tsx");
    expect(result.content).toContain("Button");
    expect(result.encoding).toBe("utf-8");
    expect(result.mimeType).toBe("text/tsx");
  });

  // ── AC4: 256 KiB cap ──
  it("accepts a file exactly at 256 KiB", async () => {
    const result = await callReadFile(client, kitId, "exact-limit.txt");
    expect(result.encoding).toBe("utf-8");
    expect(result.content.length).toBe(MAX_FILE_BYTES);
  });

  it("rejects a file over 256 KiB with isError and -32603 message", async () => {
    const result = await callRaw(client, kitId, "over-limit.txt");
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("-32603");
    expect(text).toContain("File exceeds 256 KiB cap");
    expect(text).toContain(`${MAX_FILE_BYTES + 1} bytes`);
  });

  // ── AC5: binary file → base64 ──
  it("returns binary files as base64", async () => {
    const result = await callReadFile(client, kitId, "icon.png");
    expect(result.encoding).toBe("base64");
    expect(result.mimeType).toBe("image/png");
    // Verify we can decode the base64 back to the original bytes
    const decoded = Buffer.from(result.content, "base64");
    expect(decoded[0]).toBe(0x89);
    expect(decoded[1]).toBe(0x50); // 'P' — PNG signature
  });

  // ── AC6: path traversal ──
  it("rejects path traversal with ../", async () => {
    const result = await callRaw(client, kitId, "../../../etc/passwd");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("InvalidPathError");
  });

  it("rejects path traversal with encoded segments", async () => {
    const result = await callRaw(client, kitId, "components/../../etc/passwd");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("InvalidPathError");
  });

  it("rejects absolute paths that escape the kit root", async () => {
    const result = await callRaw(client, kitId, "/etc/passwd");
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    // Should fail as either path traversal or file not found
    expect(text.includes("InvalidPathError") || text.includes("File not found")).toBe(true);
  });

  // ── AC7: unknown path ──
  it("returns isError for a non-existent file", async () => {
    const result = await callRaw(client, kitId, "does-not-exist.txt");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("File not found");
  });
});
