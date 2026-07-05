#!/usr/bin/env node
/**
 * M4-08 (DRO-270) — the polished `genie-viewer` CLI.
 *
 * Boots the Vite dev server (from M4-02's `createViewerConfig`) against a kit
 * directory, prints the preview URL, opens the system browser (unless
 * `--no-open`), and tears the watcher + server down cleanly on Ctrl-C. The
 * M4-01 scaffold header reserved exactly this scope for this issue; it is now
 * implemented:
 *
 *   - AC1 — `genie-viewer <kit-dir>` boots Vite and prints
 *           `Preview: http://127.0.0.1:5173`.
 *   - AC2 — `--port N` overrides the default; a busy port falls back to the
 *           next free one AND warns (Vite's `strictPort:false` does the walk;
 *           we read the *actual* bound port back and warn if it moved).
 *   - AC3 — `--open` (default true) opens the URL via the `open` npm package.
 *   - AC4 — `--no-open` suppresses that.
 *   - AC5 — SIGINT/SIGTERM close the watcher + server within 1 s (a safety-net
 *           timer force-exits if teardown wedges).
 *   - AC6 — `--help` prints usage, `--version` prints the package version.
 *   - AC7 — a missing `<kit-dir>`, or one without `.genie/manifest.json`,
 *           exits non-zero and points the user at running the MCP server first.
 *
 * DESIGN — everything the process touches (Vite, the browser opener, signals,
 * `process.exit`, timers, cwd) is behind an injected deps seam
 * ({@link BootDeps} / {@link ShutdownDeps} / {@link CliDeps}), so `cli.test.ts`
 * (pure parsing) and `cli.boot.test.ts` (boot/validate/shutdown) drive the real
 * commander program and the real boot logic in-process with fakes — no
 * subprocess spawning, no port binding for the unit paths, and no stray
 * `process.exit()` killing the vitest worker. Two commander features make the
 * in-process parse safe (verified against commander@15):
 *   - `exitOverride()` turns help/version/parse-error `process.exit()` calls
 *     into a catchable `CommanderError` that {@link runCli} maps to a code.
 *   - `configureOutput()` routes commander's own writes through the injected IO.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, InvalidArgumentError } from "commander";
import open from "open";
import { createServer as viteCreateServer } from "vite";
import type { InlineConfig, ViteDevServer } from "vite";

import { createViewerConfig, DEFAULT_HOST, DEFAULT_VIEWER_PORT } from "./config.js";

/** Minimal output seam so tests can capture what the CLI writes. */
export interface CliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

const processIO: CliIO = {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

/** Bumped independently of the workspace version, mirrors `SERVER_INFO`. */
export const VIEWER_VERSION = "0.0.0";

/**
 * The Vite dev-server default port. Re-exported from the single source of
 * truth in `config.ts` (rather than redeclared) so the CLI's advertised
 * default and the config's actual default cannot drift apart.
 */
export const DEFAULT_PORT = DEFAULT_VIEWER_PORT;

/** AC6's exact required usage string. */
const USAGE = "<kit-dir> [--port N]";

/**
 * AC7 — the client-side compiler's output a booted viewer needs. Its presence
 * is the signal a kit has actually been synced by the genie MCP server; its
 * absence is what we tell the user to fix.
 */
export const MANIFEST_RELATIVE_PATH = ".genie/manifest.json";

/** AC5 — the hard ceiling on graceful teardown before we force the exit. */
export const SHUTDOWN_TIMEOUT_MS = 1000;

/** Renders any thrown value as a message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A CLI-level failure that carries its own process exit code. Distinct from
 * commander's `CommanderError` (help/version/parse) so {@link runCli} can map
 * both to a code while printing our own actionable message for this one.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Validates `--port`. Commander needs a custom parser to throw
 * `InvalidArgumentError` (not a plain `Error`) to get its "which option, which
 * value" framing in the printed message.
 */
export function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new InvalidArgumentError(
      `--port must be an integer between 1 and 65535, got: "${value}".`,
    );
  }
  return parsed;
}

/**
 * AC7 — resolves `<kit-dir>` against `cwd` and asserts it is a real directory
 * holding a `.genie/manifest.json`. Returns the resolved absolute root on
 * success; throws a non-zero {@link CliError} (with an actionable hint) on any
 * failure so the caller never boots Vite against a kit the viewer can't render.
 */
export function validateKitDir(kitDir: string, cwd: string = process.cwd()): string {
  const root = resolve(cwd, kitDir);

  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new CliError(
      `kit directory not found: ${root}\n` +
        "  Pass the path to a synced UI kit, e.g. `genie-viewer ui_kits/acme`.",
    );
  }
  if (!stats.isDirectory()) {
    throw new CliError(`kit path is not a directory: ${root}`);
  }

  const manifest = resolve(root, MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifest)) {
    throw new CliError(
      `no ${MANIFEST_RELATIVE_PATH} in ${root}\n` +
        "  This kit has not been compiled yet. Run the genie MCP server against\n" +
        "  it first (it writes `.genie/manifest.json`), then re-run genie-viewer.",
    );
  }

  return root;
}

/** A running viewer, plus the metadata the CLI/tests reason about. */
export interface ViewerHandle {
  /** The browsable preview URL (what AC3 opens). */
  url: string;
  /** The port Vite actually bound (may differ from the request — AC2). */
  port: number;
  /** The port the user asked for (default or `--port`). */
  requestedPort: number;
  /** True when {@link port} differs from {@link requestedPort} (AC2 fallback). */
  fellBack: boolean;
  /** Tears down the watcher + http server (AC5). Idempotent-safe to await. */
  close: () => Promise<void>;
}

/** Options for a single {@link bootViewer} call. */
export interface BootViewerOptions {
  /** Resolved absolute kit root (from {@link validateKitDir}). */
  root: string;
  /** Requested dev-server port. */
  port: number;
  /** AC3/AC4 — whether to open the system browser at the preview URL. */
  open: boolean;
}

/** The process-touching seam `bootViewer` needs (real Vite + real browser). */
export interface BootDeps {
  createServer: (config: InlineConfig) => Promise<ViteDevServer>;
  openBrowser: (target: string) => Promise<unknown>;
}

const realBootDeps: BootDeps = {
  createServer: (config) => viteCreateServer(config),
  openBrowser: (target) => open(target),
};

/**
 * Boots the Vite dev server for a validated kit root (AC1–AC4).
 *
 * Vite (via M4-02's `strictPort:false`) does the EADDRINUSE → next-port walk
 * itself; we read the port it *actually* bound back off `config.server.port`
 * and, if it moved, warn (AC2). The preview URL comes from Vite's own
 * `resolvedUrls` so it is exactly what a browser should hit. `clearScreen` is
 * forced off so Vite's startup never wipes our printed `Preview:` line.
 */
export async function bootViewer(
  options: BootViewerOptions,
  io: CliIO,
  deps: BootDeps = realBootDeps,
): Promise<ViewerHandle> {
  const requestedPort = options.port;
  const config: InlineConfig = {
    ...createViewerConfig({ root: options.root, port: requestedPort }),
    clearScreen: false,
  };

  const server = await deps.createServer(config);
  await server.listen();

  const port = server.config.server.port;
  const fellBack = port !== requestedPort;
  const url = server.resolvedUrls?.local?.[0] ?? `http://${DEFAULT_HOST}:${port}/`;

  if (fellBack) {
    io.stderr(`genie-viewer: port ${requestedPort} is in use — serving on ${port} instead.\n`);
  }

  // AC1 — the canonical, copy-pasteable preview line.
  io.stdout(`\n  Preview: http://${DEFAULT_HOST}:${port}\n\n`);

  if (options.open) {
    try {
      await deps.openBrowser(url); // AC3
    } catch (err) {
      // AC3 is best-effort: a headless / no-browser box must still keep
      // serving. Report and carry on rather than tearing the server down.
      io.stderr(
        `genie-viewer: could not open a browser automatically (${errorMessage(err)}).\n` +
          `  Open ${url} yourself.\n`,
      );
    }
  }

  return {
    url,
    port,
    requestedPort,
    fellBack,
    close: () => server.close(),
  };
}

/** The process-touching seam `installShutdown` needs (signals + exit + timer). */
export interface ShutdownDeps {
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => { unref: () => void };
  timeoutMs: number;
}

const realShutdownDeps: ShutdownDeps = {
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  exit: (code) => {
    process.exit(code);
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
};

/**
 * AC5 — wires SIGINT/SIGTERM to a graceful teardown: close the viewer, then
 * exit 0. A safety-net timer force-exits non-zero if `close()` wedges past the
 * 1 s budget, and a `settled` latch guarantees exactly one `exit()` even if the
 * signal repeats or a slow close resolves after the deadline already fired.
 */
export function installShutdown(
  handle: ViewerHandle,
  io: CliIO,
  deps: ShutdownDeps = realShutdownDeps,
): void {
  let shuttingDown = false;
  let settled = false;

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    deps.exit(code);
  };

  const shutdown = (): void => {
    if (shuttingDown) return; // AC5 — a second Ctrl-C must not double-close.
    shuttingDown = true;
    io.stdout("\ngenie-viewer: shutting down…\n");

    const timer = deps.setTimer(() => {
      io.stderr(`genie-viewer: shutdown timed out after ${deps.timeoutMs} ms — forcing exit.\n`);
      finish(1);
    }, deps.timeoutMs);
    timer.unref(); // don't let the safety net itself keep the loop alive.

    handle.close().then(
      () => finish(0),
      (err) => {
        io.stderr(`genie-viewer: error during shutdown: ${errorMessage(err)}\n`);
        finish(1);
      },
    );
  };

  deps.onSignal("SIGINT", shutdown);
  deps.onSignal("SIGTERM", shutdown);
}

/** Everything `runCli`'s action dispatches through — a boot + shutdown superset. */
export interface CliDeps extends BootDeps, ShutdownDeps {
  /** Base directory a relative `<kit-dir>` resolves against (AC7). */
  cwd: () => string;
}

const realCliDeps: CliDeps = {
  ...realBootDeps,
  ...realShutdownDeps,
  cwd: () => process.cwd(),
};

interface ViewerOptions {
  port?: number;
  open?: boolean;
}

/**
 * Builds the commander program. Exported so a test can assert on its shape
 * (name/usage/options) without a full parse. The action validates the kit,
 * boots the viewer, and installs the Ctrl-C teardown — all through `deps`.
 */
export function buildProgram(io: CliIO, deps: CliDeps = realCliDeps): Command {
  const program = new Command();

  program.exitOverride();
  program.configureOutput({
    writeOut: io.stdout,
    writeErr: io.stderr,
  });

  program
    .name("genie-viewer")
    .usage(USAGE)
    .description(
      "Vite-backed UI-kit preview grid.\n" +
        "Boots a live preview of <kit-dir> — every components/**/preview.html as a\n" +
        "card — prints the URL, and opens your browser. Ctrl-C stops it cleanly.",
    )
    .version(VIEWER_VERSION, "-v, --version", "print the version and exit")
    .argument("[kit-dir]", "path to the UI kit directory to preview")
    .option("--port <n>", `dev server port (default: ${DEFAULT_PORT})`, parsePort)
    .option("--open", "open the preview in the system browser", true)
    .option("--no-open", "do not open a browser")
    .action(async (kitDir: string | undefined, options: ViewerOptions) => {
      // AC6 — a bare invocation is a help request, not an error: greet with
      // usage and exit 0 rather than booting nothing or failing.
      if (kitDir === undefined) {
        program.outputHelp();
        return;
      }

      const root = validateKitDir(kitDir, deps.cwd()); // AC7 — throws CliError.
      const handle = await bootViewer(
        { root, port: options.port ?? DEFAULT_PORT, open: options.open ?? true },
        io,
        deps,
      );
      installShutdown(handle, io, deps); // AC5 — keeps serving until Ctrl-C.
    });

  return program;
}

/**
 * Parses `argv` (bare args, no `node`/script-path prefix) and returns a process
 * exit code. Never throws: `CommanderError` (help/version/parse) maps to its
 * exit code, {@link CliError} (AC7 validation) prints its actionable message
 * and maps to its code, and anything else is a generic fatal (exit 1).
 */
export async function runCli(
  argv: string[],
  io: CliIO = processIO,
  deps: CliDeps = realCliDeps,
): Promise<number> {
  const program = buildProgram(io, deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    if (err instanceof CliError) {
      io.stderr(`genie-viewer: ${err.message}\n`);
      return err.exitCode;
    }
    io.stderr(`genie-viewer: fatal: ${errorMessage(err)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

// Only run when executed directly (`node dist/cli.js` / the linked bin), not
// when a test imports `runCli`/`buildProgram`.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    process.stderr.write(`genie-viewer: fatal: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
