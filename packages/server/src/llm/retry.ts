/**
 * Retry/backoff middleware (M2-06, DRO-253) — wraps an async LLM handler and
 * retries transient failures with exponential-jittered backoff, honouring
 * `Retry-After`, capped by `GENIE_LLM_RETRY_MAX`, surfacing a typed
 * `RateLimitedError | TransientError` on exhaustion, and logging one line
 * per retry to **stderr** (never stdout — on the stdio MCP transport, stdout
 * IS the JSON-RPC protocol stream, and any stray line there corrupts every
 * client's message framing; see `client.ts` / `plans/index.ts` /
 * `middleware/plan-guard.ts` for the same convention).
 *
 * Composed as `withRetry(createChatCompletion)` at the call sites of every
 * future generation verb (`conjure` / `refine`, M2-03 / M2-04). Kept as a
 * generic HOF rather than baked into `client.ts` for two reasons:
 *   1. `client.ts` deliberately makes exactly one attempt per call (see the
 *      comment on `maxRetries: 0` there) so retry policy lives in exactly
 *      one place — this file — where its "max N attempts" and "each attempt
 *      logged" guarantees can't be silently double-counted by SDK-internal
 *      retries happening a layer below.
 *   2. A future non-chat handler (say, an embedding call) can be wrapped
 *      the same way without knowing anything about the chat completions
 *      surface.
 *
 * Retryability discriminates by the openai SDK's real error class hierarchy
 * (`RateLimitError` / `InternalServerError` / `APIConnectionError` /
 * `APIConnectionTimeoutError`) rather than by string-matching on `err.code`
 * or `err.message`: global `fetch` wraps a socket-reset root cause as
 * `TypeError('fetch failed')` and the SDK re-wraps that as an
 * `APIConnectionError` — meaning the ECONNRESET code lives two levels deep
 * at `err.cause.cause.code` and cannot be found by looking at the outermost
 * error's own properties. The instanceof checks are the primary discriminator;
 * the deep-cause code check is a belt-and-braces fallback for any transport
 * that surfaces a raw node error without the SDK wrapping (e.g. a pre-request
 * DNS failure, or a future alternate transport).
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "openai";

// ─── Constants ───────────────────────────────────────────────────────────

/** Env var that overrides the default retry ceiling (AC5). */
export const RETRY_MAX_ENV = "GENIE_LLM_RETRY_MAX";
/** Default retry ceiling when the env var is unset / invalid (AC5). */
export const DEFAULT_RETRY_MAX = 3;
/** Base backoff delay: 1 s (AC4). */
export const BASE_DELAY_MS = 1_000;
/** Backoff cap: 30 s (AC4). */
export const MAX_DELAY_MS = 30_000;
/** Jitter multiplier applied symmetrically around the exponential value (AC4: ±20 %). */
export const JITTER_RATIO = 0.2;

/**
 * Node socket / DNS error codes that indicate a transient network failure
 * worth retrying (AC2). Kept intentionally narrow — ECONNREFUSED is
 * deliberately NOT here (a refused connection usually means the endpoint is
 * mis-configured or down, not that a retry would help; misconfiguration
 * would just burn the whole retry budget silently).
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ETIMEDOUT"]);

// ─── Errors ──────────────────────────────────────────────────────────────

/**
 * Thrown when a 429 rate-limit response was retried the full budget and the
 * upstream never gave a non-429 answer (AC6). Kept distinct from
 * `TransientError` so callers that want to surface `ERR_RATE_LIMITED`
 * separately from generic-transient-failure can branch on the type — matches
 * the FR-046 PRD note about surfacing rate-limits distinctly.
 *
 * `retryAfterMs` carries the last `Retry-After` value (in milliseconds) the
 * upstream sent, so a UI layer can show "come back in ~30 s" without having
 * to unwrap the cause itself. Undefined if the final response carried no
 * `Retry-After` header.
 */
export class RateLimitedError extends Error {
  readonly name = "RateLimitedError";
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause: Error,
    public readonly retryAfterMs?: number,
  ) {
    super(message, { cause });
  }
}

/**
 * Thrown when a 5xx / network error was retried the full budget and the
 * upstream never recovered (AC6). Callers that don't care about the
 * distinction from `RateLimitedError` should catch `TransientError |
 * RateLimitedError` as a union; both extend `Error` and both preserve the
 * originating cause on `.cause`.
 */
export class TransientError extends Error {
  readonly name = "TransientError";
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause: Error,
  ) {
    super(message, { cause });
  }
}

// ─── Env resolution (AC5) ────────────────────────────────────────────────

/**
 * Resolve `GENIE_LLM_RETRY_MAX`, falling back to `DEFAULT_RETRY_MAX` when
 * unset, blank, non-numeric, or negative. Mirrors the established fallback
 * shape of `resolveTimeoutMs` in `client.ts` and `getPlanTTL` in
 * `plans/index.ts`.
 *
 * A concrete `"0"` is a legitimate operator choice — one attempt, no retries
 * — and must NOT be collapsed with "unset". An operator running against a
 * test lab where they own the retry policy externally sets 0 and expects
 * exactly 1 attempt, not 4.
 */
export function resolveRetryMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RETRY_MAX_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_RETRY_MAX;
}

// ─── Retry-After parsing (AC3) ───────────────────────────────────────────

/**
 * Parse an HTTP `Retry-After` header (or the non-standard `retry-after-ms`)
 * into milliseconds (AC3).
 *
 * Precedence:
 *   1. `retry-after-ms` (millisecond precision, non-standard but common)
 *   2. `retry-after` as fractional seconds (RFC 9110 delay-seconds form)
 *   3. `retry-after` as HTTP-date (RFC 9110 date form) → delta from now,
 *      clamped to 0 if the date is in the past.
 *
 * Returns `null` for absent, empty, or unparseable values — the caller then
 * falls back to the jittered exponential schedule (AC4).
 *
 * The two-level parse (seconds first, HTTP-date fallback) matches the openai
 * SDK's own `retryRequest` logic in `openai/client.js` so anyone already
 * relying on either header form gets consistent behaviour whether they hit
 * this wrapper or the SDK's own internal retry.
 */
export function parseRetryAfter(headers: Headers | undefined): number | null {
  if (!headers) return null;

  // 1. Millisecond-precision (non-standard, but the openai SDK recognises it).
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const parsed = parseFloat(ms);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  // 2/3. Standard `retry-after`.
  const raw = headers.get("retry-after");
  if (!raw) return null;

  // Try delay-seconds form first — RFC 9110 §10.2.3 permits an integer
  // (technically the ABNF is non-negative-integer, but many servers send
  // fractional values and the openai SDK accepts them via parseFloat, so we
  // match that lenient posture).
  //
  // Use a regex to distinguish "genuinely numeric" from "starts with a
  // number then something else": `parseFloat("Wed 21 Oct")` returns
  // `NaN`, but `parseFloat("21 Oct 2025")` returns `21`, which would
  // silently interpret an HTTP-date as "21 seconds" if the two branches
  // weren't strictly ordered. Round-trip stringification (`` `${n}` ===
  // raw ``) is subtly wrong for values like `"7.0"` → `parseFloat` → `7`
  // → `"7"`, which doesn't match; the regex sidesteps that whole class of
  // bug by only recognising strings that ARE the numeric literal.
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = parseFloat(trimmed);
    if (!Number.isNaN(seconds)) {
      return Math.max(0, seconds * 1_000);
    }
  }

  // Fall back to HTTP-date form.
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

// ─── Jittered exponential backoff (AC4) ──────────────────────────────────

/**
 * Compute the sleep duration for the given retry `attempt` (1-indexed —
 * `attempt=1` is the delay before the first retry, i.e. after the initial
 * attempt failed). Base 1 s, doubles per attempt, capped at 30 s, then a
 * uniform ±20 % jitter applied on top (AC4).
 *
 * The cap is applied to the exponential value BEFORE the jitter multiplier,
 * so at high attempt counts the delay is still bounded by
 * `MAX_DELAY_MS * (1 + JITTER_RATIO)` on paper — but then clamped back to
 * `MAX_DELAY_MS` a second time, so the effective ceiling is exactly 30 s
 * (a strict interpretation of "cap 30 s" in the spec).
 *
 * `random` is injectable so tests can drive deterministic values without
 * needing to stub `Math.random` globally.
 */
export function jitteredBackoff(attempt: number, random: () => number = Math.random): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  const jitterMultiplier = 1 - JITTER_RATIO + random() * (JITTER_RATIO * 2);
  return Math.min(Math.round(capped * jitterMultiplier), MAX_DELAY_MS);
}

// ─── Retryability discrimination (AC2) ───────────────────────────────────

/**
 * Walk `error.cause` down to `MAX_DEPTH` levels, looking for a node-style
 * `.code` property (`ECONNRESET`, `ETIMEDOUT`, …). Global `fetch` wraps a
 * socket-reset root cause as `TypeError('fetch failed', { cause: rootErr })`
 * and the openai SDK re-wraps that as `APIConnectionError`, meaning the real
 * code lives at `err.cause.cause.code` — two levels below where a naive
 * `err.code` check would look. Depth-limited to prevent a pathological
 * self-referential cause chain from looping.
 */
function findCauseCode(error: unknown): string | undefined {
  const MAX_DEPTH = 5;
  let current: unknown = error;
  for (let i = 0; i < MAX_DEPTH && current instanceof Error; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Classify an error into "retryable rate-limit", "retryable transient", or
 * "not retryable" (AC2). The dual axis (retryable? / rate-limit-flavour?)
 * lets `withRetry` pick the right exhaustion-time error class in one pass
 * without a second round of `instanceof` checks — and lets a callsite that
 * only wants to know "should I retry this?" boolean-check `kind !==
 * "nonRetryable"`.
 */
type RetryKind = "rateLimit" | "transient" | "nonRetryable";

function classifyError(error: unknown): RetryKind {
  if (error instanceof RateLimitError) return "rateLimit";
  if (error instanceof InternalServerError) return "transient";
  if (error instanceof APIConnectionTimeoutError) return "transient";
  if (error instanceof APIConnectionError) {
    // Every APIConnectionError is treated as retryable — the SDK only
    // raises this class for wire-level failures where the request never
    // reached a productive response (socket reset, TLS handshake reject,
    // pre-request DNS failure, …). A permanent DNS failure will just burn
    // through the budget and surface as TransientError, which is the
    // correct disposition; the alternative (introspecting `cause.code` to
    // decide which subtypes to skip) risks classifying a genuinely
    // transient reset as "don't retry" and hurts the happy-path recovery
    // this middleware exists for.
    return "transient";
  }
  // Non-openai APIError with a 5xx status (defensive — future SDK versions
  // may add subclasses we haven't enumerated).
  if (error instanceof APIError && typeof error.status === "number" && error.status >= 500) {
    return "transient";
  }
  // Deep-cause network code check — catches raw node errors that bypass the
  // openai SDK entirely (e.g. a pre-request rejection from a custom fetch).
  const code = findCauseCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return "transient";
  return "nonRetryable";
}

/**
 * Pull an HTTP status out of an openai APIError for logging. Non-openai
 * errors and network-connection errors don't have one, so return null (AC7).
 */
function statusOf(error: unknown): number | null {
  if (error instanceof APIError) {
    const status = (error as APIError).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}

/**
 * Pull `Retry-After` out of an openai APIError's response headers (AC3).
 * Only present on errors carrying wire-response context (i.e. not on
 * `APIConnectionError` / `APIConnectionTimeoutError`, which never received
 * a response). Returns null when absent or unparseable.
 */
function retryAfterOf(error: unknown): number | null {
  if (error instanceof APIError && (error as APIError).headers) {
    return parseRetryAfter((error as APIError).headers as Headers);
  }
  return null;
}

// ─── Structured audit log (AC7) ──────────────────────────────────────────

/**
 * Emit one `llm.retry` audit line per retry attempt to stderr — never
 * stdout. On the stdio MCP transport stdout IS the JSON-RPC protocol
 * stream, and one stray line there corrupts every client's message framing
 * (see the same-convention comment in `client.ts` on the sibling
 * `llm.chat_completion` log).
 *
 * Includes `attempt` (1-indexed, matches AC7's contract), `status` (HTTP
 * status if the error was an APIError; null for network failures), and
 * `retryAfter` (milliseconds honoured, null if none). Deliberately does NOT
 * include the request body, prompt, or completion text — the log is what an
 * operator inspects afterwards, and leaking prompt content across every
 * transient retry would be a real audit-log data leak.
 */
function logRetry(attempt: number, status: number | null, retryAfterMs: number | null): void {
  const line = JSON.stringify({
    event: "llm.retry",
    attempt,
    status,
    retryAfter: retryAfterMs,
  });
  process.stderr.write(line + "\n");
}

// ─── The wrapper itself ──────────────────────────────────────────────────

/**
 * Options accepted by `withRetry`. All injectable to keep the wrapper unit-
 * testable without wall-clock waits or global `Math.random` / `process.env`
 * stubbing.
 */
export interface WithRetryOptions {
  /**
   * Sleep injection — defaults to a `setTimeout`-backed promise. Tests pass
   * `() => Promise.resolve()` to skip real waits without needing fake
   * timers or a global sleep stub.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Random source for jitter — defaults to `Math.random`. Tests pass
   * `() => 0.5` for deterministic midpoint behaviour.
   */
  random?: () => number;
  /**
   * Explicit retry ceiling. When set, overrides both the env var and the
   * default — useful in tests that need to force a specific number of
   * attempts without touching `process.env`. Total attempts = `1 + maxRetries`.
   */
  maxRetries?: number;
  /**
   * Env source for `maxRetries` resolution when `maxRetries` isn't set.
   * Defaults to `process.env`. Tests pass `{}` to force the default.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Default `setTimeout`-backed sleep. Extracted so both the default option
 * value and any explicit `sleep` injection route through a single named
 * function — makes stack traces in fake-timer tests self-explanatory.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap an async LLM handler with retry/backoff (AC1). Returns a function
 * with the SAME argument list and return type as the input handler, so
 * `withRetry(createChatCompletion)` is a drop-in replacement for
 * `createChatCompletion` at every call site.
 *
 * Order of operations per attempt:
 *   1. Call the handler.
 *   2. On success → return the result immediately.
 *   3. On failure → classify (AC2). Non-retryable errors propagate as-is
 *      (the original error object, not a wrapped one — a caller that
 *      already has instanceof/status handling for BadRequestError et al.
 *      keeps working unchanged).
 *   4. On retryable failure with remaining budget → emit an `llm.retry`
 *      log line (AC7), sleep for `Retry-After` (AC3) or the jittered
 *      backoff (AC4), then loop.
 *   5. On retryable failure with exhausted budget → throw
 *      `RateLimitedError` (if the tail-cause was a 429) or `TransientError`
 *      (otherwise), preserving the original error on `.cause` (AC6).
 *
 * A handler that transitions from one retryable kind to another across
 * attempts (say 429 → 503 → 500) throws whichever kind matches the LAST
 * failing attempt, on the reasoning that "what the caller sees now" is the
 * most useful discriminator for their fallback branch — a 429-turned-503
 * indicates a genuinely degraded upstream, not a persistent rate-limit.
 */
export function withRetry<A extends readonly unknown[], R>(
  handler: (...args: A) => Promise<R>,
  opts: WithRetryOptions = {},
): (...args: A) => Promise<R> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxRetries = opts.maxRetries ?? resolveRetryMax(opts.env ?? process.env);

  return async (...args: A): Promise<R> => {
    let lastError: unknown;
    // attempt 0 is the initial attempt; attempts 1..maxRetries are retries.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await handler(...args);
      } catch (error) {
        lastError = error;
        const kind = classifyError(error);
        if (kind === "nonRetryable") {
          throw error;
        }
        const remainingRetries = maxRetries - attempt;
        if (remainingRetries <= 0) {
          // Budget exhausted — surface a typed error. Kind is derived from
          // the LAST failing attempt, on the reasoning that "what the
          // caller sees now" is the most useful discriminator (see the
          // JSDoc above).
          const err = error as Error;
          const attemptsTotal = attempt + 1;
          if (kind === "rateLimit") {
            const retryAfterMs = retryAfterOf(error);
            throw new RateLimitedError(
              `LLM call exhausted ${attemptsTotal} attempts on rate-limit (429).`,
              attemptsTotal,
              err,
              retryAfterMs ?? undefined,
            );
          }
          throw new TransientError(
            `LLM call exhausted ${attemptsTotal} attempts on transient failure.`,
            attemptsTotal,
            err,
          );
        }
        // Retry — log, sleep, loop.
        const status = statusOf(error);
        const retryAfterMs = retryAfterOf(error);
        // 1-indexed attempt number for the audit log (attempt=1 is the
        // first retry, i.e. the second call overall).
        logRetry(attempt + 1, status, retryAfterMs);
        const delayMs = retryAfterMs ?? jitteredBackoff(attempt + 1, random);
        await sleep(delayMs);
      }
    }
    // Unreachable: the loop either returns on success or throws on the
    // budget-exhaustion branch. TypeScript wants an explicit throw here
    // because it can't prove the loop always terminates via one of those
    // two branches — `throw` on the final `lastError` closes the type.
    throw lastError as Error;
  };
}
