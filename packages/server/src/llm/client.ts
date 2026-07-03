/**
 * LLM client wrapper (M2-01) — genie's single point of contact with the
 * operator's configured OpenAI-compatible chat-completions endpoint.
 *
 * Per D-H (`docs/plan/00-decisions.md`): genie calls a **configurable**
 * OpenAI-compatible endpoint. LiteLLM is the reference gateway, but Ollama /
 * OpenAI / vLLM / any compatible endpoint work the same way — no provider URL
 * or API key is ever hardcoded here. Both come from env vars
 * (`GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY`), validated at construction so a
 * misconfigured deployment fails fast (`MissingLLMConfigError`) rather than
 * failing confusingly deep inside a generation call.
 *
 * All future generation verbs (`conjure` / `refine`, M2-03/M2-04) call through
 * `createChatCompletion` rather than importing the `openai` SDK directly, so
 * this module is the one place that knows about env vars, timeouts, and
 * request logging for LLM calls.
 *
 * Out of scope (per the M2-01 issue): retry/backoff (M2-06) — `withRetry` in
 * a later issue wraps `createChatCompletion` itself — and structured-output
 * schema validation (M2-07).
 */

import OpenAI from "openai";

// ─── Env var names ───────────────────────────────────────────────────────────

/** Base URL of the operator's OpenAI-compatible endpoint. No default (AC3). */
export const GENIE_LLM_BASE_URL_ENV = "GENIE_LLM_BASE_URL";
/** API key/token for the configured endpoint. No default (AC3). */
export const GENIE_LLM_API_KEY_ENV = "GENIE_LLM_API_KEY";
/** Per-request timeout override, in milliseconds. */
export const GENIE_LLM_REQUEST_TIMEOUT_MS_ENV = "GENIE_LLM_REQUEST_TIMEOUT_MS";

/** Default request timeout: 120 000 ms (AC5). */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when one or both required LLM env vars are unset (AC2). Callers
 * should let this propagate at startup — there is no safe fallback endpoint
 * to construct a client against (AC3).
 */
export class MissingLLMConfigError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `Missing required LLM configuration: ${missing.join(", ")}. ` +
        `genie has no default LLM endpoint — set both ${GENIE_LLM_BASE_URL_ENV} ` +
        `and ${GENIE_LLM_API_KEY_ENV} to an operator-configured OpenAI-compatible ` +
        `endpoint before starting genie.`,
    );
    this.name = "MissingLLMConfigError";
  }
}

// ─── Config resolution ───────────────────────────────────────────────────────

/**
 * Resolve `GENIE_LLM_REQUEST_TIMEOUT_MS`, falling back to the 120s default
 * (AC5) when unset, blank, non-numeric, or non-positive. Mirrors the
 * established fallback shape of `getPlanTTL` in `plans/index.ts`.
 */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GENIE_LLM_REQUEST_TIMEOUT_MS_ENV];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

/**
 * Construct an `openai` SDK client from env vars (AC1). Throws
 * `MissingLLMConfigError` synchronously if `GENIE_LLM_BASE_URL` or
 * `GENIE_LLM_API_KEY` is unset or blank (AC2/AC3) — no default base URL is
 * ever substituted.
 *
 * Exported as a factory (in addition to the `llmClient` singleton below) so
 * tests can construct additional clients against a stub server, and so a
 * future preflight/health-check path can validate config without relying on
 * module-load side effects.
 */
export function createLLMClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const baseURL = env[GENIE_LLM_BASE_URL_ENV];
  const apiKey = env[GENIE_LLM_API_KEY_ENV];

  const missing: string[] = [];
  if (!baseURL) missing.push(GENIE_LLM_BASE_URL_ENV);
  if (!apiKey) missing.push(GENIE_LLM_API_KEY_ENV);
  if (missing.length > 0) throw new MissingLLMConfigError(missing);

  return new OpenAI({
    baseURL,
    apiKey,
    timeout: resolveTimeoutMs(env),
    // The `openai` SDK retries 429/5xx/408/409 internally by default
    // (maxRetries: 2) — invisibly to this module. M2-06 owns retry/backoff
    // for this wrapper (typed `RateLimitedError`/`TransientError`, honouring
    // `Retry-After`, a `GENIE_LLM_RETRY_MAX`-configurable cap, one log line
    // per attempt) and wraps `createChatCompletion` from the outside
    // (`withRetry(createChatCompletion)`). Leaving the SDK's own retries
    // enabled would silently double up on that policy — M2-06's "each
    // attempt logged" and "max N retries total" guarantees would both be
    // undermined by extra attempts happening a layer below where it can
    // neither see nor count them. So this client makes exactly one attempt;
    // all retry policy lives in one place (M2-06).
    maxRetries: 0,
  });
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/**
 * The shared `openai` client every generation verb calls through (AC1).
 * Constructed once at module load from env vars — a deployment missing
 * `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` fails the moment anything imports
 * this module, rather than partway through a generation request.
 */
export const llmClient: OpenAI = createLLMClient();

// ─── createChatCompletion ────────────────────────────────────────────────────

/** Input accepted by {@link createChatCompletion} — a non-streaming chat-completion request. */
export type ChatCompletionInput = OpenAI.ChatCompletionCreateParamsNonStreaming;
/** Result returned by {@link createChatCompletion}. */
export type ChatCompletionResult = OpenAI.ChatCompletion;

/**
 * Thin wrapper around `llmClient.chat.completions.create` (AC4). Emits a
 * structured `{ model, promptTokens, completionTokens, latencyMs }` log line
 * to **stderr** on success — never stdout, which on the stdio transport *is*
 * the JSON-RPC protocol stream (see `transport.ts` / `tools/plan.ts`'s audit
 * log for the same convention).
 *
 * Does not retry and does not swallow errors: a rejected `create()` call
 * propagates to the caller untouched so M2-06's `withRetry(createChatCompletion)`
 * can wrap this function directly.
 */
export async function createChatCompletion(
  input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
  const startedAt = performance.now();
  const completion = await llmClient.chat.completions.create(input);
  const latencyMs = Math.round(performance.now() - startedAt);

  process.stderr.write(
    JSON.stringify({
      event: "llm.chat_completion",
      model: completion.model,
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      latencyMs,
    }) + "\n",
  );

  return completion;
}
