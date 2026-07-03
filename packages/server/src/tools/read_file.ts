import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { lookup } from "mime-types";
import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSafeKitRoot } from "./kit-id.js";

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
 * MIME types (beyond the `text/*` family) that are textual and should be
 * returned as utf-8 rather than base64. `mime-types` labels several source
 * formats with an `application/*` type (e.g. `.cjs` → `application/node`,
 * `.toml` → `application/toml`), so we treat a curated allow-list as text.
 */
const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/node",
  "application/toml",
  "application/yaml",
  "application/x-yaml",
  "application/graphql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/sql",
  "application/manifest+json",
]);

/**
 * MIME type prefixes/values that are considered textual (returned as utf-8).
 * Everything else is returned as base64. Any MIME parameters (e.g. a
 * `; charset=utf-8` suffix) are stripped before matching.
 */
function isTextMime(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("text/")) return true;
  if (base.endsWith("+json")) return true;
  if (base.endsWith("+xml")) return true;
  if (base.endsWith("+yaml")) return true;
  return TEXT_APPLICATION_MIMES.has(base);
}

/**
 * Validate that a resolved path stays within the kit root (prevents traversal).
 * Returns the fully-resolved target path or throws.
 *
 * Uses `path.relative`/`path.isAbsolute` rather than string checks against a
 * hard-coded "/" so traversal protection is correct across platforms (POSIX
 * and Windows) and for any separator style.
 */
export function safePath(kitRoot: string, relativePath: string): string {
  const root = resolve(kitRoot);
  const target = resolve(root, relativePath);

  // `rel` is how you get from root → target. If it escapes the root it either
  // starts with a `..` segment or is an absolute path (e.g. a different drive
  // on Windows). An empty `rel` means target === root, which is allowed.
  const rel = relative(root, target);
  const escapes =
    rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

  if (escapes) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `InvalidPathError: path traversal is not allowed`,
    );
  }

  return target;
}

/**
 * Register the `mcp__genie__read_file` tool on the given MCP server.
 *
 * @param server   The MCP server to register the tool on.
 * @param kitsRoot The directory kits live under — the SAME value `createServer`
 *                 hands to `LocalFsKitStore`, so `read_file` and `create_kit`
 *                 operate on one shared kit directory.
 *
 * AC1: Tool name `mcp__genie__read_file`.
 * AC2: Input `{ kitId: string, path: string }`.
 * AC3: Returns `{ content, encoding, mimeType }`.
 * AC4: Files > 256 KiB → MCP error -32603.
 * AC5: Binary files → base64 encoding.
 * AC6: Path traversal → InvalidPathError (InvalidParams -32602).
 * AC7: Unknown path → MCP error -32602.
 */
export function registerReadFile(server: McpServer, kitsRoot: string): void {
  server.registerTool(
    "mcp__genie__read_file",
    {
      title: "Read File",
      description:
        "Read the contents of a single file from a UI kit. Returns text (utf-8) " +
        "or binary (base64) content. Files larger than 256 KiB are rejected.",
      inputSchema: {
        kitId: z.string().min(1).describe("The UI kit identifier."),
        path: z.string().describe("Relative path within the kit directory."),
      },
    },
    async ({ kitId, path: relPath }) => {
      // Resolve the kit root through the SAME guarded resolver `list_files`
      // uses (`resolveSafeKitRoot` in `./kit-id.ts`), so the two tools' kitId
      // traversal defenses cannot silently drift. It rejects an empty kitId
      // (which would otherwise resolve to the kits root itself and let `path`
      // read across sibling kits), a separator, or an exact `.`/`..`, and it
      // confirms the resolved path stays inside the kits root. The `.min(1)`
      // above already blocks empty kitId at the MCP schema layer; this is the
      // defense-in-depth guard for programmatic callers that bypass it.
      const kitRoot = resolveSafeKitRoot(kitsRoot, kitId);
      if (kitRoot === null) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `InvalidPathError: invalid kit identifier`,
        );
      }

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

      // AC3 — structured response. Provide `structuredContent` so MCP clients
      // can consume `{ content, encoding, mimeType }` directly without parsing,
      // while keeping a JSON text part for backward compatibility.
      const payload = { content, encoding, mimeType };
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
