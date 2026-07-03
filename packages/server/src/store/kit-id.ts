/**
 * Shared `kitId` validation for the kit-scoped store paths and tools.
 *
 * A `kitId` names a single directory directly under a store's kits root; the
 * `LocalFsKitStore` resolves it with `join(baseDir, kitId)` and expects the
 * result to stay inside that root, and the git-host adapter uses it as a single
 * repo name. `isSafeKitId` is the ONE rule that `list_files`, `read_file`, and
 * both store adapters share so the kitId traversal defense cannot silently
 * drift between them:
 *
 *   reject an empty kitId, any kitId that contains a path separator (`/` or
 *   `\`), or one that is exactly `.` or `..`.
 *
 * Why empty is unsafe: an empty string names no kit and — on the local adapter —
 * `join(baseDir, "")` resolves straight back to the kits root itself, which
 * would let a caller read across sibling kits via the `path` argument
 * (`read_file({ kitId: "", path: "other-kit/secret.txt" })`). So it is rejected
 * here rather than left to the per-file path guard, which cannot see that the
 * "kit root" is really the shared root.
 *
 * Why only exact `.`/`..` and separators: those are the traversal aliases for
 * "this dir" / "the parent" and the only way to introduce a nested or absolute
 * path in a single segment. Names that merely *embed* dots (e.g. `my..kit`,
 * `..kit`, `kit..`) stay a literal child of the root, so they are allowed and
 * simply resolve to a not-found kit — matching how a real kit name like
 * `v1.2.3` must be accepted.
 *
 * This is a predicate rather than a throwing helper on purpose: each caller
 * raises its own error type/code (`ListFilesError` `ERR_INVALID_KIT_ID`,
 * `read_file`'s `McpError` `InvalidPathError`, the store's `NotFoundError`), so
 * only the *rule* is centralised here, not the error shape.
 */
export function isSafeKitId(kitId: string): boolean {
  if (kitId.length === 0) return false;
  if (kitId === "." || kitId === "..") return false;
  if (kitId.includes("/") || kitId.includes("\\")) return false;
  return true;
}
