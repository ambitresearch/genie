/**
 * Tests for M4-01's (DRO-263) `genie-viewer` bin scaffold
 * (`packages/viewer/src/cli.ts`).
 *
 * This issue is scaffold-only (see the file header in `cli.ts`): there is no
 * dev server, no filesystem watch, no rendering to test yet. What *is*
 * testable at this milestone is the argument parser and the CLI's static
 * output — that's what AC6 actually asks for ("Bin script greets with
 * `Usage: genie-viewer <kit-dir> [--port N]`").
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
 *   - bare invocation (no kit-dir) prints help and exits 0 — doesn't throw,
 *     doesn't require a real directory (that validation is M4-08 scope).
 *   - a kit-dir argument is echoed back (manual-verification / DoD support),
 *     with and without an explicit `--port`.
 *   - malformed `--port` (non-numeric, non-integer, zero, negative,
 *     above 65535) is rejected with a non-zero exit and a descriptive
 *     stderr message; every accepted boundary (1, 65535, a mid-range value)
 *     parses to the right number.
 *   - an unknown flag and a `--port` missing its value both fail non-zero.
 *   - `buildProgram`'s static shape (name/usage) is asserted directly,
 *     independent of a parse.
 */
import { describe, expect, it } from "vitest";

import {
  buildProgram,
  DEFAULT_PORT,
  parsePort,
  runCli,
  VIEWER_VERSION,
  type CliIO,
} from "./cli.js";

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

  it("echoes the parsed kit-dir and the default port when only kit-dir is given", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain(`genie-viewer: parsed kit-dir="./my-kit", port=${DEFAULT_PORT}`);
  });

  it("echoes an explicit --port alongside the kit-dir", async () => {
    const io = createRecordingIO();
    const code = await runCli(["./my-kit", "--port", "4000"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('genie-viewer: parsed kit-dir="./my-kit", port=4000');
  });

  it("accepts --port before the kit-dir positional (order-independent)", async () => {
    const io = createRecordingIO();
    const code = await runCli(["--port", "4000", "./my-kit"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('genie-viewer: parsed kit-dir="./my-kit", port=4000');
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

  it("never throws, even on malformed input", async () => {
    const io = createRecordingIO();
    await expect(runCli(["--port", "not-a-port"], io)).resolves.not.toThrow();
  });
});
