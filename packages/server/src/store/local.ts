/**
 * Local-filesystem kit store.
 *
 * Stores kits under `${baseDir}/kits/<kitId>/`. Each kit is a plain
 * directory; every file inside is enumerable via {@link listFiles}.
 *
 * This is the M1-04 subset — the full M1-01 implementation will add
 * readFile, createKit, openPlan, etc.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FileEntry, KitStore } from "./interface.js";
import { parseGenieignore } from "./genieignore.js";

export class LocalFsStore implements KitStore {
  constructor(private readonly baseDir: string) {}

  /** Resolve the root directory for a given kit. */
  private kitDir(kitId: string): string {
    return join(this.baseDir, "kits", kitId);
  }

  async listFiles(kitId: string): Promise<FileEntry[]> {
    const root = this.kitDir(kitId);

    // Load .genieignore if present
    let ignoreContent: string | undefined;
    try {
      ignoreContent = await readFile(join(root, ".genieignore"), "utf-8");
    } catch {
      // File doesn't exist — use defaults
    }
    const rules = parseGenieignore(ignoreContent);

    const entries: FileEntry[] = [];
    await this.walk(root, root, rules, entries);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  /** Recursively walk the directory tree, collecting file entries. */
  private async walk(
    dir: string,
    root: string,
    rules: ReturnType<typeof parseGenieignore>,
    out: FileEntry[],
  ): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or is unreadable — treat as empty
      return;
    }

    for (const d of dirents) {
      const full = join(dir, d.name);
      const rel = relative(root, full).split("\\").join("/");

      if (rules.ignores(rel)) continue;

      if (d.isDirectory()) {
        await this.walk(full, root, rules, out);
      } else if (d.isFile()) {
        const [fileStat, fileBytes] = await Promise.all([stat(full), readFile(full)]);

        const hash = createHash("sha256").update(fileBytes).digest("base64");

        out.push({
          path: rel,
          size: fileStat.size,
          hash: `sha256-${hash}`,
          lastModified: fileStat.mtime.toISOString(),
        });
      }
    }
  }
}
