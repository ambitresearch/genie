import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { lookup } from "mime-types";
import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** 256 KiB in bytes — hard cap per DesignSync contract. */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * Extensions that `mime-types` either misidentifies (e.g. `.ts` → `video/mp2t`)
 * or doesn't know at all (`.tsx`, `.mts`, `.cts`). All are source-code text.
 */
const TEXT_EXT_OVERRIDES: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".svelte": "text/x-svelte",
  ".vue": "text/x-vue",
  ".mdx": "text/mdx",
};

/**
 * Resolve the MIME type for a file path.
 * Prefers our overrides for extensions that `mime-types` misidentifies.
 */
function resolveMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return TEXT_EXT_OVERRIDES[ext] ?? (lookup(filePath) || "application/octet-stream");
}

/**
 * MIME type prefixes that are considered textual (returned as utf-8).
 * Everything else is returned as base64.
 */
function isTextMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  if (mime === "application/xml") return true;
  if (mime.endsWith("+json")) return true;
  if (mime.endsWith("+xml")) return true;
  return false;
}

/**
 * Resolve the kit root directory. In the current local-FS model, kits live
 * under `$GENIE_HOME/kits/<kitId>/` (matching the M1-01 `LocalFsStore` spec).
 * Falls back to `~/.genie/kits/<kitId>/`.
 */
export function resolveKitRoot(kitId: string): string {
  const home = process.env.GENIE_HOME ?? join(process.env.HOME ?? "", ".genie");
  return resolve(home, "kits", kitId);
}

/**
 * Validate that a resolved path stays within the kit root (prevents traversal).
 * Returns the fully-resolved target path or throws.
 */
export function safePath(kitRoot: string, relativePath: string): string {
  const normalised = normalize(relativePath);

  // Reject any path that contains `..` segments after normalisation
  if (normalised.startsWith("..") || normalised.includes("/../") || normalised.endsWith("/..")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `InvalidPathError: path traversal is not allowed`,
    );
  }

  const target = resolve(kitRoot, normalised);
  const root = resolve(kitRoot);

  // After resolution, target must be inside or equal to root
  if (!target.startsWith(root + "/") && target !== root) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `InvalidPathError: path traversal is not allowed`,
    );
  }

  return target;
}

/**
 * Register the `read_file` tool on the given MCP server.
 *
 * AC1: Tool name `read_file` (exposed as `mcp__genie__read_file` by the MCP namespace).
 * AC2: Input `{ kitId: string, path: string }`.
 * AC3: Returns `{ content, encoding, mimeType }`.
 * AC4: Files > 256 KiB → MCP error -32603.
 * AC5: Binary files → base64 encoding.
 * AC6: Path traversal → InvalidPathError (InvalidParams -32602).
 * AC7: Unknown path → MCP error -32602.
 */
export function registerReadFile(server: McpServer): void {
  server.registerTool(
    "read_file",
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
      const kitRoot = resolveKitRoot(kitId);

      // AC6 — path traversal check
      const target = safePath(kitRoot, relPath);

      // AC7 — unknown path
      let fileStat;
      try {
        fileStat = await stat(target);
      } catch {
        throw new McpError(
          ErrorCode.InvalidParams,
          `File not found: ${relPath}`,
        );
      }

      if (!fileStat.isFile()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Not a file: ${relPath}`,
        );
      }

      // AC4 — size cap
      if (fileStat.size > MAX_FILE_BYTES) {
        throw new McpError(
          ErrorCode.InternalError,
          `File exceeds 256 KiB cap (actual: ${fileStat.size} bytes)`,
        );
      }

      // Read file and determine MIME type
      const mimeType = resolveMime(target);
      const isBinary = !isTextMime(mimeType);

      const raw = await readFile(target);
      const encoding = isBinary ? "base64" : "utf-8";
      const content = isBinary
        ? raw.toString("base64")
        : raw.toString("utf-8");

      // AC3 — structured response
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ content, encoding, mimeType }),
          },
        ],
      };
    },
  );
}
