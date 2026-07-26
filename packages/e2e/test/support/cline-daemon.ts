/**
 * Cline hub-daemon lifecycle control for the M5-14 real-CLI smoke test
 * (genie#259).
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The pinned Cline CLI (`@cline/cli-*` 3.0.42) is a thin client over a
 * background **hub daemon**. Invoking `cline` starts one if it isn't already
 * running:
 *
 *   cline --cline-hub-daemon --cwd <HOME> --host 127.0.0.1 --port <p> --pathname /hub
 *
 * That daemon is `fork`ed and reparented to init (`PPID 1`), so it is NOT in
 * the CLI's process group and does NOT die when the CLI exits. `execFile`
 * resolves as soon as the direct child exits — it neither awaits nor signals
 * the daemon.
 *
 * The smoke test points `HOME` at a throwaway `mkdtemp` directory, so the
 * daemon's data dir is `<base>/.cline/data`. It holds open write handles on:
 *
 *   <base>/.cline/data/db/cron.db{,-wal,-shm}   (a scheduled-task store — it
 *                                                keeps writing indefinitely)
 *   <base>/.cline/data/logs/hub-daemon.log
 *
 * So when teardown removes `<base>`, a live writer can re-create a file inside
 * `.cline/data` between the recursive walk and the final `rmdir` — which is
 * exactly the intermittent CI failure:
 *
 *   ENOTEMPTY: directory not empty, rmdir '/tmp/genie-cline-cli-smoke-VvgJ11/.cline/data'
 *
 * This module closes that window at the source: stop the writer and wait for it
 * to actually be gone BEFORE deleting its directory. That is the same discipline
 * the Vite/viewer teardown in `m5-smoke-cline.test.ts` already applies — this is
 * that fix one layer out.
 *
 * ── Why signal by PID rather than by process group ──────────────────────────
 * `process.kill(-pid)` cannot reach the daemon: it has already left the CLI's
 * process group (PPID 1). The only reliable handle is its command line, which
 * carries both the `--cline-hub-daemon` flag and the `--cwd <base>` we chose.
 *
 * ── Why matching on the temp base is safe ───────────────────────────────────
 * `base` comes from `mkdtemp`, so it is unique to a single test run. A daemon
 * whose `--cwd` is that path can only be one this run started: never a parallel
 * worker's, never a developer's real Cline hub. This module will not signal a
 * process it cannot attribute to `base`.
 *
 * ── Everything here is best-effort ──────────────────────────────────────────
 * Shutdown is bounded and never throws. Failing to reap a daemon must not red
 * an otherwise-passing suite; it only means teardown falls back on the
 * retry-tolerant removal in `./temp-dir.js`.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The flag the Cline CLI passes to its own background hub process. */
const HUB_DAEMON_FLAG = "--cline-hub-daemon";

/** How long to wait for a signalled daemon to disappear before escalating. */
const TERM_GRACE_MS = 2_000;

/** How long to wait after SIGKILL before giving up entirely. */
const KILL_GRACE_MS = 2_000;

/** Poll interval while waiting for a signalled process to exit. */
const POLL_INTERVAL_MS = 50;

/** One running process as reported by `ps`. */
interface ProcessEntry {
  pid: number;
  command: string;
}

/** Optional hooks — injectable so the unit tests need no real Cline install. */
export interface ClineDaemonOptions {
  /** Enumerate running processes. Defaults to a `ps -eo pid=,command=` probe. */
  listProcesses?: () => Promise<ProcessEntry[]>;
  /**
   * Send a signal, including the `0` probe used to test liveness. Defaults to
   * `process.kill`. Liveness deliberately routes through the SAME hook as
   * termination so an injected fake models one coherent process, not a real
   * process being probed and a fake one being signalled.
   */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Reports a non-fatal problem. Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

/**
 * List every running process, as `{ pid, command }`.
 *
 * `ps -eo pid=,command=` is POSIX and behaves identically on macOS and Linux
 * (the two platforms this suite runs on). Windows has no equivalent here, so
 * enumeration yields nothing and shutdown degrades to a no-op — safe, because
 * every caller treats this as best-effort.
 */
async function listProcessesViaPs(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,command="], {
      maxBuffer: 10_000_000,
    });
    return stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ pid: Number(match[1]), command: match[2] ?? "" }));
  } catch {
    // `ps` missing or truncated output — treat as "nothing to reap".
    return [];
  }
}

/**
 * Every path spelling a daemon's command line might use for `base`.
 *
 * On macOS `tmpdir()` is the symlink `/var/folders/…` while a child's resolved
 * `--cwd` reads `/private/var/folders/…`. Matching only the `mkdtemp` spelling
 * would silently find nothing on exactly the platform this was developed on, so
 * both the literal and the fully-resolved path are considered.
 */
async function basePathVariants(base: string): Promise<string[]> {
  const variants = new Set<string>([base]);
  try {
    variants.add(await realpath(base));
  } catch {
    // The directory may already be gone; the literal spelling still applies.
  }
  return [...variants];
}

/**
 * Find the Cline hub daemons this run started under `base`.
 *
 * A process qualifies only if its command line contains BOTH the
 * {@link HUB_DAEMON_FLAG} and the run's unique temp base — see the module
 * header on why that pairing cannot collide with another run's daemon.
 */
export async function findClineHubDaemons(
  base: string,
  options: ClineDaemonOptions = {},
): Promise<number[]> {
  const list = options.listProcesses ?? listProcessesViaPs;
  const variants = await basePathVariants(base);
  const processes = await list();
  return processes
    .filter(
      (entry) =>
        entry.pid !== process.pid &&
        entry.command.includes(HUB_DAEMON_FLAG) &&
        variants.some((variant) => entry.command.includes(variant)),
    )
    .map((entry) => entry.pid);
}

/** Resolve after `ms`, without keeping the event loop alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** A signal sender; signal `0` probes liveness without delivering anything. */
type Signaller = (pid: number, signal: NodeJS.Signals | 0) => void;

/** True while the process exists (signal 0 probes without delivering). */
function isAlive(pid: number, send: Signaller): boolean {
  try {
    send(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone or `timeoutMs` elapses. Returns true if it exited. */
async function waitForExit(pid: number, timeoutMs: number, send: Signaller): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid, send)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return !isAlive(pid, send);
}

/**
 * Stop every Cline hub daemon rooted at `base` and WAIT until it is gone.
 *
 * `SIGTERM` first so the daemon can checkpoint and close its SQLite handles
 * cleanly, then `SIGKILL` if it outstays {@link TERM_GRACE_MS}. Returns the pids
 * that were confirmed gone.
 *
 * Never throws. A daemon that survives is reported through `onWarn` and left to
 * the retry-tolerant removal in `./temp-dir.js`.
 */
export async function shutdownClineHubDaemons(
  base: string,
  options: ClineDaemonOptions = {},
): Promise<number[]> {
  const warn = options.onWarn ?? ((message: string) => console.warn(message));
  const send: Signaller =
    options.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));

  let pids: number[];
  try {
    pids = await findClineHubDaemons(base, options);
  } catch (error) {
    warn(`[cline-daemon] could not enumerate processes for ${base}: ${String(error)}`);
    return [];
  }

  const reaped: number[] = [];
  for (const pid of pids) {
    try {
      send(pid, "SIGTERM");
    } catch {
      // Already exited between enumeration and signalling — that is a success.
      reaped.push(pid);
      continue;
    }

    if (await waitForExit(pid, TERM_GRACE_MS, send)) {
      reaped.push(pid);
      continue;
    }

    try {
      send(pid, "SIGKILL");
    } catch {
      reaped.push(pid);
      continue;
    }

    if (await waitForExit(pid, KILL_GRACE_MS, send)) reaped.push(pid);
    else warn(`[cline-daemon] hub daemon ${pid} survived SIGKILL; leaving ${base} to retrying rm`);
  }

  return reaped;
}
