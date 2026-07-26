/**
 * Retry-tolerant, non-fatal temp-directory removal for the E2E smoke tests
 * (genie#259).
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *   Error: ENOTEMPTY: directory not empty, rmdir '/tmp/genie-cline-cli-smoke-VvgJ11/.cline/data'
 *
 * `fs.rm(dir, { recursive: true, force: true })` — the form the cline smoke test
 * used — has two properties that together turn a momentary race into a red
 * build:
 *
 *   1. `force: true` suppresses **ENOENT only**. It does nothing for ENOTEMPTY.
 *   2. `maxRetries` **defaults to 0**. Node only retries EBUSY / EMFILE /
 *      ENFILE / ENOTEMPTY / EPERM up to `maxRetries` times, so with the default
 *      the very first ENOTEMPTY propagates immediately.
 *
 * So if anything writes into the tree between the recursive walk and the final
 * `rmdir`, teardown throws — and because the call sat in the test's `finally`,
 * a suite whose every assertion had already passed went red.
 *
 * ── The contract here ───────────────────────────────────────────────────────
 * `removeTempDir` (a) asks Node to retry the transient errors, and (b) can
 * never throw. Both matter, and neither replaces awaiting the writer:
 *
 *   - Retrying is what makes removal *succeed* once the writer is winding down.
 *   - Not throwing is what makes teardown *structurally incapable* of failing an
 *     otherwise-green suite. A leaked directory under `tmpdir()` is a
 *     housekeeping smell, not a correctness failure — by teardown every
 *     assertion has already passed, and the OS reclaims the space.
 *
 * The orderly-shutdown guarantee lives in `./cline-daemon.js`, which stops the
 * writer first; this module is the belt to that pair of braces.
 *
 * Matches the retry budget already used by `m5-smoke-continue.test.ts`
 * (`maxRetries: 10, retryDelay: 100`) so the two smoke suites agree.
 */
import { rm } from "node:fs/promises";

/**
 * The removal options every E2E temp teardown uses.
 *
 * `maxRetries: 10` with `retryDelay: 100` gives Node up to ~1s of retrying,
 * which is ample for a daemon that has already been signalled and is closing
 * its SQLite handles, while still bounded enough never to stall a suite.
 */
export const TEMP_DIR_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const;

/** Injection points — `remove` is swapped in unit tests; both are optional. */
export interface RemoveTempDirOptions {
  /** Performs the removal. Defaults to `fs.rm`. */
  remove?: (path: string, options: typeof TEMP_DIR_RM_OPTIONS) => Promise<void>;
  /** Reports a removal that could not complete. Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

/**
 * Remove a throwaway directory, tolerating a concurrent writer.
 *
 * Resolves whether or not the directory actually went away, and returns `true`
 * only when removal completed. Never rejects.
 */
export async function removeTempDir(
  dir: string,
  options: RemoveTempDirOptions = {},
): Promise<boolean> {
  const remove = options.remove ?? ((path, rmOptions) => rm(path, rmOptions));
  const warn = options.onWarn ?? ((message: string) => console.warn(message));
  try {
    await remove(dir, TEMP_DIR_RM_OPTIONS);
    return true;
  } catch (error) {
    warn(`[temp-dir] could not remove ${dir} (leaving it for the OS to reclaim): ${String(error)}`);
    return false;
  }
}
