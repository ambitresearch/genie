import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ComponentEntry, KitStore } from "../store/interface.js";
import { compareComponents } from "../store/manifest.js";

export const LIST_COMPONENTS_TOOL_NAME = "mcp__genie__list_components";

/**
 * Shared pagination cap (AC7): the same 256-result ceiling `list_files` and
 * `list_kits` honour. A page never exceeds this many entries; the rest are
 * reachable by re-calling with the returned `_meta.nextCursor`.
 */
export const MAX_COMPONENTS = 256;

export const LIST_COMPONENTS_DESCRIPTION =
  "List components within a kit, optionally filtered by group. Returns an array of component metadata " +
  "(name, group, path, viewport, hash, lastModified) sorted by group ASC, then name ASC, then path ASC " +
  "for deterministic ordering. When group is omitted, returns every component across all groups. Returns " +
  "[] when the kit has no components or the group filter matches nothing. Results are capped at 256 per " +
  "call; when more remain, an opaque cursor is returned in _meta.nextCursor — pass it back as `cursor` to " +
  "fetch the next page. Reads the compiled manifest, so results reflect components as of the last " +
  "compile. Calling mcp__genie__preview recompiles before it returns, regardless of whether the " +
  "host renders ui:// inline or opens a browser — call preview first after recent writes.";

/** Zod shape for a single component entry — reused by `outputSchema`. */
const componentEntryShape = {
  name: z.string(),
  group: z.string(),
  path: z.string(),
  viewport: z.string(),
  hash: z.string(),
  lastModified: z.string(),
};

export interface ListComponentsResult {
  components: ComponentEntry[];
  nextCursor?: string;
}

/** Keyset cursor payload — the sort key of the last entry on the prior page. */
interface CursorKey {
  g: string;
  n: string;
  p: string;
}

/**
 * Encode a keyset cursor from the last entry of a page. The cursor carries the
 * (group, name, path) sort key — NOT a numeric offset — so it stays correct
 * even if the manifest gains or loses entries between calls: the next page
 * resumes at the first component strictly after this key in the AC6 total
 * order, rather than at a byte offset that a mutation would shift.
 */
export function encodeCursor(entry: ComponentEntry): string {
  const key: CursorKey = { g: entry.group, n: entry.name, p: entry.path };
  return Buffer.from(JSON.stringify(key), "utf-8").toString("base64url");
}

/**
 * Truncated, safe preview of an untrusted cursor for error messages. Echoing
 * the full caller-supplied string would let an oversized/opaque token bloat
 * logs and responses (and reflect tokens back to callers); we cap it hard and
 * mark elision with an ellipsis so the message stays diagnostic but bounded.
 */
const CURSOR_PREVIEW_MAX = 16;
function cursorPreview(cursor: string): string {
  return cursor.length <= CURSOR_PREVIEW_MAX ? cursor : `${cursor.slice(0, CURSOR_PREVIEW_MAX)}…`;
}

/** Decode + validate a keyset cursor. Throws on tampered / malformed input. */
export function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new Error(
      `Invalid cursor: "${cursorPreview(cursor)}" is not a decodable list_components cursor.`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorKey).g !== "string" ||
    typeof (parsed as CursorKey).n !== "string" ||
    typeof (parsed as CursorKey).p !== "string"
  ) {
    throw new Error(`Invalid cursor: "${cursorPreview(cursor)}" has the wrong shape.`);
  }
  const { g, n, p } = parsed as CursorKey;
  return { g, n, p };
}

/**
 * Slice one ≤256-entry page out of a deterministically-sorted component list
 * (AC7). `components` MUST already be sorted by {@link compareComponents} — the
 * store guarantees this. Keyset semantics: with no cursor, return the first
 * page; with a cursor, return the page beginning at the first entry strictly
 * greater than the cursor key. `nextCursor` is set only when more entries
 * remain past the returned page.
 */
export function paginateComponents(
  components: ComponentEntry[],
  cursor?: string,
): ListComponentsResult {
  let start = 0;
  if (cursor !== undefined) {
    const key = decodeCursor(cursor);
    const sortKey = { group: key.g, name: key.n, path: key.p };
    const idx = components.findIndex((c) => compareComponents(c, sortKey) > 0);
    start = idx === -1 ? components.length : idx;
  }

  const page = components.slice(start, start + MAX_COMPONENTS);
  const hasMore = start + MAX_COMPONENTS < components.length;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : undefined;

  return nextCursor === undefined ? { components: page } : { components: page, nextCursor };
}

export function registerListComponents(server: McpServer, store: KitStore): void {
  server.registerTool(
    LIST_COMPONENTS_TOOL_NAME,
    {
      title: "List components",
      description: LIST_COMPONENTS_DESCRIPTION,
      inputSchema: z
        .object({
          kitId: z
            .string()
            .regex(/^[a-z0-9-]{3,64}$/)
            .describe("The ID of the kit to list components from"),
          group: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Optional group filter. When specified, returns only components in that group. Empty string rejected.",
            ),
          cursor: z
            .string()
            .optional()
            .describe(
              "Opaque pagination cursor from a prior call's _meta.nextCursor. Fetches the next page of results.",
            ),
        })
        .strict(),
      outputSchema: {
        components: z.array(z.object(componentEntryShape).strict()),
      },
    },
    async ({ kitId, group, cursor }: { kitId: string; group?: string; cursor?: string }) => {
      const all = await store.listComponents({ kitId, group });
      const { components, nextCursor } = paginateComponents(all, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(components) }],
        structuredContent: { components },
        // AC7 — surface the continuation cursor out-of-band in _meta (only when
        // the result was truncated) so the `components` payload stays a clean,
        // schema-validated array.
        ...(nextCursor === undefined ? {} : { _meta: { nextCursor } }),
      };
    },
  );
}
