/**
 * M4-08 (DRO-270) — tests for the *polished* `genie-viewer` CLI boot logic
 * (`packages/viewer/src/cli.ts`): the parts M4-01's scaffold explicitly
 * reserved for this issue — booting Vite, printing the preview URL, port
 * fallback + warning, auto-open (and `--no-open`), Ctrl-C teardown, and
 * kit-dir validation against `.genie/manifest.json`.
 *
 * Split from `cli.test.ts` (which owns pure argument parsing) because these
 * exercise real behavior with injected seams:
 *   - `validateKitDir` — pure filesystem check, driven against real fixtures.
 *   - `bootViewer` — driven with a FAKE Vite `createServer` (+ a fake browser
 *     opener) so every AC1–AC4 branch is asserted with no port binding, plus
 *     ONE real-Vite integration test that binds a busy port and proves the
 *     fallback + URL print + sub-second teardown end-to-end.
 *   - `installShutdown` — driven with a fake signal registrar + clock so the
 *     SIGINT→close→exit path and the 1 s force-exit safety net (AC5) are
 *     deterministic (no real signals, no real timers).
 *
 * AC coverage:
 *   - AC1 — `bootViewer` prints `Preview: http://127.0.0.1:<port>`.
 *   - AC2 — a busy requested port falls back to the next free one AND warns.
 *   - AC3 — `open: true` opens the URL via the injected opener.
 *   - AC4 — `open: false` suppresses the open.
 *   - AC5 — SIGINT closes the server (watcher + http) and exits within 1 s;
 *           a hung close is force-exited by the safety-net timer.
 *   - AC7 — a missing dir / a dir with no `.genie/manifest.json` throws a
 *           non-zero `CliError` that points at running the MCP server first.
 */
import { createServer as realViteCreateServer } from "vite";
import type { ViteDevServer } from "vite";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootViewer,
  CliError,
  installShutdown,
  validateKitDir,
  MANIFEST_RELATIVE_PATH,
  SHUTDOWN_TIMEOUT_MS,
  type BootDeps,
  type CliIO,
  type ShutdownDeps,
  type ViewerHandle,
} from "./cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_PKG = resolve(HERE, "..");
const KIT = resolve(HERE, "../test/fixtures/kit");
const EMPTY_KIT = resolve(HERE, "../test/fixtures/empty-kit");
const MISSING = resolve(HERE, "../test/fixtures/__does_not_exist__");

/** Collects everything written through a {@link CliIO} seam for assertions. */
function createRecordingIO(): CliIO & { out: () => string; err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (chunk) => void stdout.push(chunk),
    stderr: (chunk) => void stderr.push(chunk),
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

/**
 * A fake `ViteDevServer` good enough for `bootViewer`: it records `listen`
 * and `close`, and reports `actualPort` back through `config.server.port` +
 * `resolvedUrls` exactly like the real server does after a port fallback.
 */
function fakeServer(actualPort: number): {
  server: ViteDevServer;
  listened: () => boolean;
  closed: () => boolean;
} {
  let didListen = false;
  let didClose = false;
  const server = {
    config: { server: { port: actualPort } },
    resolvedUrls: { local: [`http://127.0.0.1:${actualPort}/`], network: [] },
    listen: async () => {
      didListen = true;
      return server;
    },
    close: async () => {
      didClose = true;
    },
  } as unknown as ViteDevServer;
  return { server, listened: () => didListen, closed: () => didClose };
}

/** Builds {@link BootDeps} around a fake server + a spied browser opener. */
function fakeBootDeps(actualPort: number): {
  deps: BootDeps;
  openBrowser: ReturnType<typeof vi.fn>;
  listened: () => boolean;
  closed: () => boolean;
} {
  const fake = fakeServer(actualPort);
  const openBrowser = vi.fn(async () => {});
  return {
    deps: {
      createServer: async () => fake.server,
      openBrowser,
    },
    openBrowser,
    listened: fake.listened,
    closed: fake.closed,
  };
}

describe("validateKitDir (AC7)", () => {
  it("returns the resolved absolute root for a kit with a manifest", () => {
    expect(validateKitDir(KIT)).toBe(KIT);
  });

  it("resolves a relative kit-dir against the provided cwd", () => {
    expect(validateKitDir("test/fixtures/kit", VIEWER_PKG)).toBe(KIT);
  });

  it("throws a non-zero CliError when the directory does not exist", () => {
    try {
      validateKitDir(MISSING);
      expect.unreachable("expected validateKitDir to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).not.toBe(0);
      expect((err as CliError).message).toMatch(/not found|does not exist/i);
    }
  });

  it("throws a non-zero CliError when there is no .genie/manifest.json", () => {
    try {
      validateKitDir(EMPTY_KIT);
      expect.unreachable("expected validateKitDir to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).not.toBe(0);
      expect((err as CliError).message).toContain(MANIFEST_RELATIVE_PATH);
    }
  });

  it("points a manifest-less kit at running the genie MCP server first", () => {
    expect(() => validateKitDir(EMPTY_KIT)).toThrow(/MCP server|genie/i);
  });

  it("rejects a path that exists but is a file, not a directory", () => {
    const aFile = resolve(KIT, "index.html");
    expect(() => validateKitDir(aFile)).toThrow(CliError);
  });
});

describe("bootViewer", () => {
  it("AC1: prints Preview: http://127.0.0.1:<port> on stdout", async () => {
    const io = createRecordingIO();
    const { deps } = fakeBootDeps(5173);
    await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(io.out()).toContain("Preview: http://127.0.0.1:5173");
  });

  it("AC1: does not warn when the requested port was free", async () => {
    const io = createRecordingIO();
    const { deps } = fakeBootDeps(5173);
    await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(io.err()).toBe("");
  });

  it("AC2: prints the fallback port when the requested one was busy", async () => {
    const io = createRecordingIO();
    const { deps } = fakeBootDeps(5174); // requested 5173, bound 5174
    const handle = await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(handle.fellBack).toBe(true);
    expect(handle.port).toBe(5174);
    expect(io.out()).toContain("Preview: http://127.0.0.1:5174");
  });

  it("AC2: warns (mentioning both ports) when it falls back", async () => {
    const io = createRecordingIO();
    const { deps } = fakeBootDeps(5174);
    await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(io.err()).toMatch(/5173/);
    expect(io.err()).toMatch(/5174/);
    expect(io.err().toLowerCase()).toMatch(/busy|in use/);
  });

  it("AC3: opens the browser at the preview URL when open is true", async () => {
    const io = createRecordingIO();
    const { deps, openBrowser } = fakeBootDeps(5173);
    await bootViewer({ root: KIT, port: 5173, open: true }, io, deps);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser.mock.calls[0]?.[0]).toContain("http://127.0.0.1:5173");
  });

  it("AC3: opens the FALLBACK URL, not the requested one", async () => {
    const io = createRecordingIO();
    const { deps, openBrowser } = fakeBootDeps(5174);
    await bootViewer({ root: KIT, port: 5173, open: true }, io, deps);
    expect(openBrowser.mock.calls[0]?.[0]).toContain("5174");
  });

  it("AC4: does not open the browser when open is false", async () => {
    const io = createRecordingIO();
    const { deps, openBrowser } = fakeBootDeps(5173);
    await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("keeps serving even if opening a browser fails (non-fatal)", async () => {
    const io = createRecordingIO();
    const { deps } = fakeBootDeps(5173);
    deps.openBrowser = vi.fn(async () => {
      throw new Error("no display");
    });
    const handle = await bootViewer({ root: KIT, port: 5173, open: true }, io, deps);
    expect(handle.port).toBe(5173);
    expect(io.err().toLowerCase()).toMatch(/browser|open/);
  });

  it("returns a handle whose close() tears the server down", async () => {
    const io = createRecordingIO();
    const { deps, closed } = fakeBootDeps(5173);
    const handle = await bootViewer({ root: KIT, port: 5173, open: false }, io, deps);
    expect(closed()).toBe(false);
    await handle.close();
    expect(closed()).toBe(true);
  });
});

describe("installShutdown (AC5)", () => {
  /** Captures registered signal handlers + timer callback for manual firing. */
  function fakeShutdownDeps(): {
    deps: ShutdownDeps;
    fire: (signal: string) => void;
    fireTimeout: () => void;
    exited: () => number | undefined;
    timerArmed: () => boolean;
  } {
    const handlers = new Map<string, () => void>();
    let timerFn: (() => void) | undefined;
    let exitCode: number | undefined;
    return {
      deps: {
        onSignal: (sig, h) => void handlers.set(sig, h),
        exit: (code) => void (exitCode = code),
        setTimer: (fn) => {
          timerFn = fn;
          return { unref: () => {} };
        },
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      },
      fire: (signal) => handlers.get(signal)?.(),
      fireTimeout: () => timerFn?.(),
      exited: () => exitCode,
      timerArmed: () => timerFn !== undefined,
    };
  }

  function handleWithClose(close: () => Promise<void>): ViewerHandle {
    return {
      url: "http://127.0.0.1:5173",
      port: 5173,
      requestedPort: 5173,
      fellBack: false,
      close,
    };
  }

  it("closes the server and exits 0 on SIGINT", async () => {
    const io = createRecordingIO();
    const closeSpy = vi.fn(async () => {});
    const f = fakeShutdownDeps();
    installShutdown(handleWithClose(closeSpy), io, f.deps);
    f.fire("SIGINT");
    await vi.waitFor(() => expect(f.exited()).toBe(0));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("also handles SIGTERM", async () => {
    const io = createRecordingIO();
    const closeSpy = vi.fn(async () => {});
    const f = fakeShutdownDeps();
    installShutdown(handleWithClose(closeSpy), io, f.deps);
    f.fire("SIGTERM");
    await vi.waitFor(() => expect(f.exited()).toBe(0));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes only once even if the signal fires repeatedly", async () => {
    const io = createRecordingIO();
    const closeSpy = vi.fn(async () => {});
    const f = fakeShutdownDeps();
    installShutdown(handleWithClose(closeSpy), io, f.deps);
    f.fire("SIGINT");
    f.fire("SIGINT");
    await vi.waitFor(() => expect(f.exited()).toBe(0));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("arms a safety-net timer and force-exits non-zero if close() hangs", async () => {
    const io = createRecordingIO();
    // A close that never resolves — simulates a wedged watcher.
    const f = fakeShutdownDeps();
    installShutdown(
      handleWithClose(() => new Promise<void>(() => {})),
      io,
      f.deps,
    );
    f.fire("SIGINT");
    expect(f.timerArmed()).toBe(true);
    f.fireTimeout(); // the 1 s deadline elapses
    expect(f.exited()).toBe(1);
    expect(io.err()).toMatch(/timed out|forc/i);
  });

  it("exits non-zero if close() rejects", async () => {
    const io = createRecordingIO();
    const f = fakeShutdownDeps();
    installShutdown(
      handleWithClose(async () => {
        throw new Error("teardown blew up");
      }),
      io,
      f.deps,
    );
    f.fire("SIGINT");
    await vi.waitFor(() => expect(f.exited()).toBe(1));
  });

  it("uses a 1 s (1000 ms) shutdown deadline", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(1000);
  });
});

describe("bootViewer — real Vite integration (AC1/AC2/AC5)", () => {
  let blocker: net.Server | undefined;
  let handle: ViewerHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    handle = undefined;
    if (blocker) await new Promise<void>((r) => blocker!.close(() => r()));
    blocker = undefined;
  });

  it("boots real Vite, falls back off a busy port, prints the URL, serves index.html, and closes in <1 s", async () => {
    // 1. Occupy a port so boot MUST fall back (AC2). Bind the blocker to an
    //    OS-assigned free port (port 0) rather than a hardcoded number, then
    //    read the actual port back: the OS guarantees it exists and is held
    //    (so it won't be reassigned), which makes the fallback deterministic on
    //    a shared CI runner where any fixed port could already be in use.
    blocker = net.createServer();
    await new Promise<void>((r) => blocker!.listen(0, "127.0.0.1", () => r()));
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the blocker to bind a numeric TCP port");
    }
    const busyPort = address.port;

    // 2. Boot the real dev server against the fixture kit (no browser).
    const io = createRecordingIO();
    handle = await bootViewer({ root: KIT, port: busyPort, open: false }, io, {
      createServer: realViteCreateServer,
      openBrowser: async () => {},
    });

    // AC2 — fell back to a different, free port, and warned about it.
    expect(handle.fellBack).toBe(true);
    expect(handle.port).not.toBe(busyPort);
    expect(io.err()).toContain(String(busyPort));

    // AC1 — printed the real bound URL.
    expect(io.out()).toContain(`Preview: http://127.0.0.1:${handle.port}`);

    // The server actually serves the kit's index.html.
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");

    // AC5 — teardown resolves well within the 1 s budget.
    const start = performance.now();
    await handle.close();
    handle = undefined; // already closed; keep afterEach from double-closing
    expect(performance.now() - start).toBeLessThan(1000);
  }, 30_000);
});
