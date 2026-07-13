/**
 * Secret loading and validation (M5-03 / DRO-275).
 *
 * genie never reads secrets from the repo, a config file, or `argv` — only
 * from environment variables (or, for containerized deployments, a single
 * file mounted at a path given by `--secrets-from`, whose contents are
 * copied into `process.env` before `loadSecrets()` reads them). This module
 * is the one place that knows the full list of secret-shaped env vars, so a
 * startup audit (AC3) and a logger redaction list (AC4, see `redact.ts`) can
 * both derive from the same source of truth instead of drifting apart.
 *
 * Existing call sites (`llm/client.ts`'s `GENIE_LLM_API_KEY`,
 * `store/git-host.ts`'s `GENIE_GIT_TOKEN`) already read straight from
 * `process.env` and are intentionally left alone — this module does not
 * replace them, it adds a fail-fast bootstrap check plus the redaction/audit
 * plumbing described in the issue. A later cleanup could route those
 * modules through `loadSecrets()` too, but that is out of scope here (it
 * would touch call sites this issue's ACs don't mention).
 */

import { readFile } from "node:fs/promises";

/** Minimum length (chars) a secret value must have to be accepted (AC2). */
export const MIN_SECRET_LENGTH = 16;

/**
 * Registry of every secret-shaped env var genie's server reads, in one
 * place. `required: false` entries (e.g. `GENIE_GIT_TOKEN`, only needed when
 * the GitHostStore adapter is active) are validated for shape *if present*
 * but do not fail bootstrap when absent.
 */
export interface SecretSpec {
  /** Env var name. */
  name: string;
  /** Whether `loadSecrets()` throws if this var is unset/blank. */
  required: boolean;
}

export const SECRET_SPECS: readonly SecretSpec[] = [
  { name: "GENIE_LLM_API_KEY", required: true },
  { name: "OAUTH_HS256_KEY", required: false },
  { name: "GENIE_GIT_TOKEN", required: false },
  { name: "OAUTH_CLIENT_SECRET", required: false },
];

/** Loaded, validated secret values keyed by env var name. */
export type SecretValues = Readonly<Record<string, string>>;

/**
 * Thrown when a required secret is missing, too short, or was found in
 * `process.argv` (AC2). Carries structured detail so callers/tests can
 * assert on the failure reason without parsing the message string.
 */
export class SecretValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid secret configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "SecretValidationError";
  }
}

/**
 * If `secretsFromPath` is given, read that file and merge each `KEY=value`
 * line into `env` (only for keys not already set — real env vars always win,
 * matching common Docker-secret convention). Blank lines and lines starting
 * with `#` are ignored. Does not throw if the file doesn't exist unless the
 * caller explicitly requested a path — a missing explicitly-requested file
 * is itself a misconfiguration.
 */
async function loadSecretsFile(
  secretsFromPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const contents = await readFile(secretsFromPath, "utf-8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (env[key] === undefined) env[key] = value;
  }
}

export interface LoadSecretsOptions {
  /** Env to read from/mutate. Defaults to `process.env` (tests inject their own). */
  env?: NodeJS.ProcessEnv;
  /** Argv to scan for leaked secret values. Defaults to `process.argv`. */
  argv?: readonly string[];
  /** Optional path to a mounted secrets file (AC6, `--secrets-from`). */
  secretsFromPath?: string;
  /** Override the registry of specs to validate. Defaults to `SECRET_SPECS`. */
  specs?: readonly SecretSpec[];
}

/**
 * Load and validate every known secret (AC1). Reads from `env` only (after
 * optionally merging in a mounted secrets file, AC6). Throws
 * `SecretValidationError` if:
 *   - a `required` secret is missing or blank,
 *   - any known secret's value is shorter than `MIN_SECRET_LENGTH` (AC2),
 *   - any known secret's value appears verbatim as an `argv` entry (AC2) —
 *     e.g. someone mis-set `--api-key=<value>` on the CLI instead of an env
 *     var, which would otherwise leak the secret into `ps`/shell history.
 *
 * Never logs or returns anything about *rejected* values beyond the key
 * name — only key names appear in error messages, never the value itself.
 */
export async function loadSecrets(
  options: LoadSecretsOptions = {},
): Promise<SecretValues> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const specs = options.specs ?? SECRET_SPECS;

  if (options.secretsFromPath) {
    await loadSecretsFile(options.secretsFromPath, env);
  }

  const problems: string[] = [];
  const values: Record<string, string> = {};

  for (const spec of specs) {
    const raw = env[spec.name];
    const value = raw?.trim();

    if (!value) {
      if (spec.required) problems.push(`${spec.name} is required but not set`);
      continue;
    }

    if (value.length < MIN_SECRET_LENGTH) {
      problems.push(
        `${spec.name} is shorter than the minimum ${MIN_SECRET_LENGTH} characters`,
      );
      continue;
    }

    if (argv.some((arg) => arg.includes(value))) {
      problems.push(`${spec.name}'s value was found in process.argv — never pass secrets as CLI flags`);
      continue;
    }

    values[spec.name] = value;
  }

  if (problems.length > 0) throw new SecretValidationError(problems);

  return values;
}

/**
 * Names of the secrets that were actually loaded (present + valid), for a
 * startup audit log line (AC3). Never includes values.
 */
export function auditSecretNames(values: SecretValues): string[] {
  return Object.keys(values).sort();
}
