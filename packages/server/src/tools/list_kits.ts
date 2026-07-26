import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KitMeta, KitStore } from "../store/interface.js";
import { KIT_TYPE } from "../store/interface.js";
import { isSafeKitId } from "../store/kit-files.js";

export const LIST_KITS_TOOL_NAME = "mcp__genie__list_kits";

export const LIST_KITS_DESCRIPTION =
  "List the user's writable UI kits. Returns the usable genie-native kits in the current store as an array of { id, name, owner, updatedAt, canEdit }, and guarantees every id it returns is accepted by the other kit verbs. Two kinds of record are omitted to keep that guarantee: those whose stored type is not GENIE_KIT (interop adapters map Anthropic project types separately), and those whose id every kit verb would refuse as unsafe, which a store adapter can surface because it reports whatever the filesystem or git host holds. Reach for this as the discovery step before conjure, plan, or bind_kit — each needs a valid kitId from here (or from create_kit for a brand-new kit).";

export interface ListKitsEntry extends Record<string, unknown> {
  id: string;
  name: string;
  owner: string;
  updatedAt: string;
  canEdit: boolean;
}

/** Zod shape for a single `list_kits` entry — reused by `outputSchema`. */
const listKitsEntryShape = {
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
};

type ListableKitMeta = KitMeta & {
  owner?: string;
  updatedAt?: string;
  canEdit?: boolean;
};

/**
 * The listing every kit-taking verb is discovered through, and therefore the
 * place `list_kits`' contract — "the ids it returns are valid input" — is kept.
 *
 * Two filters, for two different reasons:
 *
 *   - `type === KIT_TYPE` drops non-genie records an interop adapter may share
 *     the same store with.
 *   - `isSafeKitId` drops ids no kit-taking verb would accept. A store adapter
 *     surfaces whatever the filesystem or git host holds — `LocalFsKitStore`
 *     returns `.kit.json`'s `id` verbatim, and on POSIX a directory may legally
 *     be named `victim.` or `victim ` — but the gate is deliberately platform-
 *     INDEPENDENT (a plan authored on Linux may run on Windows, where those
 *     spellings open the sibling `victim`). Without this filter, tightening the
 *     gate silently re-creates the defect this discovery step exists to avoid:
 *     an id that is advertised and then universally refused.
 *
 * Filtering rather than relaxing the gate is the safe direction. The excluded id
 * is unusable on every platform, so hiding it removes a dead end; admitting it
 * would make an id that is merely useless on Linux destructive on Windows.
 */
export async function listWritableKits(store: KitStore): Promise<ListKitsEntry[]> {
  const kits = (await store.listKits()) as ListableKitMeta[];
  return kits
    .filter((kit) => kit.type === KIT_TYPE && isSafeKitId(kit.id))
    .map((kit) => ({
      id: kit.id,
      name: kit.name,
      owner: kit.owner ?? "local",
      updatedAt: kit.updatedAt ?? kit.createdAt,
      canEdit: kit.canEdit ?? true,
    }));
}

export function registerListKits(server: McpServer, store: KitStore): void {
  server.registerTool(
    LIST_KITS_TOOL_NAME,
    {
      title: "List kits",
      description: LIST_KITS_DESCRIPTION,
      inputSchema: z.object({}).strict(),
      outputSchema: {
        kits: z.array(z.object(listKitsEntryShape).strict()),
      },
    },
    async () => {
      const kits = await listWritableKits(store);
      return {
        content: [{ type: "text", text: JSON.stringify(kits) }],
        structuredContent: { kits },
      };
    },
  );
}
