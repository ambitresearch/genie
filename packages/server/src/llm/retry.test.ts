/**
 * Tests for the M2-06 retry/backoff middleware (`withRetry`).
 *
 * The wire-level behaviour tests use a real `node:http` stub server rather
 * than a `globalThis.fetch` mock: the `openai` SDK's default fetch is the
 * real global `fetch` (Node ≥ 22), and only a stub that actually accepts a
 * TCP connection can exercise the true error shapes M2-06 discriminates on
 * (`RateLimitError` / `InternalServerError` / `APIConnectionError` /
 * `APIConnectionTimeoutError`). This mirrors the convention already
 * established in `client.test.ts` — same helper shape (`startStubServer`),
 * same `.invalid` bootstrap env vars, same `vi.resetModules()` + dynamic
 * import pattern for tests that need a fresh module singleton.
 *
 * Pure-math tests (jitter distribution, `parseRetryAfter`, `resolveRetryMax`)
 * import the retry module directly and drive it with injected `sleep`/`random`
 * fakes — no wall-clock waits, no real randomness, no flaky suites.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE_URL_ENV = "GENIE_LLM_BASE_URL";
const API_KEY_ENV = "GENIE_LLM_API_KEY";
const RETRY_MAX_ENV = "GENIE_LLM_RETRY_MAX";

// ─── Bootstrap import ────────────────────────────────────────────────────
//
// The retry module is pure (no import-time singleton construction), so a
// bootstrap import is not strictly required — but the `createChatCompletion`
// tests below dynamically import `./client.js`, which DOES construct a
// singleton at import time and would throw `MissingLLMConfigError` without
// env vars. Set placeholder RFC 2606 `.invalid` env vars up front so any
// accidental `import "./client.js"` before its own `vi.resetModules()` block
// doesn't fail; clear them immediately after the retry module has been
// pulled in, since every test that cares owns its own env setup.
process.env[BASE_URL_ENV] = "http://llm-retry-test-bootstrap.invalid/v1";
process.env[API_KEY_ENV] = "sk-bootstrap-placeholder";
const {
  withRetry,
  RateLimitedError,
  TransientError,
  parseRetryAfter,
  jitteredBackoff,
  resolveRetryMax,
  RETRY_MAX_ENV: RETRY_MAX_ENV_CONST,
  DEFAULT_RETRY_MAX,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_RATIO,
  MAX_RETRY_AFTER_MS,
} = await import("./retry.js");
delete process.env[BASE_URL_ENV];
delete process.env[API_KEY_ENV];

// Sanity-check the exported env var name matches this file's literal — if
// they ever drift apart, every `GENIE_LLM_RETRY_MAX` test below would
// silently be exercising the wrong env var.
if (RETRY_MAX_ENV_CONST !== RETRY_MAX_ENV) {
  throw new Error("retry.ts RETRY_MAX_ENV drifted from this test file's literal");
}

// ─── Stub server helper (mirrors client.test.ts) ─────────────────────────

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface StubResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

async function startStubServer(
  handler: (req: CapturedRequest) => StubResponse | Promise<StubResponse>,
): Promise<{ baseURL: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf-8");
          let parsedBody: unknown = undefined;
          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch {
              parsedBody = rawBody;
            }
          }
          const captured: CapturedRequest = {
            method: req.method,
            path: req.url,
            headers: req.headers,
            body: parsedBody,
          };
          requests.push(captured);
          const { status, body, headers } = await handler(captured);
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
          }
          res.end(
            JSON.stringify({
              error: { message: `stub server handler failed: ${String(err)}` },
            }),
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseURL,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface StubChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string;
    message: { role: "assistant"; content: string };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function stubChatCompletion(): StubChatCompletion {
  return {
    id: "chatcmpl-retry-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "design-default",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hello from the retry stub" },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

// ─── Exported-constant sanity (AC4, AC5) ─────────────────────────────────

describe("retry module constants", () => {
  it("uses BASE_DELAY_MS = 1000 (AC4)", () => {
    expect(BASE_DELAY_MS).toBe(1_000);
  });
  it("uses MAX_DELAY_MS = 30000 (AC4)", () => {
    expect(MAX_DELAY_MS).toBe(30_000);
  });
  it("uses JITTER_RATIO = 0.2 (AC4)", () => {
    expect(JITTER_RATIO).toBe(0.2);
  });
  it("defaults DEFAULT_RETRY_MAX = 3 (AC5)", () => {
    expect(DEFAULT_RETRY_MAX).toBe(3);
  });
  it("exposes RETRY_MAX_ENV = 'GENIE_LLM_RETRY_MAX' (AC5)", () => {
    expect(RETRY_MAX_ENV_CONST).toBe("GENIE_LLM_RETRY_MAX");
  });
  it("caps honoured Retry-After sleep at MAX_RETRY_AFTER_MS = 60_000 (Copilot review on PR #126)", () => {
    // 60 s is a design decision: it's double MAX_DELAY_MS (30 s), so an
    // explicit upstream signal still outranks our own jittered guess, but
    // a misconfigured/hostile upstream can't hang the whole MCP request
    // for hours. See the constant's JSDoc for the full rationale.
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
  });
});

// ─── resolveRetryMax (AC5) ───────────────────────────────────────────────

describe("resolveRetryMax", () => {
  it("returns DEFAULT_RETRY_MAX when unset (AC5)", () => {
    expect(resolveRetryMax({})).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({})).toBe(3);
  });

  it("parses a valid positive integer (AC5)", () => {
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "5" })).toBe(5);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "1" })).toBe(1);
  });

  it("allows 0 to mean 'do not retry' (single attempt only)", () => {
    // A concrete "0" is a legitimate operator choice — one attempt, no
    // retries — and must NOT be collapsed with "unset". This is the
    // stricter behaviour needed for AC5's "configurable via env" wording:
    // an operator who wants to disable retry policy entirely (e.g. in a
    // test lab where they're the retry policy) sets 0 and expects exactly
    // 1 attempt, not 4.
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "0" })).toBe(0);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "not-a-number" })).toBe(DEFAULT_RETRY_MAX);
  });

  it("falls back to the default for a negative value", () => {
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "-1" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "-10" })).toBe(DEFAULT_RETRY_MAX);
  });

  it("falls back to the default for a blank string", () => {
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "   " })).toBe(DEFAULT_RETRY_MAX);
  });

  it("falls back to the default for a partially-numeric value (Copilot review on PR #126)", () => {
    // `parseInt` alone silently accepts a leading-numeric prefix —
    // `parseInt("5s", 10)` === 5 and `parseInt("3.5", 10)` === 3 — despite
    // neither being a clean integer. That contradicts this function's own
    // "non-numeric → default" contract and would silently misconfigure an
    // operator who fat-fingered the env var (e.g. copy-pasted a value with
    // a trailing unit, or a decimal). The regex guard must reject both.
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "5s" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "3.5" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "5 " })).toBe(5); // trimmed first, then all-digit — still valid
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "+5" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "0x5" })).toBe(DEFAULT_RETRY_MAX);
    expect(resolveRetryMax({ [RETRY_MAX_ENV]: "5e2" })).toBe(DEFAULT_RETRY_MAX);
  });

  it("defaults its env argument to process.env when called with none", () => {
    const prev = process.env[RETRY_MAX_ENV];
    try {
      process.env[RETRY_MAX_ENV] = "7";
      expect(resolveRetryMax()).toBe(7);
    } finally {
      if (prev === undefined) delete process.env[RETRY_MAX_ENV];
      else process.env[RETRY_MAX_ENV] = prev;
    }
  });
});

// ─── parseRetryAfter (AC3) ───────────────────────────────────────────────

describe("parseRetryAfter", () => {
  it("returns null when headers is undefined", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("returns null when Retry-After is absent", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(parseRetryAfter(headers)).toBeNull();
  });

  it("parses integer seconds → milliseconds (AC3)", () => {
    const headers = new Headers({ "retry-after": "7" });
    expect(parseRetryAfter(headers)).toBe(7_000);
  });

  it("parses fractional seconds (RFC 9110 allows decimals in delay-seconds)", () => {
    const headers = new Headers({ "retry-after": "2.5" });
    expect(parseRetryAfter(headers)).toBe(2_500);
  });

  it("parses HTTP-date form (RFC 9110) into a positive delta from now", () => {
    // Build a date 30s in the future — assertion tolerates a small window
    // to avoid flake on slow CI.
    const futureMs = Date.now() + 30_000;
    const httpDate = new Date(futureMs).toUTCString();
    const headers = new Headers({ "retry-after": httpDate });
    const parsed = parseRetryAfter(headers);
    expect(parsed).not.toBeNull();
    expect(parsed).toBeGreaterThan(25_000);
    expect(parsed).toBeLessThanOrEqual(30_000);
  });

  it("returns null for a garbage Retry-After value (not seconds, not HTTP-date)", () => {
    const headers = new Headers({ "retry-after": "sometime-later" });
    expect(parseRetryAfter(headers)).toBeNull();
  });

  it("clamps negative HTTP-date deltas to 0 (past date == retry immediately)", () => {
    const pastMs = Date.now() - 60_000;
    const httpDate = new Date(pastMs).toUTCString();
    const headers = new Headers({ "retry-after": httpDate });
    const parsed = parseRetryAfter(headers);
    expect(parsed).not.toBeNull();
    expect(parsed).toBeGreaterThanOrEqual(0);
    expect(parsed).toBeLessThan(1_000);
  });

  it("also honours the non-standard `retry-after-ms` header (millisecond precision)", () => {
    // Some gateways (and the openai SDK itself) prefer this variant for
    // sub-second precision — respecting it costs nothing and matches SDK
    // behaviour a downstream operator may already rely on.
    const headers = new Headers({ "retry-after-ms": "1500" });
    expect(parseRetryAfter(headers)).toBe(1_500);
  });

  it("parses fractional seconds with trailing zero (e.g. '7.0')", () => {
    // Regression: an earlier round-trip stringification check
    // (`` `${parseFloat(raw)}` === raw ``) would reject "7.0" because
    // `parseFloat("7.0") → 7 → "7" !== "7.0"`. The regex-based check
    // recognises this as a legitimate delay-seconds value.
    const headers = new Headers({ "retry-after": "7.0" });
    expect(parseRetryAfter(headers)).toBe(7_000);
  });

  it("does NOT silently interpret an HTTP-date starting with a number as seconds", () => {
    // Regression guard: `parseFloat("21 Oct 2025 12:00:00 GMT")` returns
    // `21`, which without a strict-numeric check would silently be read as
    // "21 seconds" (a wildly wrong retry delay). The regex-first branch
    // rejects this string and the HTTP-date branch handles it correctly.
    const httpDate = new Date(Date.now() + 60_000).toUTCString();
    const headers = new Headers({ "retry-after": httpDate });
    const parsed = parseRetryAfter(headers);
    expect(parsed).not.toBeNull();
    // The parsed value is the delta from now (~60s), never the leading
    // integer of the date string.
    expect(parsed).toBeGreaterThan(50_000);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });
});

// ─── jitteredBackoff (AC4) ───────────────────────────────────────────────

describe("jitteredBackoff", () => {
  it("attempt=1 → base 1s (with 0.5 random → base * 2^0 * (0.8 + 0*0.4) with r=0.5 midpoint)", () => {
    // With random() = 0.5, the jitter multiplier is (0.8 + 0.5 * 0.4) = 1.0,
    // so the returned delay equals the un-jittered exponential value exactly.
    expect(jitteredBackoff(1, () => 0.5)).toBe(1_000);
  });

  it("attempt=2 → 2s at random midpoint (2^1 * 1000 * 1.0)", () => {
    expect(jitteredBackoff(2, () => 0.5)).toBe(2_000);
  });

  it("attempt=3 → 4s at random midpoint (2^2 * 1000 * 1.0)", () => {
    expect(jitteredBackoff(3, () => 0.5)).toBe(4_000);
  });

  it("caps at MAX_DELAY_MS = 30s even for very high attempt counts (AC4)", () => {
    // 2^10 * 1000 = 1_024_000 ms > 30 000 → clamped to 30 000
    expect(jitteredBackoff(10, () => 0.5)).toBe(30_000);
    expect(jitteredBackoff(20, () => 0.5)).toBe(30_000);
    // Upper edge of jitter on a capped value must still cap: 30_000 * 1.2 = 36_000 > 30_000
    expect(jitteredBackoff(10, () => 1)).toBe(30_000);
  });

  it("at random()=0, applies the -20% jitter floor", () => {
    // attempt=1: 1000 * 0.8 = 800
    expect(jitteredBackoff(1, () => 0)).toBe(800);
  });

  it("at random()=1, applies the +20% jitter ceiling (not clamped by cap for small attempts)", () => {
    // attempt=1: 1000 * 1.2 = 1200
    expect(jitteredBackoff(1, () => 1)).toBe(1_200);
    // attempt=2: 2000 * 1.2 = 2400
    expect(jitteredBackoff(2, () => 1)).toBe(2_400);
  });

  it("over 1000 invocations, every value falls in [base*0.8, base*1.2] (RFC §14.1 property)", () => {
    // Hand-rolled substitute for the RFC's fast-check property test.
    // With base = 1000 and JITTER_RATIO = 0.2, every sample must be in
    // [800, 1200], and the sample mean should sit close to 1000.
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      samples.push(jitteredBackoff(1));
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(800);
    expect(max).toBeLessThanOrEqual(1_200);
    // Mean should be within ~40ms of the midpoint over 1000 samples.
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(Math.abs(mean - 1_000)).toBeLessThan(40);
  });
});

// ─── withRetry — happy path and non-retryable errors ─────────────────────

describe("withRetry — success paths", () => {
  it("passes handler result through unchanged when the first attempt succeeds", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, model: "design-default" });
    const wrapped = withRetry(handler, {
      sleep: () => Promise.resolve(),
    });
    const result = await wrapped({ model: "design-default", messages: [] });
    expect(result).toEqual({ ok: true, model: "design-default" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("preserves handler input arguments exactly (no rewriting) across the wrapper", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    const input = { model: "design-best", messages: [{ role: "user", content: "hi" }] };
    await wrapped(input);
    expect(handler).toHaveBeenCalledWith(input);
  });

  it("never calls sleep on a first-attempt success", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = withRetry(handler, { sleep });
    await wrapped({});
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("withRetry — non-retryable errors (AC2)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("does NOT retry a BadRequestError (400) — surfaces original error immediately", async () => {
    // Import the openai SDK's real error class so `instanceof` in the
    // retry module discriminates it correctly.
    const openai = await import("openai");
    const err = new openai.BadRequestError(
      400,
      { error: { message: "bad body" } },
      "bad request",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an AuthenticationError (401)", async () => {
    const openai = await import("openai");
    const err = new openai.AuthenticationError(
      401,
      { error: { message: "bad key" } },
      "unauthorized",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a PermissionDeniedError (403)", async () => {
    const openai = await import("openai");
    const err = new openai.PermissionDeniedError(
      403,
      { error: { message: "forbidden" } },
      "forbidden",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a NotFoundError (404)", async () => {
    const openai = await import("openai");
    const err = new openai.NotFoundError(
      404,
      { error: { message: "no such model" } },
      "not found",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a ConflictError (409)", async () => {
    const openai = await import("openai");
    const err = new openai.ConflictError(
      409,
      { error: { message: "conflict" } },
      "conflict",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an UnprocessableEntityError (422 — schema validation surface)", async () => {
    const openai = await import("openai");
    const err = new openai.UnprocessableEntityError(
      422,
      { error: { message: "unprocessable" } },
      "unprocessable",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a plain Error (e.g. thrown ZodError from schema validation)", async () => {
    // Explicit non-openai error — a `ZodError` from downstream schema
    // validation must NOT be classified as a network/rate-limit failure and
    // therefore must not be retried (AC2: "do NOT retry on schema
    // validation failures").
    class ZodError extends Error {
      readonly issues: unknown[] = [];
      constructor(message: string) {
        super(message);
        this.name = "ZodError";
      }
    }
    const err = new ZodError("required field missing");
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ─── withRetry — retryable errors and exhaustion (AC2/AC5/AC6) ───────────

describe("withRetry — 429 rate limit (AC2, AC3, AC6)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("retries 429, honours Retry-After header seconds (AC3)", async () => {
    const openai = await import("openai");
    const rateErr = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "2" }),
    );
    const success = { ok: true };
    const handler = vi.fn().mockRejectedValueOnce(rateErr).mockResolvedValueOnce(success);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, { sleep });
    const result = await wrapped({});
    expect(result).toBe(success);
    expect(handler).toHaveBeenCalledTimes(2);
    // Retry-After said 2 seconds → sleep called once with 2000 ms.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("retries 429 without Retry-After → falls back to jittered exponential backoff (AC4)", async () => {
    const openai = await import("openai");
    const rateErr = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers(), // No Retry-After
    );
    const handler = vi.fn().mockRejectedValueOnce(rateErr).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    // random() = 0.5 → midpoint jitter → attempt=1 backoff is exactly 1000 ms.
    const wrapped = withRetry(handler, { sleep, random: () => 0.5 });
    await wrapped({});
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("on exhaustion after all 429 retries, throws RateLimitedError (AC6)", async () => {
    const openai = await import("openai");
    const rateErr = new openai.RateLimitError(
      429,
      { error: { message: "still rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "1" }),
    );
    const handler = vi.fn().mockRejectedValue(rateErr);
    const wrapped = withRetry(handler, {
      sleep: () => Promise.resolve(),
      maxRetries: 2, // → 3 attempts total (initial + 2 retries)
    });
    let caught: unknown;
    try {
      await wrapped({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    const rle = caught as InstanceType<typeof RateLimitedError>;
    expect(rle.attempts).toBe(3);
    expect(rle.cause).toBe(rateErr);
    expect(rle.retryAfterMs).toBe(1_000);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("uses max=3 by default → 4 total attempts before RateLimitedError (AC5)", async () => {
    const openai = await import("openai");
    const rateErr = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(rateErr);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve(), env: {} });
    await expect(wrapped({})).rejects.toBeInstanceOf(RateLimitedError);
    expect(handler).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});

describe("withRetry — 5xx transient (AC2, AC6)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("retries a 500 (InternalServerError) and succeeds on the second attempt", async () => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      500,
      { error: { message: "kaboom" } },
      "server error",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    const result = await wrapped({});
    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("retries a %d response", async (status) => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      status,
      { error: { message: "transient" } },
      "transient",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("on exhaustion after all 5xx retries, throws TransientError (AC6)", async () => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      503,
      { error: { message: "unavailable" } },
      "unavailable",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, {
      sleep: () => Promise.resolve(),
      maxRetries: 2, // → 3 attempts total
    });
    let caught: unknown;
    try {
      await wrapped({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    const te = caught as InstanceType<typeof TransientError>;
    expect(te.attempts).toBe(3);
    expect(te.cause).toBe(err);
    // A TransientError specifically must NOT masquerade as a RateLimitedError.
    expect(caught).not.toBeInstanceOf(RateLimitedError);
  });
});

describe("withRetry — network errors (AC2)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("retries an APIConnectionError wrapping ECONNRESET and succeeds on retry", async () => {
    // Reproduces the shape a real openai SDK connection reset surfaces as:
    // outer APIConnectionError → cause is TypeError('fetch failed') →
    // whose own cause is the underlying node error with .code = 'ECONNRESET'.
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const fetchWrap = new TypeError("fetch failed", { cause: rootCause });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: fetchWrap,
    });
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries an APIConnectionError wrapping ETIMEDOUT", async () => {
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchWrap = new TypeError("fetch failed", { cause: rootCause });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: fetchWrap,
    });
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries an APIConnectionTimeoutError (client-side timeout, no wire response)", async () => {
    const openai = await import("openai");
    const err = new openai.APIConnectionTimeoutError();
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("on exhaustion after network errors, throws TransientError (AC6)", async () => {
    const openai = await import("openai");
    const err = new openai.APIConnectionTimeoutError();
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, {
      sleep: () => Promise.resolve(),
      maxRetries: 1, // → 2 attempts total
    });
    let caught: unknown;
    try {
      await wrapped({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    const te = caught as InstanceType<typeof TransientError>;
    expect(te.attempts).toBe(2);
    expect(te.cause).toBe(err);
  });
});

describe("withRetry — permanent connection failures (AC2, Copilot review on PR #126)", () => {
  // `classifyError` narrows `APIConnectionError` with a DENYLIST
  // (`PERMANENT_CONNECTION_CODES`): retry by default, but stop immediately
  // for the two well-understood permanent cases below, because retrying
  // them just burns the whole budget on a call that will never succeed.
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("does NOT retry an APIConnectionError wrapping ECONNREFUSED — nothing is listening", async () => {
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const fetchWrap = new TypeError("fetch failed", { cause: rootCause });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: fetchWrap,
    });
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an APIConnectionError wrapping ENOTFOUND — DNS has no record", async () => {
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const fetchWrap = new TypeError("fetch failed", { cause: rootCause });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: fetchWrap,
    });
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await expect(wrapped({})).rejects.toBe(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still retries an APIConnectionError wrapping EAI_AGAIN (transient DNS failure, distinct from ENOTFOUND)", async () => {
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
      code: "EAI_AGAIN",
    });
    const fetchWrap = new TypeError("fetch failed", { cause: rootCause });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: fetchWrap,
    });
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("still retries an APIConnectionError with no discoverable cause code (safe default)", async () => {
    // No `.code` anywhere in the cause chain — e.g. a bare TLS handshake
    // rejection. Falls through to the safe "retry by default" behaviour
    // like any other unrecognised code, matching this module's original,
    // evidence-backed stance.
    const openai = await import("openai");
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: new Error("self-signed certificate"),
    });
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("on immediate ECONNREFUSED, does not sleep or log a retry line", async () => {
    const openai = await import("openai");
    const rootCause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const err = new openai.APIConnectionError({
      message: "Connection error.",
      cause: new TypeError("fetch failed", { cause: rootCause }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep });
    await expect(wrapped({})).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ─── Backoff scheduling (AC4) ────────────────────────────────────────────

describe("withRetry — backoff scheduling (AC4)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("uses exponential backoff (1s → 2s → 4s) at random midpoint for successive retries", async () => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      503,
      { error: { message: "still down" } },
      "server error",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, {
      sleep,
      random: () => 0.5, // midpoint jitter → exact exponential values
      maxRetries: 3,
    });
    await expect(wrapped({})).rejects.toBeInstanceOf(TransientError);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0]?.[0]).toBe(1_000);
    expect(sleep.mock.calls[1]?.[0]).toBe(2_000);
    expect(sleep.mock.calls[2]?.[0]).toBe(4_000);
  });

  it("caps individual backoff at MAX_DELAY_MS (30 s) even at high attempt counts", async () => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      503,
      { error: { message: "still down" } },
      "server error",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);
    // Force 6 retries — attempt 6 would be 2^5 * 1000 = 32 000 ms without the cap.
    const wrapped = withRetry(handler, { sleep, random: () => 0.5, maxRetries: 6 });
    await expect(wrapped({})).rejects.toBeInstanceOf(TransientError);
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });

  it("prefers Retry-After over the jitter schedule when the header is present", async () => {
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "5" }),
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, { sleep, random: () => 0.5 });
    await wrapped({});
    // 5s Retry-After beats the 1s jittered exponential value.
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("clamps an honoured Retry-After to MAX_RETRY_AFTER_MS instead of sleeping the full upstream value", async () => {
    // Regression guard (Copilot review, PR #126): a misconfigured or
    // hostile upstream sending e.g. `Retry-After: 86400` (one day) must not
    // stall the caller for that long — `MAX_DELAY_MS` only bounds our own
    // computed exponential backoff, so without a separate clamp on the
    // honoured-Retry-After path this sleep was unbounded.
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "86400" }), // 1 day, in seconds
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, { sleep, random: () => 0.5 });
    await wrapped({});
    expect(sleep).toHaveBeenCalledWith(MAX_RETRY_AFTER_MS);
  });

  it("does not clamp a Retry-After value already within MAX_RETRY_AFTER_MS", async () => {
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "45" }), // 45s — under the 60s ceiling.
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, { sleep, random: () => 0.5 });
    await wrapped({});
    expect(sleep).toHaveBeenCalledWith(45_000);
  });

  it("preserves the TRUE unclamped Retry-After on RateLimitedError.retryAfterMs even though the sleep was clamped", async () => {
    // The clamp only bounds what we actually sleep for — the exhaustion
    // error's `retryAfterMs` field still reports what the upstream asked
    // for verbatim, so a caller/UI can show the real wait time.
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "still rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "86400" }),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve(), maxRetries: 0 });
    let caught: unknown;
    try {
      await wrapped({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as InstanceType<typeof RateLimitedError>).retryAfterMs).toBe(86_400_000);
  });

  it("also clamps the retry-after-ms (millisecond precision) variant", async () => {
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after-ms": "120000" }), // 120s, well over the 60s ceiling.
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const wrapped = withRetry(handler, { sleep, random: () => 0.5 });
    await wrapped({});
    expect(sleep).toHaveBeenCalledWith(MAX_RETRY_AFTER_MS);
  });
});

// ─── Structured logging (AC7) ────────────────────────────────────────────

describe("withRetry — structured logging (AC7)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("emits one { event: 'llm.retry', attempt, status, retryAfter } line per retry (AC7)", async () => {
    const openai = await import("openai");
    const err = new openai.RateLimitError(
      429,
      { error: { message: "rate limited" } },
      "rate limited",
      new Headers({ "retry-after": "1" }),
    );
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});

    // Exactly one retry occurred → exactly one llm.retry line.
    const lines = stderrSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.includes('"llm.retry"'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!.trimEnd()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "llm.retry",
      attempt: 1,
      status: 429,
      retryAfter: 1_000,
    });
  });

  it("emits null status for a network error (no HTTP status available)", async () => {
    const openai = await import("openai");
    const err = new openai.APIConnectionTimeoutError();
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});

    const lines = stderrSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.includes('"llm.retry"'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!.trimEnd()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "llm.retry",
      attempt: 1,
      status: null,
    });
    expect(parsed["retryAfter"]).toBeNull();
  });

  it("increments the attempt counter across successive retries (attempt=1,2,3)", async () => {
    const openai = await import("openai");
    const err = new openai.InternalServerError(
      503,
      { error: { message: "still down" } },
      "server error",
      new Headers(),
    );
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRetry(handler, {
      sleep: () => Promise.resolve(),
      maxRetries: 3,
    });
    await expect(wrapped({})).rejects.toBeInstanceOf(TransientError);

    const attempts = stderrSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.includes('"llm.retry"'))
      .map((s) => (JSON.parse(s.trimEnd()) as { attempt: number }).attempt);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("never writes to stdout (stdio transport safety)", async () => {
    const openai = await import("openai");
    const err = new openai.APIConnectionTimeoutError();
    const handler = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(handler, { sleep: () => Promise.resolve() });
    await wrapped({});
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ─── End-to-end wire tests against a real stub server (integration) ──────

describe("withRetry — integration with createChatCompletion against a real stub", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("recovers from a 503 → 200 sequence and returns the completion (AC2, AC6)", async () => {
    let call = 0;
    const stub = await startStubServer(() => {
      call += 1;
      if (call === 1) {
        return { status: 503, body: { error: { message: "transient" } } };
      }
      return { status: 200, body: stubChatCompletion() };
    });
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-integration";
      const { createChatCompletion } = await import("./client.js");
      const { withRetry: freshWithRetry } = await import("./retry.js");
      const wrapped = freshWithRetry(createChatCompletion, {
        sleep: () => Promise.resolve(),
      });
      const result = await wrapped({
        model: "design-default",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.id).toBe("chatcmpl-retry-stub");
      expect(stub.requests).toHaveLength(2);
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("propagates a BadRequestError (400) without retrying (AC2)", async () => {
    const stub = await startStubServer(() => ({
      status: 400,
      body: { error: { message: "bad input" } },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-400";
      const { createChatCompletion } = await import("./client.js");
      const { withRetry: freshWithRetry } = await import("./retry.js");
      const wrapped = freshWithRetry(createChatCompletion, {
        sleep: () => Promise.resolve(),
      });
      await expect(
        wrapped({
          model: "design-default",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow();
      expect(stub.requests).toHaveLength(1);
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("recovers from a mid-flight socket destroy (ECONNRESET) (AC2)", async () => {
    // First attempt: mid-write socket destroy → APIConnectionError with a
    // buried ECONNRESET root cause. Second attempt: happy 200.
    let call = 0;
    const server: Server = createHttpServer((req, res) => {
      call += 1;
      if (call === 1) {
        // Destroy the socket before responding — simulates a peer reset.
        (req.socket as Socket).destroy(
          Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stubChatCompletion()));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = baseURL;
      process.env[API_KEY_ENV] = "sk-reset";
      const { createChatCompletion } = await import("./client.js");
      const { withRetry: freshWithRetry } = await import("./retry.js");
      const wrapped = freshWithRetry(createChatCompletion, {
        sleep: () => Promise.resolve(),
      });
      const result = await wrapped({
        model: "design-default",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.id).toBe("chatcmpl-retry-stub");
      expect(call).toBe(2);
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("exhausts retries against a persistently-429 stub and throws RateLimitedError (AC5, AC6)", async () => {
    const stub = await startStubServer(() => ({
      status: 429,
      body: { error: { message: "rate limited" } },
      headers: { "retry-after": "0" },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-persistent-429";
      const { createChatCompletion } = await import("./client.js");
      // After `vi.resetModules()`, this fresh `./retry.js` is a distinct
      // module instance from the bootstrap import at the top of this file
      // — its `RateLimitedError` class is therefore a distinct constructor,
      // and `instanceof` against the top-level `RateLimitedError` fails
      // even though the thrown value structurally IS a RateLimitedError.
      // Use the fresh-module class for both the type-checking cast and the
      // instanceof assertion.
      const { withRetry: freshWithRetry, RateLimitedError: FreshRateLimitedError } =
        await import("./retry.js");
      const wrapped = freshWithRetry(createChatCompletion, {
        sleep: () => Promise.resolve(),
        maxRetries: 2, // 3 attempts total
      });
      let caught: unknown;
      try {
        await wrapped({
          model: "design-default",
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FreshRateLimitedError);
      const rle = caught as InstanceType<typeof FreshRateLimitedError>;
      expect(rle.attempts).toBe(3);
      expect(stub.requests).toHaveLength(3);
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });
});
