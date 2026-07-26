/**
 * Unit tests for the Cline hub-daemon shutdown that fixes genie#259.
 *
 * These drive REAL detached processes whose command lines are shaped like the
 * daemon the pinned Cline CLI spawns (`--cline-hub-daemon --cwd <base> …`), so
 * the discovery, signalling and wait-for-exit logic is exercised end to end
 * without needing a real Cline install or a 120s harness run.
 *
 * The two properties that matter:
 *   - a daemon rooted at OUR temp base is stopped, and we do not return until
 *     it is actually gone (that ordering is the whole fix), and
 *   - a daemon rooted anywhere else is never touched — a developer's real Cline
 *     hub, or a parallel worker's, must survive.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findClineHubDaemons, shutdownClineHubDaemons } from "./cline-daemon.js";

/** Stays alive until signalled, like the real hub daemon. */
const SLEEPER = "setInterval(() => {}, 1000);\n";

const spawned: ChildProcess[] = [];

/**
 * Spawn a stand-in hub daemon whose argv carries the flag and `--cwd` the real
 * CLI uses. Detached, so it is in its own process group — the property that
 * makes group-kill useless and PID-targeted signalling necessary.
 *
 * The sleeper is written to a real script file rather than passed via `node -e`:
 * with `-e` there is no script path to terminate option parsing, so node claims
 * the following `--cline-hub-daemon` as an unknown *node* option and exits 9
 * before it can ever be observed. A script path stops option parsing, which is
 * also how the real `cline --cline-hub-daemon …` process is shaped.
 */
async function startFakeDaemon(cwdArg: string): Promise<ChildProcess> {
  const scriptDir = await mkdtemp(join(tmpdir(), "genie-cline-daemon-bin-"));
  const script = join(scriptDir, "fake-hub-daemon.mjs");
  await writeFile(script, SLEEPER, "utf8");

  const child = spawn(
    process.execPath,
    [script, "--cline-hub-daemon", "--cwd", cwdArg, "--host", "127.0.0.1", "--port", "25463"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  spawned.push(child);

  // Fail fast and loudly if the stand-in dies instead of quietly timing out.
  let exited: string | undefined;
  child.on("exit", (code, signal) => {
    exited = `code=${String(code)} signal=${String(signal)}`;
  });

  // Wait until `ps` can actually see it, so discovery is not racing spawn.
  // Generous: developed against a machine at load average 85, and CI runners
  // are loaded too. A tight bound here would just trade one flake for another.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited !== undefined) {
      throw new Error(`fake daemon ${String(child.pid)} exited early (${exited})`);
    }
    if ((await findClineHubDaemons(cwdArg)).includes(child.pid ?? -1)) return child;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fake daemon ${String(child.pid)} never appeared in ps`);
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid !== undefined && isAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

describe("shutdownClineHubDaemons (genie#259)", () => {
  it("stops a hub daemon rooted at our temp base and waits for it to exit", async () => {
    const base = await mkdtemp(join(tmpdir(), "genie-cline-daemon-test-"));
    const daemon = await startFakeDaemon(await realpath(base));

    const reaped = await shutdownClineHubDaemons(base);

    expect(reaped).toContain(daemon.pid);
    // The contract is ordering, not eventual consistency: by the time this
    // resolves the writer must already be gone, with no polling on our side.
    expect(isAlive(daemon.pid)).toBe(false);
  }, 60_000);

  it("finds a daemon whose --cwd is the resolved path of our base", async () => {
    // On macOS `tmpdir()` is `/var/folders/…` but a child's resolved `--cwd`
    // reads `/private/var/folders/…`. Matching only the mkdtemp spelling would
    // find nothing on exactly the platform this was developed on.
    const base = await mkdtemp(join(tmpdir(), "genie-cline-daemon-real-"));
    const resolved = await realpath(base);
    const daemon = await startFakeDaemon(resolved);

    await expect(findClineHubDaemons(base)).resolves.toContain(daemon.pid);
  }, 60_000);

  it("leaves hub daemons belonging to other bases alone", async () => {
    const ours = await mkdtemp(join(tmpdir(), "genie-cline-daemon-ours-"));
    const theirs = await mkdtemp(join(tmpdir(), "genie-cline-daemon-theirs-"));
    const foreign = await startFakeDaemon(await realpath(theirs));

    const reaped = await shutdownClineHubDaemons(ours);

    expect(reaped).toEqual([]);
    expect(isAlive(foreign.pid)).toBe(true);
  }, 60_000);

  it("resolves quietly when there is no daemon to stop", async () => {
    const warnings: string[] = [];
    const base = await mkdtemp(join(tmpdir(), "genie-cline-daemon-none-"));

    await expect(
      shutdownClineHubDaemons(base, { onWarn: (m) => warnings.push(m) }),
    ).resolves.toEqual([]);
    expect(warnings).toEqual([]);
  }, 60_000);

  it("never throws when process enumeration fails", async () => {
    const warnings: string[] = [];

    await expect(
      shutdownClineHubDaemons("/tmp/whatever", {
        listProcesses: () => Promise.reject(new Error("ps exploded")),
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual([]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ps exploded");
  }, 60_000);

  it("escalates to SIGKILL when a daemon ignores SIGTERM", async () => {
    const delivered: NodeJS.Signals[] = [];
    let alive = true;

    const reaped = await shutdownClineHubDaemons("/tmp/base", {
      listProcesses: () =>
        Promise.resolve([{ pid: 999_999, command: "cline --cline-hub-daemon --cwd /tmp/base" }]),
      kill: (_pid, signal) => {
        if (signal === 0) {
          // Liveness probe.
          if (!alive) throw new Error("ESRCH");
          return;
        }
        delivered.push(signal);
        // SIGTERM is deliberately ignored — only SIGKILL takes it down.
        if (signal === "SIGKILL") alive = false;
      },
    });

    expect(delivered).toEqual(["SIGTERM", "SIGKILL"]);
    expect(reaped).toEqual([999_999]);
  }, 60_000);
});
