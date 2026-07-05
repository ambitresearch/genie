#!/usr/bin/env node
/**
 * M4-01 (DRO-263) — `genie-viewer` bin scaffold.
 *
 * This issue is scaffold-only: stand up the package, its bin, and an
 * argument parser that satisfies AC6 (`Usage: genie-viewer <kit-dir>
 * [--port N]`). It deliberately does NOT boot Vite, watch the filesystem, or
 * render anything — that's M4-02 (Vite multi-page config) through M4-08 (the
 * polished CLI: auto-open browser, port-fallback-with-warning, Ctrl-C
 * teardown, kit-dir validation against `.genie/manifest.json`). Building
 * those in would smuggle scope this issue's ACs don't ask for and that a
 * later issue's own ACs already own end-to-end.
 *
 * Design note: everything parse-related is exposed as plain functions
 * (`buildProgram`, `runCli`, `parsePort`) taking an injected {@link CliIO}
 * seam, so `cli.test.ts` can drive the real commander program in-process —
 * no subprocess spawning, no risk of a stray `process.exit()` killing the
 * vitest worker. This works because of two commander features used together:
 *   - `exitOverride()` turns commander's normal `process.exit()` calls (on
 *     `--help`, `--version`, and parse errors) into a thrown `CommanderError`
 *     instead, which `runCli` catches and converts to a return code.
 *   - `configureOutput()` redirects commander's internal `console.log`/
 *     `console.error` calls through the injected `stdout`/`stderr`
 *     functions, so tests can capture output without touching the real
 *     process streams.
 * (Verified empirically against commander@15 before writing this file —
 * both `--help`/`--version` and parse-error paths throw a catchable
 * `CommanderError` with the output already routed through `configureOutput`,
 * and normal successful parses never throw or touch `process.exit` at all.)
 */
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { pathToFileURL } from "node:url";

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

/** The eventual Vite dev-server default (RFC §6.9); reported here, not yet bound. */
export const DEFAULT_PORT = 5173;

/** AC6's exact required usage string. */
const USAGE = "<kit-dir> [--port N]";

/**
 * Validates `--port`. Commander requires a custom option-parser to throw
 * `InvalidArgumentError` (not just any `Error`) to get its "which option,
 * which value" framing in the printed message — a plain thrown `Error`
 * still surfaces (via `runCli`'s catch-all), but loses that context.
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

interface ViewerOptions {
  port?: number;
}

/**
 * Builds the commander program. Exported (not just used internally by
 * {@link runCli}) so a test can assert on the program's shape directly
 * (name/usage/options) without going through a full parse.
 */
export function buildProgram(io: CliIO): Command {
  const program = new Command();

  // Convert the library's default process.exit()-on-help/version/error
  // behavior into a catchable throw (see file header).
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
        "Scaffold build (M4-01): parses arguments and prints usage only.\n" +
        "The dev server, grid renderer, and HMR bridge land in M4-02 through M4-08.",
    )
    .version(VIEWER_VERSION, "-v, --version", "print the version and exit")
    .argument("[kit-dir]", "path to the UI kit directory to preview")
    .option("--port <n>", `dev server port (default: ${DEFAULT_PORT})`, parsePort)
    .action((kitDir: string | undefined, options: ViewerOptions) => {
      // No kit-dir yet resolves nothing to boot — AC6 only asks this bin
      // greet with usage, so a bare invocation prints help rather than
      // erroring. A provided kit-dir echoes what was parsed so the scaffold
      // is manually verifiable end-to-end (issue DoD) even though nothing
      // is actually served yet.
      if (kitDir !== undefined) {
        io.stdout(
          `genie-viewer: parsed kit-dir="${kitDir}", port=${options.port ?? DEFAULT_PORT} ` +
            "(scaffold — dev server not implemented yet; see M4-02+).\n\n",
        );
      }
      program.outputHelp();
    });

  return program;
}

/**
 * Parses `argv` (bare args, no `node`/script-path prefix — see commander's
 * `{ from: "user" }`) and returns a process exit code. Never throws: every
 * commander-raised `CommanderError` (help/version/parse-error) is caught and
 * translated to `.exitCode`; any other thrown error is reported to `stderr`
 * and treated as a generic failure (exit 1).
 */
export async function runCli(argv: string[], io: CliIO = processIO): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    io.stderr(`genie-viewer: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

// Only run when executed directly (`node dist/cli.js` / the linked bin), not
// when `cli.test.ts` imports `runCli`/`buildProgram` — mirrors the guard
// pattern verified against both plain `node` and `tsx` before writing this.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `genie-viewer: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
