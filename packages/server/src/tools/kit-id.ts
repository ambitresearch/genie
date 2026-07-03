import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Shared kitId validation for the kit-scoped tools.
 *
 * A `kitId` names a single directory directly under the server's kits root; the
 * tools resolve it with `resolve(kitsRoot, kitId)` and expect the result to stay
 * inside that root. `isSafeKitId` is the ONE rule both `list_files` (see
 * `KitFileStore.kitRoot`) and `read_file` (see `registerReadFile`) share so the
 * two cannot silently drift apart:
 *
 *   reject an empty kitId, any kitId that contains a path separator (`/` or
 *   `\`), or one that is exactly `.` or `..`.
 *
 * An empty string names no kit and resolves straight back to the kits root
 * (`resolve(kitsRoot, "") === kitsRoot`), which would let a caller read across
 * sibling kits via the `path` argument — so it is rejected here too. Beyond
 * that, a separator could introduce a nested/absolute path, and the two
 * dot-names are the traversal aliases for "this dir" and "the parent". Names
 * that merely embed dots (e.g. `my..kit`) stay a literal child of the root, so
 * they are allowed here and simply resolve to a not-found kit.
 *
 * This is a predicate rather than a throwing helper on purpose: each tool raises
 * its own error type (`ListFilesError` / `McpError`) with its own code and
 * message, so only the *rule* is centralised, not the error shape.
 */
export function isSafeKitId(kitId: string): boolean {
  if (kitId.length === 0) return false;
  if (kitId === "." || kitId === "..") return false;
  if (kitId.includes("/") || kitId.includes("\\")) return false;
  return true;
}

/**
 * Resolve a kitId to its absolute on-disk directory under `kitsRoot`, or return
 * `null` if the kitId is unsafe. This is the shared root-resolution both
 * `list_files` and `read_file` use so their traversal defenses stay identical:
 *
 *   1. `isSafeKitId` rejects empty / separator / exact-dot-name kitIds.
 *   2. A belt-and-suspenders containment check confirms the resolved path stays
 *      inside the kits root even if step 1 is ever loosened — it can never
 *      escape as a bare single segment today, but keeping the guard here means
 *      both tools inherit it rather than re-implementing (and drifting on) it.
 *
 * Returns `null` (not a throw) so each caller can raise its own error type/code.
 */
export function resolveSafeKitRoot(kitsRoot: string, kitId: string): string | null {
  if (!isSafeKitId(kitId)) return null;

  const root = resolve(kitsRoot);
  const kitRoot = resolve(root, kitId);
  const rel = relative(root, kitRoot);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;

  return kitRoot;
}
