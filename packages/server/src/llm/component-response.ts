/**
 * Shared component-generation response harness (M2-03/M2-04).
 *
 * `conjure` (M2-03 · DRO-250) and `refine` (M2-04 · DRO-251) are the same
 * request/validate/retry machine wrapped around two different prompts:
 *   - build the messages,
 *   - demand structured output via `response_format: { type: "json_schema", … }`,
 *   - parse + validate the reply against `COMPONENT_SCHEMA` (M2-02) with Ajv,
 *   - retry EXACTLY ONCE with the validation error + prior output fed back.
 *
 * That machinery lived inline in `conjure.ts`; M2-04's AC6 is literally "same
 * retry-once pattern as M2-03", so rather than clone a second (drift-prone) copy
 * of the Ajv compile, the fence-stripper, the retry-feedback wording, and the
 * two-attempt loop, both verbs import them from here. `refine` reusing this file
 * is what makes "same pattern" a fact of the code, not a hope about two parallel
 * implementations staying in step.
 *
 * What stays tool-side: each verb owns its own **`buildMessages`** (the prompt is
 * the whole point of the difference between the two verbs) and its own per-call
 * structured log + typed error (their AC10/AC8 field sets differ). This module
 * owns everything between "here are the messages" and "here is a validated
 * component or a reason it failed".
 */
// Named `Ajv` import (not default): ajv@8 is CJS (`module.exports = Ajv` +
// `module.exports.Ajv = Ajv`) with a `.d.ts` `export declare class Ajv`. Under
// this repo's `verbatimModuleSyntax` + NodeNext, the *default* import resolves
// to the module namespace object (TS2351 "not constructable"); the *named* `Ajv`
// is both a constructable typed class and a cjs-module-lexer-detectable runtime
// export, so it typechecks under `tsc` and runs under both vite (tests) and node
// (compiled dist). (Carried verbatim from conjure.ts when this harness was
// extracted — same reasoning, one copy.)
import { Ajv, type ValidateFunction, type ErrorObject } from "ajv";

import { COMPONENT_SCHEMA, type ValidatedComponent } from "./schema.js";
// Type-only (erased at build): importing the *values* from client.js would trip
// its eager MissingLLMConfigError singleton at server-build time. The tools'
// default chat impls reach the client lazily via dynamic import.
import type { ChatCompletionInput, ChatCompletionResult } from "./client.js";

/** Token/cost accounting summed across the (up to two) model calls. */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A fresh zeroed usage accumulator. */
export function emptyUsage(): UsageInfo {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Add one completion's token counts into a running {@link UsageInfo}. */
export function addUsage(into: UsageInfo, completion: ChatCompletionResult): void {
  into.promptTokens += completion.usage?.prompt_tokens ?? 0;
  into.completionTokens += completion.usage?.completion_tokens ?? 0;
  into.totalTokens += completion.usage?.total_tokens ?? 0;
}

/** The chat-completion seam. Production supplies a lazy wrapper over the M2-01
 * `createChatCompletion`; tests inject a stub so no real endpoint or
 * `GENIE_LLM_*` env is needed. Shared by both generation verbs. */
export type ChatCompletionFn = (input: ChatCompletionInput) => Promise<ChatCompletionResult>;

/** Structured warn/telemetry to stderr — never stdout (the stdio transport's
 * stdout IS the JSON-RPC stream; same convention as client.ts / plan.ts). */
export function logStderr(payload: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(payload) + "\n");
}

// ── Structured-output validation ──────────────────────────────────────────────
//
// Compile the validator once against COMPONENT_SCHEMA with the SAME Ajv
// configuration the schema's own tests and M2-07's `validateComponent` use —
// `{ strict: true, allErrors: true }`. `strict: true` surfaces schema-keyword
// mistakes at compile time; `allErrors` lets a retry prompt name *every* problem
// rather than only the first.
const ajv = new Ajv({ strict: true, allErrors: true });
const validateComponent: ValidateFunction<ValidatedComponent> =
  ajv.compile<ValidatedComponent>(COMPONENT_SCHEMA);

/** Render Ajv errors as a compact, model-readable bullet list for the retry. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "(no detail)";
  return errors
    .map((e) => `- ${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
    .join("\n");
}

/**
 * Some endpoints wrap JSON in a ```json fence despite `response_format`. Strip a
 * single leading/trailing fence defensively before parsing so a cosmetically
 * fenced-but-valid reply doesn't cost a retry.
 */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const m = fence.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

/** Outcome of parsing + schema-validating one model reply. */
export type ParseResult =
  | { ok: true; component: ValidatedComponent }
  | { ok: false; reason: string };

/** Parse + schema-validate one model reply. Returns the component or a reason. */
export function parseAndValidate(raw: string | null | undefined): ParseResult {
  if (!raw || raw.trim() === "") {
    return { ok: false, reason: "The response was empty — return a JSON object." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (err) {
    return { ok: false, reason: `The response was not valid JSON (${String(err)}).` };
  }
  if (validateComponent(parsed)) {
    return { ok: true, component: parsed };
  }
  return { ok: false, reason: formatAjvErrors(validateComponent.errors) };
}

/**
 * The `response_format` demanded on every generation call. Wraps
 * COMPONENT_SCHEMA in the OpenAI structured-output envelope
 * `{ name, description, schema }` — the real wire shape a compliant endpoint
 * (and LiteLLM's passthrough) expects.
 */
export function buildComponentResponseFormat(): ChatCompletionInput["response_format"] {
  return {
    type: "json_schema",
    json_schema: {
      name: "GenieComponent",
      description: COMPONENT_SCHEMA.description,
      schema: COMPONENT_SCHEMA as unknown as Record<string, unknown>,
    },
  };
}

// ── Retry feedback ────────────────────────────────────────────────────────────

/** Context appended to a user message on the ONE retry: the validation error and
 * the model's prior (invalid) output, so it can self-correct (M2-03 AC8). */
export interface RetryContext {
  reason: string;
  previous: string;
}

/**
 * Append the shared retry-feedback block to a user instruction. Same wording for
 * both verbs so the model sees a consistent "you failed validation, fix exactly
 * this" contract regardless of which verb it is answering. Kept as a function
 * (not a template inlined per tool) so the wording — which the M2-03 tests pin
 * (`"failed schema validation"`, `"previous"`) — lives in exactly one place.
 */
export function appendRetryFeedback(userText: string, retry: RetryContext): string {
  return (
    userText +
    "\n\n## Your previous attempt failed schema validation\n" +
    "Fix exactly these problems and return corrected JSON — nothing else:\n" +
    retry.reason +
    "\n\n### Your previous (invalid) output\n" +
    retry.previous
  );
}

// ── The two-attempt generation loop ───────────────────────────────────────────

/** Builds the messages for one attempt. `retry` is `undefined` on the first
 * attempt and carries the validation feedback on the (single) retry. */
export type BuildMessagesFn = (retry: RetryContext | undefined) => ChatCompletionInput["messages"];
export type ValidateGeneratedComponent = (component: ValidatedComponent) => string | undefined;

/** Result of {@link runComponentGeneration}: the parse outcome plus the accounting
 * a caller needs for its per-call log (attempts + summed usage). */
export interface GenerationRun {
  outcome: ParseResult;
  usage: UsageInfo;
  /** 1 if the first reply validated, 2 if it took the retry. */
  attempts: number;
}

/**
 * Run the shared generation loop: one attempt, and — only if it fails schema
 * validation — exactly one retry with the error + prior output fed back
 * (M2-03 AC8 / M2-04 AC6). `buildMessages` is the sole per-verb input, so
 * `conjure` and `refine` share this identical control flow while each keeps its
 * own prompt. Usage is summed across both attempts; `attempts` reports whether
 * the retry fired. The caller decides what to do with a still-invalid
 * `outcome` (throw its own typed error) and logs its own per-call line.
 */
export async function runComponentGeneration(params: {
  chat: ChatCompletionFn;
  model: string;
  buildMessages: BuildMessagesFn;
  /** Optional tool-specific validation applied after the shared JSON schema. */
  validateGeneratedComponent?: ValidateGeneratedComponent;
}): Promise<GenerationRun> {
  const { chat, model, buildMessages, validateGeneratedComponent } = params;
  const usage = emptyUsage();
  const responseFormat = buildComponentResponseFormat();

  // Attempt 1.
  const first = await chat({
    model,
    messages: buildMessages(undefined),
    response_format: responseFormat,
  });
  addUsage(usage, first);
  const firstRaw = first.choices[0]?.message?.content ?? null;
  let outcome = applyGeneratedComponentValidation(
    parseAndValidate(firstRaw),
    validateGeneratedComponent,
  );
  let attempts = 1;

  // Attempt 2 (retry once) — feed the validation error + prior output back.
  if (!outcome.ok) {
    const second = await chat({
      model,
      messages: buildMessages({ reason: outcome.reason, previous: firstRaw ?? "(empty)" }),
      response_format: responseFormat,
    });
    addUsage(usage, second);
    attempts = 2;
    outcome = applyGeneratedComponentValidation(
      parseAndValidate(second.choices[0]?.message?.content ?? null),
      validateGeneratedComponent,
    );
  }

  return { outcome, usage, attempts };
}

function applyGeneratedComponentValidation(
  outcome: ParseResult,
  validateGeneratedComponent: ValidateGeneratedComponent | undefined,
): ParseResult {
  if (!outcome.ok || validateGeneratedComponent === undefined) return outcome;
  const reason = validateGeneratedComponent(outcome.component);
  return reason === undefined ? outcome : { ok: false, reason };
}
