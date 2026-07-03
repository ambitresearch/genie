import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/interface.js";
import { FileTooLargeError, NotFoundError } from "../store/interface.js";

/** 256 KiB in bytes — hard cap per DesignSync contract. Re-exported for tests. */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * Validate that a relative path stays within a kit root (prevents traversal).
 * Throws an `InvalidPathError` McpError on escape, else returns.
 *
 * The check is purely lexical — it resolves `relativePath` against a synthetic
 * root and asks whether the result escapes it — so it needs no real filesystem
 * path (the tool no longer holds a `kitsRoot`; the injected `KitStore` owns
 * where kits physically live). Using `path.relative`/`path.isAbsolute` rather
 * than string checks against a hard-coded "/" keeps traversal protection
 * correct across platforms and separator styles. This tool-level guard is what
 * surfaces `InvalidPathError` to the client; the store also guards internally
 * (defense in depth), but with its own generic message.
 */
export function assertSafeRelativePath(relativePath: string): void {
  const root = resolve("/__genie_kit_root__");
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `InvalidPathError: path traversal is not allowed`,
    );
  }
}

/**
 * Register the `mcp__genie__read_file` tool on the given MCP server.
 *
 * @param server   The MCP server to register the tool on.
 * @param kitStore The injected kit backend (M1-14a-1a / DRO-540). Read-file now
 *                 routes through `KitStore.readFile`, which owns MIME
 *                 resolution, utf-8/base64 classification, and the 256 KiB cap —
 *                 so the SAME verb runs against `LocalFsKitStore` (disk) or
 *                 `GitHostKitStore` (git host) with byte-identical output. The
 *                 tool keeps only its request-shape guards (kitId + path
 *                 traversal) and the MCP error mapping.
 *
 * AC1: Tool name `mcp__genie__read_file`.
 * AC2: Input `{ kitId: string, path: string }`.
 * AC3: Returns `{ content, encoding, mimeType }`.
 * AC4: Files > 256 KiB → MCP error -32603.
 * AC5: Binary files → base64 encoding.
 * AC6: Path traversal → InvalidPathError (InvalidParams -32602).
 * AC7: Unknown path → MCP error -32602.
 */
export function registerReadFile(server: McpServer, kitStore: KitStore): void {
  server.registerTool(
    "mcp__genie__read_file",
    {
      title: "Read File",
      description:
        "Read the contents of a single file from a UI kit. Returns text (utf-8) " +
        "or binary (base64) content. Files larger than 256 KiB are rejected.",
      inputSchema: {
        kitId: z.string().describe("The UI kit identifier."),
        path: z.string().describe("Relative path within the kit directory."),
      },
    },
    async ({ kitId, path: relPath }) => {
      // Validate kitId does not contain path separators or traversal
      if (kitId.includes("/") || kitId.includes("\\") || kitId.includes("..")) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `InvalidPathError: invalid kit identifier`,
        );
      }

      // AC6 — path traversal check (surfaces InvalidPathError to the client).
      assertSafeRelativePath(relPath);

      let file;
      try {
        // AC3/AC4/AC5 — the store returns { content, encoding, mimeType },
        // owns the 256 KiB cap (throws FileTooLargeError), and classifies
        // binary→base64 / text→utf-8.
        file = await kitStore.readFile(kitId, relPath);
      } catch (error) {
        // AC4 — over the size cap. Preserve the exact client-facing wording.
        if (error instanceof FileTooLargeError) {
          throw new McpError(
            ErrorCode.InternalError,
            `File exceeds 256 KiB cap (actual: ${error.actualBytes} bytes)`,
          );
        }
        // AC7 — a missing file OR a missing kit both surface as "File not
        // found" (the pre-store tool stat()'d the resolved target and reported
        // the same for either case).
        if (error instanceof NotFoundError) {
          throw new McpError(ErrorCode.InvalidParams, `File not found: ${relPath}`);
        }
        throw error; // unexpected — bubble up as an MCP internal error.
      }

      // AC3 — structured response. Provide `structuredContent` so MCP clients
      // can consume `{ content, encoding, mimeType }` directly without parsing,
      // while keeping a JSON text part for backward compatibility.
      const payload = {
        content: file.content,
        encoding: file.encoding,
        mimeType: file.mimeType,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
