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
  structuredContent?: ReadFileResult;
  isError?: boolean;
  /** Structured error object exposed by some SDK/client versions. */
  error?: { code?: number; message?: string };
}

/** Helper: call read_file and return the raw tool result. */
async function callRaw(
  client: Client,
  kitId: string,
  path: string,
): Promise<ToolResult> {
  return (await client.callTool({
    name: "mcp__genie__read_file",
    arguments: { kitId, path },
  })) as ToolResult;
}

/**
 * Extract a human-readable error string from a failed tool result, robust to
 * SDK error shape.
 *
 * A thrown `McpError` from a tool handler is surfaced as
 * `{ isError: true, content: [{ type: "text", text: err.message }] }`; some
 * client versions additionally expose a structured `{ error: { code, message } }`.
 * We prefer the structured `error.message` when present and fall back to the
 * text content part, so assertions do not depend on a single transport shape.
 */
function errorText(result: ToolResult): string {
  return result.error?.message ?? result.content[0]?.text ?? "";
}

/**
 * Helper: call read_file and return the parsed result.
 *
 * Prefers `structuredContent` (AC3) when the server provides it, falling back
 * to parsing the JSON text content part for compatibility.
 */
async function callReadFile(
  client: Client,
  kitId: string,
  path: string,
): Promise<ReadFileResult> {
  const result = await callRaw(client, kitId, path);
  if (result.isError) {
    throw new Error(`Tool error: ${errorText(result)}`);
  }
  if (result.structuredContent) {
    return result.structuredContent;
  }
  return JSON.parse(result.content[0]?.text ?? "") as ReadFileResult;
}

describe("read_file tool", () => {
  let tmpRoot: string;
  let kitsRoot: string;
  let kitRoot: string;
  let client: Client;
  const kitId = "test-kit";

  beforeAll(async () => {
    // Set up a temporary kits root and point the server at it explicitly, so
    // the test exercises the SAME root `read_file` and `create_kit` share
    // (rather than relying on process-wide GENIE_HOME defaults).
    tmpRoot = await mkdtemp(join(tmpdir(), "genie-test-"));
    kitsRoot = join(tmpRoot, "kits");

    kitRoot = join(kitsRoot, kitId);
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

    // Source file whose mime-types label is an `application/*` text type
    // (`.cjs` → application/node); should still be treated as utf-8 text.
    await writeFile(
      join(kitRoot, "config.cjs"),
      "module.exports = { ok: true };",
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

    // A SIBLING kit under the SAME kits root — the bait for the cross-kit read
    // regression (AC-SEC, DRO-581). An empty/unsafe kitId whose kit-dir resolves
    // to the kits root would let a crafted `path` reach this file; the tests
    // below prove it cannot.
    const otherKitRoot = join(kitsRoot, "other-kit");
    await mkdir(otherKitRoot, { recursive: true });
    await writeFile(join(otherKitRoot, "secret.txt"), "cross-kit-secret");

    // Connect server + client over in-memory transport. The server is
    // configured with the same kitsRoot the fixtures were written under, so
    // read_file resolves to the directory create_kit would have written to.
    const server = createServer({ kitsRoot });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // ── AC1: tool name ──
  it("registers as 'mcp__genie__read_file' in tools/list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp__genie__read_file");
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

  it("treats application/* source types (.cjs) as utf-8 text", async () => {
    const result = await callReadFile(client, kitId, "config.cjs");
    expect(result.encoding).toBe("utf-8");
    expect(result.content).toContain("module.exports");
  });

  // ── AC3: structured content ──
  it("returns structuredContent matching the JSON text part", async () => {
    const result = await callRaw(client, kitId, "hello.txt");
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual({
      content: "Hello, world!",
      encoding: "utf-8",
      mimeType: "text/plain",
    });
    // Back-compat: the JSON text part still mirrors the structured payload.
    const fromText = JSON.parse(result.content[0]?.text ?? "");
    expect(fromText).toEqual(result.structuredContent);
  });

  // ── AC4: 256 KiB cap ──
  it("accepts a file exactly at 256 KiB", async () => {
    const result = await callReadFile(client, kitId, "exact-limit.txt");
    expect(result.encoding).toBe("utf-8");
    expect(result.content.length).toBe(MAX_FILE_BYTES);
  });

  it("rejects a file over 256 KiB with an over-cap error", async () => {
    const result = await callRaw(client, kitId, "over-limit.txt");
    expect(result.isError).toBe(true);
    const text = errorText(result);
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
    expect(errorText(result)).toContain("InvalidPathError");
  });

  it("rejects path traversal with encoded segments", async () => {
    const result = await callRaw(client, kitId, "components/../../etc/passwd");
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("InvalidPathError");
  });

  it("rejects absolute paths that escape the kit root", async () => {
    const result = await callRaw(client, kitId, "/etc/passwd");
    expect(result.isError).toBe(true);
    const text = errorText(result);
    // Should fail as either path traversal or file not found
    expect(text.includes("InvalidPathError") || text.includes("File not found")).toBe(true);
  });

  // ── AC7: unknown path ──
  it("returns isError for a non-existent file", async () => {
    const result = await callRaw(client, kitId, "does-not-exist.txt");
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("File not found");
  });

  // ── kitId traversal guard ──
  it("rejects kitId containing path separators", async () => {
    const result = await callRaw(client, "../../../etc", "passwd");
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("InvalidPathError");
  });

  // ── AC-SEC: kitId cross-kit isolation (DRO-581; was stranded in PR #116) ──
  it("rejects an empty kitId instead of reading across sibling kits", async () => {
    // With an empty kitId the kit-dir would resolve to the kits ROOT itself, so
    // a relative `path` of `other-kit/secret.txt` would escape `test-kit` and
    // read a sibling kit's file. `.min(1)` on the schema + the shared
    // `isSafeKitId` guard must refuse it and NEVER return the sibling's bytes.
    const result = await callRaw(client, "", "other-kit/secret.txt");
    expect(result.isError).toBe(true);
    const text = errorText(result);
    expect(text).not.toContain("cross-kit-secret");
    // Rejected either at the MCP schema layer (min-length) or by the handler's
    // InvalidPathError guard — both acceptable; neither leaks the file.
    expect(
      text.includes("InvalidPathError") ||
        text.toLowerCase().includes("invalid") ||
        text.toLowerCase().includes("too small") ||
        text.toLowerCase().includes("at least"),
    ).toBe(true);
  });

  it("cannot read a sibling kit's file via ../ even with a valid kitId", async () => {
    // Sanity: the `path` traversal guard still blocks `../other-kit/...` from a
    // legitimate kit, independent of the kitId fix.
    const result = await callRaw(client, kitId, "../other-kit/secret.txt");
    expect(result.isError).toBe(true);
    expect(errorText(result)).not.toContain("cross-kit-secret");
  });
});
