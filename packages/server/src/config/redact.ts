/**
 * Log redaction (M5-03 / DRO-275, AC4).
 *
 * genie doesn't depend on a specific logger (no `pino`/`winston` dependency
 * exists in `@genie/server` today — see `package.json`), so instead of
 * bolting one on for this issue alone, this module exports a small
 * logger-agnostic redaction primitive: given the set of secret values
 * actually loaded by `loadSecrets()`, `redactSecrets()` scrubs any of those
 * exact values out of an arbitrary log string, replacing each with `****`.
 * Any call site that formats a line before writing it (console, a future
 * pino instance via its `redact` hook, etc.) can pass the line through this
 * first.
 */

import type { SecretValues } from "./secrets.js";

/** Replacement text substituted for every redacted secret occurrence. */
export const REDACTED_PLACEHOLDER = "****";

/**
 * Build a redactor bound to a fixed set of secret values. Returns a function
 * that scrubs every occurrence of any of those values from an input string.
 * Longer values are matched before shorter ones so a secret that happens to
 * be a substring of another isn't left partially exposed.
 */
export function createRedactor(
  secrets: SecretValues,
): (input: string) => string {
  const values = Object.values(secrets)
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) {
    return (input: string) => input;
  }

  return (input: string): string => {
    let out = input;
    for (const value of values) {
      out = out.split(value).join(REDACTED_PLACEHOLDER);
    }
    return out;
  };
}

/**
 * One-shot convenience wrapper around `createRedactor` for call sites that
 * don't want to hold onto a bound redactor (e.g. a single startup log line).
 */
export function redactSecrets(input: string, secrets: SecretValues): string {
  return createRedactor(secrets)(input);
}
