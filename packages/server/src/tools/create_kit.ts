/**
 * MCP tool: create_kit (M1-06).
 *
 * Creates a new UI kit owned by the caller and returns the kitId
 * that downstream tools (plan, write_files, …) lock against.
 *
 * Input:  { name: string }   — human-readable display name (1-64 chars,
 *                               ASCII alphanumeric + space/dash/underscore).
 * Output: { kitId: string }  — slug derived from name + 6-char random suffix.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KitStore } from "../store/interface.js";
import { KitAlreadyExistsError } from "../store/interface.js";

/** Validation pattern: ASCII alphanumeric, spaces, hyphens, underscores. Must contain at least one alphanumeric. */
const NAME_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 _-]+$/;

/** Max characters for the display name. */
const NAME_MAX_LENGTH = 64;

/**
 * Every `kitId` this module generates must satisfy `KIT_ID_PATTERN`
 * (`get_kit.ts`): `[a-z0-9-]{3,64}` overall. A generated id is always
 * `<slug>-<6-char-hex>`, so the slug itself must leave room for the
 * hyphen + suffix: 64 - 1 - 6 = 57.
 */
const SLUG_MAX_LENGTH = 57;

/**
 * Derive a URL-safe slug from a human-readable name.
 * Lowercases, replaces spaces/underscores with hyphens, collapses
 * runs of hyphens, and trims leading/trailing hyphens.
 *
 * Truncates to `SLUG_MAX_LENGTH` (re-trimming a trailing hyphen the cut
 * may expose) so `buildKitId`'s output always fits the 64-char id budget
 * that `KIT_ID_PATTERN` enforces — names up to `NAME_MAX_LENGTH` (64 chars)
 * would otherwise slugify to more than that once the `-<6-char-hex>`
 * suffix is appended, producing a kitId `get_kit`/`bind_kit` reject.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_ ]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-$/, "");
}

/** Generate a 6-character hex suffix for deduplication. */
export function randomSuffix(): string {
  return randomBytes(3).toString("hex"); // 3 bytes → 6 hex chars
}

/**
 * Build a kitId from a display name: `<slug>-<6-char-hex>`.
 *
 * Exported for testability; the random part can be injected. The slug is
 * always truncated (see `slugify`) so the result satisfies `KIT_ID_PATTERN`
 * regardless of how long `name` is, up to `NAME_MAX_LENGTH`.
 */
export function buildKitId(name: string, suffix?: string): string {
  const slug = slugify(name);
  const sfx = suffix ?? randomSuffix();
  return `${slug}-${sfx}`;
}

/** Input schema for create_kit (Zod v4). */
const inputSchema = {
  name: z
    .string()
    .min(1)
    .max(NAME_MAX_LENGTH)
    .describe(
      "Human-readable display name for the new UI kit (1-64 chars, ASCII alphanumeric + space/dash/underscore).",
    ),
} as const;

/**
 * Register the `mcp__genie__create_kit` tool on the given MCP server.
 *
 * The store dependency is injected so the server can swap between
 * storage adapters without touching tool code.
 */
export function registerCreateKit(server: McpServer, store: KitStore): void {
  server.registerTool(
    "mcp__genie__create_kit",
    {
      title: "Create Kit",
      description:
        "Create a new UI kit — returns the kitId that plan and other verbs " +
        "lock against. The kit name is the human-readable display name.",
      inputSchema,
    },
    async ({ name }: { name: string }) => {
      // Validate name characters (Zod handles length; we check the pattern).
      if (!NAME_PATTERN.test(name)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "InvalidKitName",
                message:
                  "Kit name must contain only ASCII letters, digits, spaces, " +
                  "hyphens, or underscores.",
              }),
            },
          ],
        };
      }

      const kitId = buildKitId(name);

      try {
        const kit = await store.createKit(name, kitId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ kitId: kit.id }),
            },
          ],
        };
      } catch (err: unknown) {
        if (err instanceof KitAlreadyExistsError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "KitAlreadyExistsError",
                  message: err.message,
                  kitId: err.kitId,
                }),
              },
            ],
          };
        }
        throw err; // unexpected errors bubble up as MCP internal errors
      }
    },
  );
}
