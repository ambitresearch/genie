/**
 * Tests for the `genie-viewer` CLI's argument PARSING surface
 * (`packages/viewer/src/cli.ts`) — the usage/version/help output (AC6) and
 * `--port` validation, first stood up by M4-01's (DRO-263) scaffold.
 *
 * The polished boot behavior this parser now dispatches to — validating the
 * kit dir, booting Vite, printing the URL, auto-open, Ctrl-C teardown (AC1–AC5,
 * AC7) — is covered in `cli.boot.test.ts`. This file stays focused on parsing;
 * where a parse now has to reach the boot path to be observable (a kit-dir
 * threads its port through to the server), it injects a FAKE `CliDeps` so no
 * real Vite server is booted and no real signals/exit are touched.
 *
 * Drives the real commander program in-process (no subprocess spawning) via
 * `buildProgram`/`runCli`'s injected {@link CliIO} seam — see the `cli.ts`
 * file header for why `exitOverride()` + `configureOutput()` make this safe
 * (no stray `process.exit()`, no touching real stdout/stderr).
 *
 * Covers:
 *   - AC6 — usage string is exactly `Usage: genie-viewer <kit-dir> [--port N]`.
 *   - `--version` / `-v` prints `VIEWER_VERSION` and exits 0.
 *   - `--help` / `-h` prints usage and exits 0.
 *   - bare invocation (no kit-dir) prints help and exits 0 — doesn't throw.
 *   - a valid kit-dir threads the parsed port through to the (faked) boot,
 *     with the default, with an explicit `--port`, and order-independently.
 *   - malformed `--port` (non-numeric, non-integer, zero, negative,
 *     above 65535) is rejected with a non-zero exit and a descriptive
 *     stderr message; every accepted boundary (1, 65535, a mid-range value)
 *     parses to the right number.
 *   - an unknown flag and a `--port` missing its value both fail non-zero.
 *   - `buildProgram`'s static shape (name/usage) is asserted directly,
 *     independent of a parse.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { InlineConfig, ViteDevServer } from "vite";

import {
  buildProgram,
  DEFAULT_PORT,
  parsePort,
  runCli,
  VIEWER_VERSION,
  type CliDeps,
  type CliIO,
} from "./cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_PKG = resolve(HERE, "..");

/**
 * Fake {@link CliDeps} that captures the Vite config a boot would receive
 * (so a test can read the threaded port back) without binding a port, opening
 * a browser, or registering real signal handlers / calling `process.exit`.
 * `cwd` points at the viewer package so a relative `test/fixtures/kit` resolves
 * to the real fixture (which has a `.genie/manifest.json`, passing AC7).
 */
function fakeCliDeps(): { deps: CliDeps; bootedPort: () => number | undefined } {
  let capturedPort: number | undefined;
  const deps: CliDeps = {
    cwd: () => VIEWER_PKG,
    createServer: async (config: InlineConfig) => {
      capturedPort = config.server?.port;
      return {
        config: { server: { port: capturedPort } },
        resolvedUrls: { local: [`http://127.0.0.1:${capturedPort}/`], network: [] },
        listen: async function (this: ViteDevServer) {
          return this;
        },
        close: async () => {},
      } as unknown as ViteDevServer;
    },
    openBrowser: vi.fn(async () => {}),
    onSignal: () => {},
    exit: () => {},
    setTimer: () => ({ unref: () => {} }),
    timeoutMs: 1000,
  };
  return { deps, bootedPort: () => capturedPort };
}

/** Collects everything written through a {@link CliIO} seam for assertions. */
function createRecordingIO(): CliIO & { out: () => string; err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (chunk) => {
      stdout.push(chunk);
    },
    stderr: (chunk) => {
      stderr.push(chunk);
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

describe("parsePort", () => {
  it.each([
    ["1", 1],
    ["65535", 65535],
    ["5173", 5173],
    ["8080", 8080],
  ])("accepts %s as a valid port", (input, expected) => {
    expect(parsePort(input)).toBe(expected);
  });

  it.each([
    ["0", "below the 1-65535 range"],
    ["65536", "above the 1-65535 range"],
    ["-1", "negative"],
    ["abc", "non-numeric"],
    ["3.14", "non-integer"],
    ["", "empty string"],
    ["  ", "whitespace-only"],
    ["NaN", "the literal string NaN"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parsePort(input)).toThrow(/--port must be an integer between 1 and 65535/);
  });

  it("includes the offending value in the error message", () => {
    expect(() => parsePort("abc")).toThrow(/got: "abc"/);
  });
});

describe("buildProgram", () => {
  it("names the program genie-viewer", () => {
    const io = createRecordingIO();
    expect(buildProgram(io).name()).toBe("genie-viewer");
  });

  it("sets the AC6-mandated usage string", () => {
    const io = createRecordingIO();
    expect(buildProgram(io).usage()).toBe("<kit-dir> [--port N]");
  });
});

describe("runCli", () => {
  it("AC6: --help output contains the exact required usage line", async () => {
    const io = createRecordingIO();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("Usage: genie-viewer <kit-dir> [--port N]");
  });

  it("-h is a shorthand for --help", async () => {
    const io = createRecordingIO();
    const code = await runCli(["-h"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("Usage: genie-viewer <kit-dir> [--port N]");
  });

  it("--version prints VIEWER_VERSION and exits 0", async () => {
    const io = createRecordingIO();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(io.out().trim()).toBe(VIEWER_VERSION);
  });

  it("-v is a shorthand for --version", async () => {
    const io = createRecordingIO();
    const code = await runCli(["-v"], io);
    expect(code).toBe(0);
    expect(io.out().trim()).toBe(VIEWER_VERSION);
  });

  it("a bare invocation (no kit-dir) does not throw and prints help", async () => {
    const io = createRecordingIO();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("Usage: genie-viewer <kit-dir> [--port N]");
    // No kit-dir was parsed, so the scaffold echo line must not appear.
    expect(io.out()).not.toContain("parsed kit-dir=");
  });

  it("a bare invocation reports no error on stderr", async () => {
    const io = createRecordingIO();
    await runCli([], io);
    expect(io.err()).toBe("");
  });

  it("threads the default port through to boot when only kit-dir is given", async () => {
    const io = createRecordingIO();
    const { deps, bootedPort } = fakeCliDeps();
    const code = await runCli(["test/fixtures/kit"], io, deps);
    expect(code).toBe(0);
    expect(bootedPort()).toBe(DEFAULT_PORT);
    expect(io.out()).toContain(`Preview: http://127.0.0.1:${DEFAULT_PORT}`);
  });

  it("threads an explicit --port through to boot alongside the kit-dir", async () => {
    const io = createRecordingIO();
    const { deps, bootedPort } = fakeCliDeps();
    const code = await runCli(["test/fixtures/kit", "--port", "4000"], io, deps);
    expect(code).toBe(0);
    expect(bootedPort()).toBe(4000);
  });

  it("accepts --port before the kit-dir positional (order-independent)", async () => {
    const io = createRecordingIO();
    const { deps, bootedPort } = fakeCliDeps();
    const code = await runCli(["--port", "4000", "test/fixtures/kit"], io, deps);
    expect(code).toBe(0);
    expect(bootedPort()).toBe(4000);
  });

  it("rejects a non-numeric --port with a non-zero exit", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit", "--port", "abc"], io);
    expect(code).not.toBe(0);
    expect(io.err()).toContain("--port must be an integer between 1 and 65535");
  });

  it("rejects an out-of-range --port with a non-zero exit", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit", "--port", "999999"], io);
    expect(code).not.toBe(0);
    expect(io.err()).toContain("--port must be an integer between 1 and 65535");
  });

  it("rejects --port given with no value", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit", "--port"], io);
    expect(code).not.toBe(0);
    expect(io.err().length).toBeGreaterThan(0);
  });

  it("rejects an unknown option with a non-zero exit", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit", "--bogus"], io);
    expect(code).not.toBe(0);
    expect(io.err()).toContain("unknown option");
  });

  it("maps a CliError (AC7 validation) to a non-zero exit and prints its message", async () => {
    // A parseable invocation that reaches validateKitDir and fails there —
    // exercises runCli's `CliError` catch branch (distinct from the
    // CommanderError parse-error branch the cases above hit). The faked cwd
    // resolves the relative kit-dir to the manifest-less `empty-kit` fixture.
    const io = createRecordingIO();
    const { deps } = fakeCliDeps();
    const code = await runCli(["test/fixtures/empty-kit"], io, deps);
    expect(code).not.toBe(0);
    expect(io.err()).toContain("genie-viewer:");
    expect(io.err()).toContain(".genie/manifest.json");
    expect(io.err()).toMatch(/MCP server/i);
  });

  it("does not boot the server when kit-dir validation fails", async () => {
    // AC7 guard-before-boot: a failed validation must short-circuit before
    // createServer is ever called.
    const io = createRecordingIO();
    const { deps, bootedPort } = fakeCliDeps();
    await runCli(["test/fixtures/empty-kit"], io, deps);
    expect(bootedPort()).toBeUndefined();
  });

  it("never throws, even on malformed input", async () => {
    const io = createRecordingIO();
    await expect(runCli(["--port", "not-a-port"], io)).resolves.not.toThrow();
  });
});
