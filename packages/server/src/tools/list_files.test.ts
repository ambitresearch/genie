import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { listFiles } from "./list_files.js";
import { LocalFsKitStore } from "../store/local.js";

async function tempKitsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-kits-"));
}

async function writeKitFile(
  root: string,
  kitId: string,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const fullPath = join(root, kitId, ...path.split("/"));
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
}

function sriSha256(bytes: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

describe("listFiles", () => {
  it("returns an empty array for an empty kit", async () => {
    const root = await tempKitsRoot();
    await mkdir(join(root, "empty-kit"), { recursive: true });
    await writeFile(join(root, "empty-kit", ".kit.json"), "{}");

    await expect(listFiles(new LocalFsKitStore(root), { kitId: "empty-kit" })).resolves.toEqual([]);
  });

  it("returns relative file metadata with SHA-256 SRI hashes and hidden files included", async () => {
    const root = await tempKitsRoot();
    const kitId = "acme-kit";
    await writeKitFile(root, kitId, ".kit.json", "{}");
    await writeKitFile(root, kitId, "components/Button.tsx", "export const Button = 1;\n");
    await writeKitFile(root, kitId, ".genie/recompile", "yes\n");
    await writeKitFile(root, kitId, ".genie/sync.json", '{"version":1}\n');

    const files = await listFiles(new LocalFsKitStore(root), { kitId });

    expect(files.map((file) => file.path)).toEqual([
      ".genie/recompile",
      ".genie/sync.json",
      "components/Button.tsx",
    ]);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "components/Button.tsx",
          size: Buffer.byteLength("export const Button = 1;\n"),
          hash: sriSha256("export const Button = 1;\n"),
        }),
        expect.objectContaining({
          path: ".genie/sync.json",
          hash: sriSha256('{"version":1}\n'),
        }),
      ]),
    );
    for (const file of files) {
      expect(file.path).not.toMatch(/^\//);
      expect(file.path).not.toContain("\\");
      expect(file.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
      expect(new Date(file.lastModified).toISOString()).toBe(file.lastModified);
    }
  });

  it("excludes default directories and applies .genieignore patterns", async () => {
    const root = await tempKitsRoot();
    const kitId = "ignore-kit";
    await writeKitFile(root, kitId, ".kit.json", "{}");
    await writeKitFile(root, kitId, ".genieignore", "coverage/\n*.log\ncomponents/*.tmp\n");
    await writeKitFile(root, kitId, "src/App.tsx", "app\n");
    await writeKitFile(root, kitId, "node_modules/pkg/index.js", "pkg\n");
    await writeKitFile(root, kitId, ".git/config", "git\n");
    await writeKitFile(root, kitId, "dist/index.js", "dist\n");
    // write_files (M1-08) stages its atomic-rename scratch space at
    // `.genie-tmp/<random>/` under the same root list_files walks — a
    // Copilot review finding on PR #106 flagged this as leakable into a kit
    // listing (e.g. a concurrent list_files call during a large write, or an
    // orphaned subdir left behind by a hard crash mid-write). Default-excluded
    // like node_modules/.git/dist, below.
    await writeKitFile(root, kitId, ".genie-tmp/abc123-def/0", "staged\n");
    await writeKitFile(root, kitId, "coverage/report.json", "{}\n");
    await writeKitFile(root, kitId, "debug.log", "log\n");
    await writeKitFile(root, kitId, "components/Button.tmp", "tmp\n");

    const files = await listFiles(new LocalFsKitStore(root), { kitId });

    expect(files.map((file) => file.path)).toEqual([".genieignore", "src/App.tsx"]);
  });

  it("rejects path-like kit ids instead of listing arbitrary directories", async () => {
    const root = await tempKitsRoot();
    await writeKitFile(root, "safe-kit", ".kit.json", "{}");
    await writeKitFile(root, "safe-kit", "src/App.tsx", "app\n");

    await expect(listFiles(new LocalFsKitStore(root), { kitId: "." })).rejects.toMatchObject({
      code: "ERR_INVALID_KIT_ID",
    });
    await expect(
      listFiles(new LocalFsKitStore(root), { kitId: "safe-kit/src" }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_KIT_ID",
    });
  });

  it("converts invalid arguments into a ListFilesError (ERR_INVALID_ARGS)", async () => {
    const root = await tempKitsRoot();
    const store = new LocalFsKitStore(root);

    // Missing kitId
    await expect(
      listFiles(store, {} as unknown as { kitId: string }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_ARGS" });

    // Empty kitId (fails .min(1))
    await expect(listFiles(store, { kitId: "" })).rejects.toMatchObject({
      code: "ERR_INVALID_ARGS",
    });

    // Extra keys rejected by .strict()
    await expect(
      listFiles(store, { kitId: "x", extra: true } as unknown as { kitId: string }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_ARGS" });
  });

  it("surfaces invalid args as an error through the MCP tool", async () => {
    const kitsRoot = await tempKitsRoot();
    const server = createServer({ kitsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    // Empty kitId violates the inputSchema (min length 1). The MCP SDK rejects
    // it at the protocol layer, so the call comes back flagged as an error
    // rather than returning file data. The tool handler's own ZodError →
    // ERR_INVALID_ARGS branch is covered by the direct `listFiles()` unit test
    // above (defense-in-depth for programmatic callers that bypass MCP schema
    // validation).
    const result = await client.callTool({
      name: "mcp__genie__list_files",
      arguments: { kitId: "" },
    });
    expect(result.isError).toBe(true);

    await client.close();
  });

  it("registers mcp__genie__list_files with the MCP server", async () => {
    const kitsRoot = await tempKitsRoot();
    await writeKitFile(kitsRoot, "tool-kit", ".kit.json", "{}");
    await writeKitFile(kitsRoot, "tool-kit", "README.md", "# Tool Kit\n");

    const server = createServer({ kitsRoot });
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("mcp__genie__list_files");

    const result = await client.callTool({
      name: "mcp__genie__list_files",
      arguments: { kitId: "tool-kit" },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      expect.objectContaining({
        path: "README.md",
        size: Buffer.byteLength("# Tool Kit\n"),
        hash: sriSha256("# Tool Kit\n"),
      }),
    ]);
    expect(result.structuredContent).toEqual({
      files: [
        expect.objectContaining({
          path: "README.md",
          size: Buffer.byteLength("# Tool Kit\n"),
          hash: sriSha256("# Tool Kit\n"),
        }),
      ],
    });

    await client.close();
  });
});
