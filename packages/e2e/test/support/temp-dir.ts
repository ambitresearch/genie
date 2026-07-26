/**
 * Resilient temp-directory cleanup for harness smoke tests.
 *
 * The `m5-smoke-*` suites drive **real** third-party CLIs. Several of them
 * (Cline most visibly) leave a background host process alive after the command
 * we spawned has exited, and that process keeps writing into its own state
 * directory under our temp root. A plain `rm(dir, { recursive: true })` then
 * races it: the recursive walk empties a directory, the background process
 * writes a new file into it, and the closing `rmdir` fails with `ENOTEMPTY`.
 *
 * That surfaced as issue #259 — a red build caused entirely by teardown, with
 * every product assertion green.
 *
 * `fs.rm` already knows how to wait this out: given `maxRetries` it re-attempts
 * on `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM` with a linear back-off
 * of `retryDelay` ms more each time. We deliberately reuse that rather than
 * hand-rolling a retry loop. What `fs.rm` does *not* do is give up gracefully:
 * once the retries are exhausted it still rejects, and an unhandled rejection in
 * a `finally` block fails the test. A leaked directory under the OS temp root is
 * not a correctness problem, so this helper downgrades that to a warning.
 */
import { rm as fsRm } from "node:fs/promises";

/** Subset of `fs.rm` options this helper controls. Exported for the test seam. */
export interface RemoveTempDirRmOptions {
  recursive: boolean;
  force: boolean;
  maxRetries: number;
  retryDelay: number;
}

export interface RemoveTempDirOptions {
  /**
   * Removal primitive. Defaults to `node:fs/promises` `rm`; overridden in tests
   * so the option forwarding and the never-throw contract can be asserted
   * without depending on a real filesystem race.
   */
  rm?: (dir: string, options: RemoveTempDirRmOptions) => Promise<void>;
  /** Extra attempts after the first. Must stay > 0 or the race is unmitigated. */
  maxRetries?: number;
  /** Base back-off in ms; `fs.rm` adds this again on every retry. */
  retryDelay?: number;
  /** Sink for the give-up message. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Sized for the observed Cline teardown: the background host settles well
 * inside a second. `fs.rm`'s back-off is linear, so 4 retries at a 50 ms base
 * waits 50 + 100 + 150 + 200 = 500 ms in total before giving up.
 */
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Removes `dir` and everything under it, tolerating a directory that a
 * background process is still writing into.
 *
 * Never rejects — teardown must not be able to fail a run.
 *
 * @param dir - Absolute path to remove. A missing path is success (`force`).
 * @param options - Test seam and retry tuning; see {@link RemoveTempDirOptions}.
 * @returns `true` when the tree is gone, `false` when removal was abandoned
 *          (a warning has been emitted in that case).
 */
export async function removeTempDir(
  dir: string,
  options: RemoveTempDirOptions = {},
): Promise<boolean> {
  const {
    rm = fsRm,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY_MS,
    warn = (message: string) => console.warn(message),
  } = options;

  try {
    await rm(dir, { recursive: true, force: true, maxRetries, retryDelay });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`[genie e2e] gave up removing temp dir ${dir}: ${detail}`);
    return false;
  }
}
