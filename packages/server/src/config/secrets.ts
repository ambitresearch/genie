/**
 * Secret loading (M5-03 / DRO-275) — no plaintext secrets at rest.
 *
 * Every secret genie uses is read only from env vars or, when
 * `--secrets-from <path>` is passed (e.g. a mounted Docker/Kubernetes
 * secret), from an owner-only `KEY=VALUE`-per-line file at that path (AC6).
 * Files with group/other permission bits are rejected before reading. Nothing
 * secret is ever hardcoded, and this module never writes a secret value to
 * disk, argv, or a log line.
 *
 * Bootstrap contract (AC2): `loadSecrets()` throws `SecretValidationError`
 * with one message per problem when any required secret is missing or any
 * configured secret is invalid:
 *   - missing (unset, and absent from a `--secrets-from` file if provided);
 *   - shorter than its required minimum length;
 *   - present verbatim anywhere in `process.argv` (a value passed as a CLI
 *     flag is visible to `ps`/shell history on every other local user, so a
 *     secret leaking into argv is treated as fatal, not just discouraged).
 *
 * AC3: `auditLoadedSecrets` logs which secret *names* were loaded (never
 * values) as a single structured line on process.stderr, mirroring the
 * stdout-is-JSON-RPC convention documented in `llm/client.ts`.
 */

import { readFileSync, statSync } from "node:fs";

// ─── Known secrets ───────────────────────────────────────────────────────────

/** Every secret env var genie recognises, and whether it's required to boot. */
export const SECRET_DEFINITIONS = [
  { key: "GENIE_LLM_API_KEY", required: true, minLength: 16 },
  { key: "OAUTH_HS256_KEY", required: false, minLength: 32 },
  { key: "GENIE_GIT_TOKEN", required: false, minLength: 0 },
  { key: "OAUTH_CLIENT_SECRET", required: false, minLength: 0 },
] as const;

/** Union of every secret key name genie knows about. */
export type SecretKey = (typeof SECRET_DEFINITIONS)[number]["key"];

/** Minimum acceptable length for a required secret value (AC2). */
export const MIN_SECRET_LENGTH = 16;
const SECRET_SETUP_URL =
  "https://github.com/ambitresearch/genie/blob/main/docs/user/installation.md#required-secrets";

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by `loadSecrets` when bootstrap validation fails. Aggregates every
 * problem found (not just the first) so a misconfigured deployment gets the
 * full picture in one failure rather than fixing issues one at a time.
 */
export class SecretValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Secret validation failed:\n  - ${problems.join("\n  - ")}\n\nSetup: ${SECRET_SETUP_URL}`,
    );
    this.name = "SecretValidationError";
  }
}

// ─── Secrets-from-file parsing ───────────────────────────────────────────────

/**
 * Parse a `KEY=VALUE`-per-line secrets file (AC6), e.g. a mounted secret
 * mounted at `/run/secrets/genie`. Blank lines and `#`-prefixed comments are
 * skipped. Values are not trimmed of surrounding quotes — the file is
 * expected to hold raw values, matching Docker/Kubernetes secret conventions
 * (unlike a shell-sourced `.env`, no quoting/escaping is applied).
 */
export function parseSecretsFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "") continue;
    out[key] = value;
  }
  return out;
}

// ─── loadSecrets ─────────────────────────────────────────────────────────────

/** A loaded secret: its name and value, never logged together (AC3). */
export interface LoadedSecret {
  key: SecretKey;
  value: string;
}

/** Apply validated secrets to the runtime environment used by downstream services. */
export function applyLoadedSecrets(
  secrets: readonly LoadedSecret[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const { key } of SECRET_DEFINITIONS) delete env[key];
  for (const { key, value } of secrets) env[key] = value;
}

export interface LoadSecretsOptions {
  /** Environment to read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** argv to scan for leaked secret values. Defaults to `process.argv`. */
  argv?: readonly string[];
  /**
   * Path to a `KEY=VALUE` secrets file (e.g. `--secrets-from`, AC6). When
   * given, values from this file take precedence over env for the same key.
   */
  secretsFromPath?: string;
  /** Injectable file reader, for tests. Defaults to `node:fs`'s `readFileSync`. */
  readFile?: (path: string) => string;
  /** Injectable file stat, for testing mounted-secret permissions. */
  statFile?: (path: string) => { mode: number };
}

/**
 * Load and validate every known secret (AC1/AC2). Reads from env only,
 * optionally overlaid by a `--secrets-from` file (AC6). Throws
 * `SecretValidationError` if any required secret is missing, any configured
 * secret is too short, or a secret is leaked into argv verbatim.
 *
 * Returns only the secrets that were actually present (optional secrets are
 * omitted when unset) so callers can distinguish "not configured" from "".
 */
export function loadSecrets(options: LoadSecretsOptions = {}): LoadedSecret[] {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const statFile = options.statFile ?? statSync;

  let fileValues: Record<string, string> = {};
  if (options.secretsFromPath) {
    const mode = statFile(options.secretsFromPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new SecretValidationError([
        `Secrets file ${options.secretsFromPath} must not be readable or writable by group or other users (mode ${mode.toString(8).padStart(3, "0")}).`,
      ]);
    }
    fileValues = parseSecretsFile(readFile(options.secretsFromPath));
  }

  const problems: string[] = [];
  const loaded: LoadedSecret[] = [];

  for (const def of SECRET_DEFINITIONS) {
    const value = fileValues[def.key] ?? env[def.key];

    if (value === undefined || value === "") {
      if (def.required) problems.push(`${def.key} is required but not set.`);
      continue;
    }

    if (value.length < def.minLength) {
      problems.push(
        `${def.key} must be at least ${def.minLength} characters (got ${value.length}).`,
      );
    }

    if (argv.some((arg) => arg.includes(value))) {
      problems.push(
        `${def.key}'s value was found in process.argv — secrets must never be passed as CLI flags.`,
      );
    }

    loaded.push({ key: def.key, value });
  }

  if (problems.length > 0) throw new SecretValidationError(problems);

  return loaded;
}

// ─── Startup audit (AC3) ─────────────────────────────────────────────────────

/**
 * Log which secrets were loaded — key names only, never values — as a single
 * structured line on stderr (stdout is the JSON-RPC stream on the stdio
 * transport; see `llm/client.ts` for the same convention).
 */
export function auditLoadedSecrets(
  loaded: readonly LoadedSecret[],
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  write(
    JSON.stringify({
      event: "secrets.loaded",
      keys: loaded.map((s) => s.key),
    }) + "\n",
  );
}
