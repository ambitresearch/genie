/**
 * MCP tool: conjure (M2-03 · DRO-250) — genie's headline verb.
 *
 * Takes a natural-language prompt (plus an optional reference image / page) and
 * returns a single UI component as the file set defined by `COMPONENT_SCHEMA`
 * (M2-02). This is the real generation path: it calls the operator's configured
 * OpenAI-compatible endpoint through the M2-01 client, demanding structured
 * output via `response_format: { type: "json_schema", … }`, validates the reply
 * against `COMPONENT_SCHEMA` with Ajv, and retries once with the validation
 * error fed back on failure.
 *
 * Two DISTINCT retry mechanisms are in play here, at different layers — don't
 * conflate them when reading this file:
 *   1. The "retries once on validation failure" above is `component-response.ts`'s
 *      schema-repair loop (AC8): a structurally-valid-but-wrong-shape reply
 *      gets one more attempt with the Ajv error fed back into the prompt.
 *   2. Each of those (up to 2) calls individually goes through M2-06's
 *      `withRetry(createChatCompletion)` (DRO-253) for transient network/429/5xx
 *      failures — invisible to this file, applied inside
 *      `component-response.ts`'s shared `defaultChatCompletion` (below the
 *      `chat` seam this file falls back to when `deps.chat` is omitted).
 *
 * `conjure` is deliberately **pure generation** (AC9): it never calls
 * `write_files`. It hands the caller a validated component; committing it to a
 * kit is a separate, plan-gated step the caller owns. That keeps generation
 * free of side effects and testable without a store.
 *
 * ── Import-time safety ────────────────────────────────────────────────────────
 * `../llm/client.js` constructs its `llmClient` singleton eagerly at module load
 * and throws `MissingLLMConfigError` when `GENIE_LLM_*` env vars are unset (M2-01
 * AC1/AC2). If this module imported it *statically*, merely building the server
 * (`createServer()`) — which CI does with no LLM endpoint configured — would
 * throw. So the client is a **type-only** import here (erased by
 * `verbatimModuleSyntax`); the default runtime path reaches it via
 * `component-response.ts`'s shared `defaultChatCompletion`, whose own lazy
 * `await import(...)` is touched only when an actual `conjure` call runs. Tests
 * inject their own `chat` and never load the client.
 *
 * §6 honest uncertainty (from the issue): the exact prompt shape / generation
 * loop is unspecified R&D. The system prompt (`prompts/generate-component.system.md`,
 * versioned by git-blob hash, AC5) is where that iteration lives; this file is the
 * stable request/validate/retry harness around it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type ValidatedComponent } from "../llm/schema.js";
import {
  GENERATE_COMPONENT_SYSTEM_PROMPT_FILE,
  loadPrompt,
  type LoadedPrompt,
} from "../llm/prompts.js";
// Type-only (erased at build): importing the *values* from client.js would
// trip its eager MissingLLMConfigError singleton at server-build time (see
// module header). The default chat impl reaches these lazily via dynamic import.
import type { ChatCompletionInput } from "../llm/client.js";
// The shared request/validate/retry harness (M2-03/M2-04). The Ajv compile,
// fence-stripper, response_format envelope, retry-feedback wording, the
// two-attempt loop, AND the retry-wrapped production `chat` default (M2-06,
// DRO-253) all live here so `conjure` and `refine` share ONE copy — see
// llm/component-response.ts's header.
import {
  type ChatCompletionFn,
  type RetryContext,
  type UsageInfo,
  appendRetryFeedback,
  defaultChatCompletion,
  logStderr,
  runComponentGeneration,
} from "../llm/component-response.js";
import { KIT_ID_PATTERN } from "./get_kit.js";

// Re-exported so existing importers (and conjure.test.ts) keep resolving these
// through `conjure.js` after the harness extraction — the symbols moved, the
// public entry point did not.
export type { ChatCompletionFn, UsageInfo } from "../llm/component-response.js";

export const CONJURE_TOOL_NAME = "mcp__genie__conjure";

/** Target framework for the generated component (AC2/AC3). */
export const CONJURE_FRAMEWORKS = ["react", "vue", "html"] as const;
export type ConjureFramework = (typeof CONJURE_FRAMEWORKS)[number];

/** Default framework + model routing alias (AC3). `design-default` is resolved
 * to a concrete provider model by the configured endpoint/gateway (M2-05). */
export const DEFAULT_FRAMEWORK: ConjureFramework = "react";
export const DEFAULT_MODEL = "design-default";

/** `refUrl` bodies larger than this are warned about (AC7) and truncated before
 * inlining, so a giant page can't blow the request's token budget. */
export const REF_URL_WARN_BYTES = 1024 * 1024; // 1 MB

/**
 * SSRF guard for `refUrl` (Copilot review): `conjure` fetches this URL
 * server-side, so an unrestricted URL is a server-side request forgery / local
 * file exfiltration vector in any non-local deployment. Allow only `http`/`https`
 * and reject hosts that resolve to the loopback / link-local / private ranges or
 * obvious internal names. This is a syntactic pre-filter (a determined attacker
 * can still hide a private IP behind DNS) — defense in depth, not a complete
 * SSRF solution — but it closes the trivial `file:`, `ftp:`, `http://localhost`,
 * and `http://169.254.169.254/…` (cloud metadata) holes at the tool boundary.
 * Exported so a future network-egress policy can reuse the exact same rule.
 */
export function isSafeRefUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  // Named internal hosts.
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost")) return false;
  if (host === "" || host === "[::1]" || host === "::1") return false;

  // IPv4 literal → block loopback/private/link-local/CGNAT ranges.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return false; // loopback / private / this-host
    if (a === 169 && b === 254) return false; // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  }
  // Bare IPv6 loopback/link-local/unique-local.
  if (host.startsWith("[")) {
    const inner = host.replace(/^\[|\]$/g, "");
    if (
      inner === "::1" ||
      inner.startsWith("fe80:") ||
      inner.startsWith("fc") ||
      inner.startsWith("fd")
    )
      return false;
  }
  return true;
}

/** Reusable Zod schema for `refUrl`: a bounded http(s) URL that passes the SSRF
 * guard. Shared by `conjureArgsSchema` and the MCP tool `inputSchema` so the
 * declared tool contract and runtime validation cannot drift (Copilot review). */
const refUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(isSafeRefUrl, {
    message:
      "refUrl must be an http(s) URL to a public host — file:/ftp:/data: schemes and " +
      "localhost/private/link-local addresses are rejected (SSRF guard).",
  });

// ── Input schema (AC2) ────────────────────────────────────────────────────────
//
// { kitId, kit, prompt, group?, refImageDataUrl?, refUrl?, framework?, model? }.
// `kit` is the kit *description* the model matches against (tokens, primitives,
// house style) — a free-form string, generously bounded. `refImageDataUrl` must
// be an actual `data:` URL (AC6 attaches it as a vision input); a bare http URL
// belongs in `refUrl` (AC7) instead.
//
// Defined as ONE field map reused by both `conjureArgsSchema` (runtime parse)
// and the MCP tool `inputSchema` (declared contract), so the two can never drift
// (Copilot review: keep the tool-boundary schema aligned with runtime validation).
const conjureInputShape = {
  kitId: z
    .string()
    .regex(
      KIT_ID_PATTERN,
      "kitId must be a 3-64 character slug of lowercase letters, numbers, and hyphens.",
    ),
  kit: z.string().min(1).max(100_000),
  prompt: z.string().min(3).max(8192),
  group: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/, "group must be kebab-case: 1-32 chars of [a-z0-9-].")
    .optional(),
  refImageDataUrl: z
    .string()
    .max(8_000_000)
    .regex(/^data:/, "refImageDataUrl must be a data: URL; use refUrl for an http(s) reference.")
    .optional(),
  refUrl: refUrlSchema.optional(),
  framework: z.enum(CONJURE_FRAMEWORKS).default(DEFAULT_FRAMEWORK),
  model: z.string().min(1).max(128).default(DEFAULT_MODEL),
} as const;

const conjureArgsSchema = z.object(conjureInputShape).strict();

export type ConjureArgs = z.infer<typeof conjureArgsSchema>;

/**
 * What `conjure` returns (AC9): the validated component — its name, resolved
 * group, file set, and manifest metadata — plus token `usage` for the caller's
 * accounting. Deliberately does NOT include anything about having *written* the
 * files: generation is pure (AC9).
 */
export interface ConjureResult extends Record<string, unknown> {
  componentName: string;
  group: string;
  files: ValidatedComponent["files"];
  manifestEntry: ValidatedComponent["manifestEntry"];
  usage: UsageInfo;
}

/** The URL-fetch seam (AC7). Defaults to the global `fetch`; injectable for tests. */
export type FetchFn = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ConjureDeps {
  chat?: ChatCompletionFn;
  fetchImpl?: FetchFn;
  /** Prompt loader override (tests). Defaults to the real versioned loader (AC5). */
  loadSystemPrompt?: () => LoadedPrompt;
}

/** Typed failure surfaced to the tool boundary (mapped to an MCP error result).
 * One code: an empty reply is just one way output can be invalid, so it folds
 * into `ERR_LLM_OUTPUT_INVALID` rather than being its own code (Copilot review —
 * keep the public error surface to codes this file actually throws). */
export class ConjureError extends Error {
  constructor(
    readonly code: "ERR_LLM_OUTPUT_INVALID",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConjureError";
  }
}

// ── Reference handling ────────────────────────────────────────────────────────

/**
 * Truncate `text` so its UTF-8 encoding is at most `maxBytes` bytes, cutting on
 * a codepoint boundary (Copilot review: `String.slice` cuts UTF-16 code units,
 * so a non-ASCII page could still blow the byte cap). We encode, slice the byte
 * buffer at the cap, then drop any trailing bytes that form a partial multi-byte
 * sequence so the decoded result carries no U+FFFD replacement char and is
 * guaranteed ≤ `maxBytes`.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // A UTF-8 continuation byte matches 0b10xxxxxx (0x80–0xBF); back up off any
  // partial sequence at the cut so we never split a codepoint.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Fetch `refUrl` and return its body for inlining (AC7). Warns (does not throw)
 * when the body exceeds 1 MB and truncates it, so a huge page degrades to a
 * bounded excerpt rather than a runaway request. A network/HTTP failure is
 * warned and skipped — generation proceeds without the reference rather than
 * dying on a flaky link.
 */
async function fetchReference(fetchImpl: FetchFn, refUrl: string): Promise<string | undefined> {
  try {
    const res = await fetchImpl(refUrl);
    if (!res.ok) {
      logStderr({ event: "conjure.ref_url.skip", refUrl, status: res.status });
      return undefined;
    }
    const body = await res.text();
    const bytes = Buffer.byteLength(body, "utf-8");
    if (bytes > REF_URL_WARN_BYTES) {
      logStderr({ event: "conjure.ref_url.oversize", refUrl, bytes, capBytes: REF_URL_WARN_BYTES });
      return (
        truncateUtf8(body, REF_URL_WARN_BYTES) + "\n<!-- …reference truncated by genie (>1 MB) -->"
      );
    }
    return body;
  } catch (err) {
    logStderr({ event: "conjure.ref_url.error", refUrl, error: String(err) });
    return undefined;
  }
}

// ── Prompt / message assembly ─────────────────────────────────────────────────

/** Build the natural-language user instruction block (everything except the
 * optional vision image, which is attached as a separate content part). */
function buildUserText(args: ConjureArgs, referenceHtml: string | undefined): string {
  const lines = [
    `Target framework: ${args.framework}`,
    args.group
      ? `Kit category (group): ${args.group}`
      : `Kit category (group): (choose the best fit)`,
    "",
    "## UI kit",
    args.kit,
    "",
    "## Component to build",
    args.prompt,
  ];
  if (args.refImageDataUrl) {
    lines.push(
      "",
      "## Reference image",
      "A reference image is attached — match its visual intent.",
    );
  }
  if (referenceHtml !== undefined) {
    lines.push("", `## Reference page (fetched from ${args.refUrl})`, referenceHtml);
  }
  return lines.join("\n");
}

/**
 * Assemble the messages for one attempt. The system prompt is always message 0
 * (AC5). The user message carries the instruction text; if `refImageDataUrl` is
 * set it becomes a content-parts array with a vision `image_url` part alongside
 * the text (AC6 — the real OpenAI/Anthropic vision shape; the AC's
 * `[{type:"image", …}]` sketch is the intent). `retryReason`, when present,
 * appends the prior validation failure so the model can self-correct (AC8).
 */
function buildMessages(
  systemPrompt: string,
  args: ConjureArgs,
  referenceHtml: string | undefined,
  retry: RetryContext | undefined,
): ChatCompletionInput["messages"] {
  let userText = buildUserText(args, referenceHtml);
  if (retry) {
    userText = appendRetryFeedback(userText, retry);
  }

  const userContent: ChatCompletionInput["messages"][number]["content"] = args.refImageDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: args.refImageDataUrl } },
      ]
    : userText;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

const defaultFetch: FetchFn = (url) => fetch(url);

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Generate one component. Pure (AC9): validates + returns, never writes.
 *
 * Flow: resolve args → optionally fetch `refUrl` (AC7) → run the shared
 * request/validate/retry loop (build messages +vision AC6, call the endpoint
 * with the json_schema response_format AC4, validate against COMPONENT_SCHEMA
 * AC8, retry ONCE on failure) → return
 * `{ componentName, group, files, manifestEntry, usage }` (AC9) and log a
 * per-call line (AC10). The loop itself lives in `component-response.ts`, shared
 * with `refine` (M2-04).
 */
export async function conjure(deps: ConjureDeps, args: unknown): Promise<ConjureResult> {
  const parsed = conjureArgsSchema.parse(args);
  const chat = deps.chat ?? defaultChatCompletion;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const systemPrompt = (
    deps.loadSystemPrompt ?? (() => loadPrompt(GENERATE_COMPONENT_SYSTEM_PROMPT_FILE))
  )();

  const startedAt = performance.now();

  const referenceHtml = parsed.refUrl ? await fetchReference(fetchImpl, parsed.refUrl) : undefined;

  const { outcome, usage, attempts } = await runComponentGeneration({
    chat,
    model: parsed.model,
    buildMessages: (retry) => buildMessages(systemPrompt.text, parsed, referenceHtml, retry),
  });

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!outcome.ok) {
    // Per-call log even on failure — keeps AC10's accounting honest.
    logStderr({
      event: "conjure",
      ok: false,
      model: parsed.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs,
      componentName: null,
      promptVersion: systemPrompt.version,
      attempts,
    });
    throw new ConjureError(
      "ERR_LLM_OUTPUT_INVALID",
      `The model did not return a schema-valid component after ${attempts} attempt(s). ` +
        `Last validation error:\n${outcome.reason}`,
      { attempts, reason: outcome.reason },
    );
  }

  const component = outcome.component;

  // AC10 — per-call structured log, including componentName + prompt version.
  logStderr({
    event: "conjure",
    ok: true,
    model: parsed.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs,
    componentName: component.componentName,
    promptVersion: systemPrompt.version,
    attempts,
  });

  return {
    componentName: component.componentName,
    group: component.group,
    files: component.files,
    manifestEntry: component.manifestEntry,
    usage,
  };
}

// ── MCP registration ──────────────────────────────────────────────────────────

const conjureOutputShape = {
  componentName: z.string(),
  group: z.string(),
  files: z.array(
    z.object({ path: z.string(), content: z.string(), mimeType: z.string() }).strict(),
  ),
  manifestEntry: z
    .object({
      viewport: z.object({ width: z.number(), height: z.number() }).strict(),
      subtitle: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .strict(),
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .strict(),
};

export function registerConjureTool(server: McpServer, deps: ConjureDeps = {}): void {
  server.registerTool(
    CONJURE_TOOL_NAME,
    {
      title: "Conjure component",
      description:
        "Generate a single UI component against your UI kit from a natural-language prompt " +
        "(with an optional reference image or page). Returns the COMPONENT_SCHEMA file set — " +
        "{ componentName, group, files, manifestEntry } — validated against the schema (retried " +
        "once on a validation failure). Pure generation: it does NOT write the files; committing " +
        "them to a kit is the caller's separate, plan-gated step.",
      // Reuse the exact same field map the runtime parser uses (incl. the
      // SSRF-guarded refUrl) — no second, drift-prone copy (Copilot review).
      inputSchema: conjureInputShape,
      outputSchema: conjureOutputShape,
    },
    async (args) => {
      try {
        const result = await conjure(deps, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ConjureError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
                  ...(error.details ? { details: error.details } : {}),
                }),
              },
            ],
          };
        }
        throw error;
      }
    },
  );
}
