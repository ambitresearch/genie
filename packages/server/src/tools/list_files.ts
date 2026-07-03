import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isSafeKitId } from "./kit-id.js";

export const LIST_FILES_TOOL_NAME = "mcp__genie__list_files";

const listFilesArgsSchema = z
  .object({
    kitId: z.string().min(1),
  })
  .strict();

const fileEntrySchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    hash: z.string().startsWith("sha256-"),
    lastModified: z.string(),
  })
  .strict();

export type ListFilesArgs = z.infer<typeof listFilesArgsSchema>;
export type ListedFile = z.infer<typeof fileEntrySchema>;

type IgnoreMatcher = (path: string) => boolean;

export class ListFilesError extends Error {
  constructor(
    readonly code: "ERR_KIT_NOT_FOUND" | "ERR_INVALID_KIT_ID" | "ERR_INVALID_ARGS",
    message: string,
  ) {
    super(message);
    this.name = "ListFilesError";
  }
}

export class KitFileStore {
  constructor(readonly root: string) {}

  async listFiles(kitId: string): Promise<ListedFile[]> {
    const kitRoot = this.kitRoot(kitId);
    await this.assertKitExists(kitId, kitRoot);

    const ignore = buildIgnoreMatcher(await this.readIgnorePatterns(kitRoot));
    const files = await walkFiles(kitRoot, kitRoot, ignore);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private kitRoot(kitId: string): string {
    // Shared rule with `read_file` (see `./kit-id.ts`) so the two tools cannot
    // silently drift: reject a separator or an exact `.`/`..` dot-name.
    if (!isSafeKitId(kitId)) {
      throw new ListFilesError("ERR_INVALID_KIT_ID", `Invalid kitId "${kitId}".`);
    }
    const resolvedRoot = resolve(this.root);
    const resolvedKitRoot = resolve(resolvedRoot, kitId);
    const rel = relative(resolvedRoot, resolvedKitRoot);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ListFilesError("ERR_INVALID_KIT_ID", `Invalid kitId "${kitId}".`);
    }
    return resolvedKitRoot;
  }

  private async assertKitExists(kitId: string, kitRoot: string): Promise<void> {
    try {
      const [rootStats, markerStats] = await Promise.all([
        lstat(kitRoot),
        lstat(join(kitRoot, ".kit.json")),
      ]);
      if (!rootStats.isDirectory() || !markerStats.isFile()) {
        throw new ListFilesError("ERR_KIT_NOT_FOUND", `Kit "${kitId}" not found.`);
      }
    } catch (error) {
      if (error instanceof ListFilesError) throw error;
      if (!isMissingPathError(error)) throw error;
      throw new ListFilesError("ERR_KIT_NOT_FOUND", `Kit "${kitId}" not found.`);
    }
  }

  private async readIgnorePatterns(kitRoot: string): Promise<string[]> {
    try {
      const raw = await readFile(join(kitRoot, ".genieignore"), "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
  }
}

export async function listFiles(store: KitFileStore, args: ListFilesArgs): Promise<ListedFile[]> {
  let parsed: ListFilesArgs;
  try {
    parsed = listFilesArgsSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new ListFilesError(
        "ERR_INVALID_ARGS",
        issue?.message ?? "Invalid arguments: expected { kitId: string }.",
      );
    }
    throw error;
  }
  return z.array(fileEntrySchema).parse(await store.listFiles(parsed.kitId));
}

export function registerListFilesTool(server: McpServer, store: KitFileStore): void {
  server.registerTool(
    LIST_FILES_TOOL_NAME,
    {
      title: "List files",
      description:
        "Return the UI kit file tree with kit-root-relative paths, byte sizes, SHA-256 SRI hashes, and modification times.",
      inputSchema: {
        kitId: z.string().min(1),
      },
      outputSchema: {
        files: z.array(fileEntrySchema),
      },
    },
    async (args) => {
      try {
        const result = await listFiles(store, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { files: result },
        };
      } catch (error) {
        if (error instanceof ListFilesError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ code: error.code, message: error.message }),
              },
            ],
          };
        }
        throw error;
      }
    },
  );
}

async function walkFiles(dir: string, root: string, ignore: IgnoreMatcher): Promise<ListedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ListedFile[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = toRelativePath(root, absolutePath);
    if (relativePath === ".kit.json" || ignore(relativePath)) continue;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, root, ignore)));
      continue;
    }
    if (!entry.isFile()) continue;

    const [stats, hash] = await Promise.all([lstat(absolutePath), hashFile(absolutePath)]);
    files.push({
      path: relativePath,
      size: stats.size,
      hash,
      lastModified: stats.mtime.toISOString(),
    });
  }
  return files;
}

/**
 * Compute a file's SHA-256 SRI hash by streaming it through the hash in chunks,
 * so peak memory stays bounded by the read-stream buffer (default 64 KiB) rather
 * than the largest single file's size. The digest is byte-identical to hashing
 * the full buffer with `createHash("sha256").update(bytes)` — piping the stream
 * feeds the same bytes to the same hash in the same order — which the
 * "streams hashes that are byte-identical" regression test in `list_files.test.ts`
 * pins down. `pipeline` propagates stream errors (e.g. a mid-read failure) as a
 * rejection instead of leaving a dangling stream.
 */
async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolutePath), hash);
  return `sha256-${hash.digest("base64")}`;
}

function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

function buildIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const matchers = [
    segmentMatcher("node_modules"),
    segmentMatcher(".git"),
    segmentMatcher("dist"),
    // write_files (M1-08) stages its per-call atomic-rename scratch space at
    // `<localDir>/.genie-tmp/<random>/` (moved inside localDir, rather than
    // os.tmpdir(), specifically so the commit-phase rename() stays on one
    // filesystem — see write_files.ts's stageAndCommit doc comment). It is
    // always removed once the call finishes, but hiding it here means a kit
    // listing taken during a large concurrent write (or after a hard crash
    // mid-call, which would leave an orphaned subdir behind) never surfaces
    // genie's own bookkeeping as if it were kit content.
    segmentMatcher(".genie-tmp"),
    ...patterns.map(patternMatcher),
  ];
  return (path) => matchers.some((matcher) => matcher(path));
}

function segmentMatcher(segment: string): IgnoreMatcher {
  return (path) => path.split("/").includes(segment);
}

function patternMatcher(rawPattern: string): IgnoreMatcher {
  const pattern = rawPattern.replace(/^\/+/, "");
  if (pattern.endsWith("/")) {
    const dir = pattern.replace(/\/+$/, "");
    return (path) => path === dir || path.startsWith(`${dir}/`);
  }
  if (!pattern.includes("*")) {
    return (path) => path === pattern || path.startsWith(`${pattern}/`);
  }

  const regex = globPatternToRegex(pattern);
  return (path) => regex.test(path);
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") return "[^/]*";
      return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
