/**
 * Log redaction (M5-03 / DRO-275, AC4).
 *
 * The configured pino logger combines path-based redaction for known secret
 * keys with value-based scrubbing for arbitrary fields and message strings.
 */

import pino, { type DestinationStream, type Logger } from "pino";

import { SECRET_DEFINITIONS, type LoadedSecret } from "./secrets.js";

/** Censor string substituted for any redacted value (AC4). */
export const REDACTED = "****";

/** Pino paths that are always redacted, regardless of their values. */
export const redactOptions = {
  paths: [
    ...SECRET_DEFINITIONS.map((definition) => definition.key),
    ...SECRET_DEFINITIONS.map((definition) => `*.${definition.key}`),
    ...SECRET_DEFINITIONS.map((definition) => `env.${definition.key}`),
    "req.headers.authorization",
    "*.req.headers.authorization",
  ],
  censor: REDACTED,
};

/** Replace every occurrence of each configured secret value in text. */
export function redactSecretValues(text: string, secrets: readonly LoadedSecret[]): string {
  let redacted = text;
  for (const { value } of secrets) {
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}

function redactLogValue(
  value: unknown,
  secrets: readonly LoadedSecret[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactSecretValues(value, secrets);
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      type: value.name,
      message: redactSecretValues(value.message, secrets),
      stack: value.stack ? redactSecretValues(value.stack, secrets) : undefined,
    };
    seen.set(value, redactedError);
    for (const [key, nestedValue] of Object.entries(value)) {
      redactedError[key] = redactLogValue(nestedValue, secrets, seen);
    }
    return redactedError;
  }

  if (Array.isArray(value)) {
    const redactedArray: unknown[] = [];
    seen.set(value, redactedArray);
    for (const item of value) redactedArray.push(redactLogValue(item, secrets, seen));
    return redactedArray;
  }

  const redactedObject: Record<string, unknown> = {};
  seen.set(value, redactedObject);
  for (const [key, nestedValue] of Object.entries(value)) {
    redactedObject[key] = redactLogValue(nestedValue, secrets, seen);
  }
  return redactedObject;
}

/** Create the server logger with pino path and configured-value redaction. */
export function createRedactingLogger(
  secrets: readonly LoadedSecret[],
  destination: DestinationStream = pino.destination({ dest: 2, sync: true }),
): Logger {
  return pino(
    {
      redact: redactOptions,
      hooks: {
        logMethod(args, method) {
          const seen = new WeakMap<object, unknown>();
          const redactedArgs = args.map((arg) => redactLogValue(arg, secrets, seen)) as typeof args;
          method.apply(this, redactedArgs);
        },
      },
    },
    destination,
  );
}
