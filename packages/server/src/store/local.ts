import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { KitStore, KitSummary } from "./interface.js";
import { KIT_TYPE_GENIE } from "./interface.js";

/**
 * Resolve the genie home directory.
 * Precedence: `GENIE_HOME` env → `~/.genie`.
 */
function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), ".genie");
}

/** Shape of a kit's `meta.json` on disk. */
interface KitMeta {
  name?: string;
  owner?: string;
  type?: string;
}

/**
 * Local filesystem implementation of `KitStore`.
 *
 * Layout:
 *   `<root>/kits/<kitId>/meta.json`  — optional metadata
 *
 * A directory under `kits/` is a kit. If `meta.json` is missing
 * the kit is still listed with sensible defaults.
 */
export class LocalFsStore implements KitStore {
  private readonly kitsDir: string;

  constructor(root?: string) {
    this.kitsDir = join(root ?? genieHome(), "kits");
  }

  async listKits(): Promise<KitSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.kitsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const results: KitSummary[] = [];
    for (const name of entries) {
      const kitPath = join(this.kitsDir, name);
      const info = await stat(kitPath).catch(() => null);
      if (!info?.isDirectory()) continue;

      const metaPath = join(kitPath, "meta.json");
      let meta: KitMeta = {};
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8")) as KitMeta;
      } catch {
        // No meta.json or invalid JSON — use defaults.
      }

      results.push({
        id: name,
        name: meta.name ?? name,
        owner: meta.owner ?? "local",
        updatedAt: info.mtime.toISOString(),
        canEdit: true,
        type: meta.type ?? KIT_TYPE_GENIE,
      });
    }

    return results;
  }
}
