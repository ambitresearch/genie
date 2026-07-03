/**
 * Shared kitId validation for the kit-scoped tools.
 *
 * A `kitId` names a single directory directly under the server's kits root; the
 * tools resolve it with `resolve(kitsRoot, kitId)` and expect the result to stay
 * inside that root. `isSafeKitId` is the ONE rule both `list_files` (see
 * `KitFileStore.kitRoot`) and `read_file` (see `registerReadFile`) share so the
 * two cannot silently drift apart:
 *
 *   reject any kitId that contains a path separator (`/` or `\`) or that is
 *   exactly `.` or `..`.
 *
 * That covers every value that could resolve outside the kits root as a single
 * path segment: a separator could introduce a nested/absolute path, and the two
 * dot-names are the traversal aliases for "this dir" and "the parent". Names that
 * merely embed dots (e.g. `my..kit`) stay a literal child of the root, so they
 * are allowed here and simply resolve to a not-found kit.
 *
 * This is a predicate rather than a throwing helper on purpose: each tool raises
 * its own error type (`ListFilesError` / `McpError`) with its own code and
 * message, so only the *rule* is centralised, not the error shape.
 */
export function isSafeKitId(kitId: string): boolean {
  if (kitId === "." || kitId === "..") return false;
  if (kitId.includes("/") || kitId.includes("\\")) return false;
  return true;
}
