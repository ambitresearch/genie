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
 * `conjure` is deliberately **pure generation** (AC9): it never calls
 * `write_files`. It hands the caller a validated component; committing it to a
 * kit is a separate, plan-gated step the caller owns. That keeps generation
 * free of side effects and testable without a store.
 *
 * Two DISTINCT retry mechanisms are in play here, at different layers — don't
 * conflate them when reading this file:
 *   1. The "retries once on validation failure" above is the shared
 *      `component-response.ts` harness's schema-repair loop (AC8): a
 *      structurally-valid-but-wrong-shape reply gets one more attempt with the
 *      Ajv error fed back into the prompt.
 *   2. Each of those (up to 2) calls individually goes through M2-06's
 *      `withRetry(createChatCompletion)` (DRO-253, see `defaultChatCompletion`
 *      below) for transient network/429/5xx failures — invisible to this
 *      file's own logic and to the shared harness, handled entirely inside the
 *      `chat` seam.
 *
 * ── Import-time safety ────────────────────────────────────────────────────────
 * `../llm/client.js` constructs its `llmClient` singleton eagerly at module load
 * and throws `MissingLLMConfigError` when `GENIE_LLM_*` env vars are unset (M2-01
 * AC1/AC2). If this module imported it *statically*, merely building the server
 * (`createServer()`) — which CI does with no LLM endpoint configured — would
 * throw. So the client is a **type-only** import here (erased by
 * `verbatimModuleSyntax`), and the default runtime path reaches it via a lazy
 * `await import(...)` inside `defaultChatCompletion`, touched only when an actual
 * `conjure` call runs. Tests inject their own `chat` and never load the client.
 * (`../llm/retry.js`'s `withRetry`, by contrast, has no such eager side effect —
 * it's a plain higher-order function — so it's imported statically below and
 * applied inside that same lazy seam.)
 *
 * §6 honest uncertainty (from the issue): the exact prompt shape / generation
 * loop is unspecified R&D. The system prompt (`prompts/generate-component.system.md`,
 * versioned by git-blob hash, AC5) is where that iteration lives; this file is the
 * stable request/validate/retry harness around it.
 */
import { lookup as dnsLookup } from "node:dns/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
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
// fence-stripper, response_format envelope, retry-feedback wording, and the
// two-attempt loop all live here so `conjure` and `refine` share ONE copy —
// see llm/component-response.ts's header.
import {
  type ChatCompletionFn,
  type RetryContext,
  type UsageInfo,
  appendRetryFeedback,
  logStderr,
  runComponentGeneration,
} from "../llm/component-response.js";
// Value import (not type-only): `retry.ts` has no import-time side effects —
// unlike `client.ts`, it never touches `GENIE_LLM_*` env or constructs
// anything eagerly at module load — so wrapping `defaultChatCompletion`
// below in `withRetry` is safe to do statically (Copilot review on PR #126 /
// DRO-253: this file's docstring claimed conjure "calls the endpoint through
// the M2-01 client" via `withRetry(createChatCompletion)`, but no production
// call site actually applied the wrapper — every future generation verb
// would have silently needed to remember to wrap it manually).
import { withRetry } from "../llm/retry.js";
import {
  normalizeGeneratedFiles,
  validateGeneratedBinaryContent,
  type GeneratedFileWithEncoding,
} from "../llm/generated-files.js";
// Framework adapter seam (M2-08 · DRO-255). `conjure` picks the adapter from its
// `framework` input (AC4) and reads the adapter's `promptDirective` — the one
// framework-specific bit generation carries. `interface.js` has no heavy imports
// at module top (esbuild/ts-morph load lazily inside the React adapter, reached
// only via `getAdapter`'s dynamic import), so this static import is server-build
// safe. The framework enum + default live in the adapter module as the single
// source of truth; `conjure` re-exports them under their established names.
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK as ADAPTER_DEFAULT_FRAMEWORK,
  getAdapter,
  type Framework,
} from "../framework/interface.js";
import { KIT_ID_PATTERN } from "./get_kit.js";

// Re-exported so existing importers (and conjure.test.ts) keep resolving these
// through `conjure.js` after the harness extraction — the symbols moved, the
// public entry point did not.
export type { ChatCompletionFn, UsageInfo } from "../llm/component-response.js";

export const CONJURE_TOOL_NAME = "mcp__genie__conjure";

/** Target framework for the generated component (AC2/AC3). Re-exported from the
 * M2-08 adapter module so the tool contract and the adapter registry share one
 * source of truth (`framework/interface.ts#FRAMEWORKS`). */
export const CONJURE_FRAMEWORKS = FRAMEWORKS;
export type ConjureFramework = Framework;

/** Default framework + model routing alias (AC3). `design-default` is resolved
 * to a concrete provider model by the configured endpoint/gateway (M2-05). */
export const DEFAULT_FRAMEWORK: ConjureFramework = ADAPTER_DEFAULT_FRAMEWORK;
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
type SafeAddress = { address: string; family: 4 | 6 };
export type AddressLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

const defaultAddressLookup: AddressLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function parseIpLiteral(host: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const unbracketed = host.startsWith("[") ? host.replace(/^\[|\]$/g, "") : host;
  try {
    return ipaddr.process(unbracketed);
  } catch {
    return undefined;
  }
}

/** Return a canonical address only for globally routable unicast IPs. Using a
 * real IP parser avoids textual-prefix gaps such as IPv4-mapped loopback
 * (`::ffff:127.0.0.1`), the full IPv6 link-local `/10`, and multicast or
 * unspecified addresses. */
function asSafeAddress(host: string): SafeAddress | undefined {
  const parsed = parseIpLiteral(host);
  if (parsed === undefined || parsed.range() !== "unicast") return undefined;
  return {
    address: parsed.toString(),
    family: parsed.kind() === "ipv4" ? 4 : 6,
  };
}

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

  // Any literal must be globally routable unicast. Hostnames are resolved and
  // subjected to the same rule immediately before the pinned connection.
  if (parseIpLiteral(host) !== undefined && asSafeAddress(host) === undefined) return false;
  return true;
}

/**
 * Resolve `hostname` and return only the addresses that pass the
 * private/loopback/link-local/CGNAT check, or `undefined` if none do (all
 * addresses unsafe, or the lookup failed). Exported so both the fetch-time
 * guard and its regression tests share one resolution path.
 *
 * DNS-rebinding guard (M6-03 follow-up, fixes the gap the audit flagged in
 * `docs/security-audit-v1.md`): {@link isSafeRefUrl} is a *syntactic*
 * pre-filter on the hostname as typed — it cannot catch an attacker-controlled
 * DNS name that resolves to a private/loopback/link-local address (the
 * classic SSRF/DNS-rebinding bypass: `evil.example.com` passes the hostname
 * check today and answers `127.0.0.1` at fetch time).
 */
async function resolveSafeAddress(
  hostname: string,
  lookupAddresses: AddressLookup = defaultAddressLookup,
): Promise<{ address: string; family: 4 | 6 } | undefined> {
  const literal = parseIpLiteral(hostname);
  if (literal !== undefined) return asSafeAddress(hostname);

  try {
    const results = await lookupAddresses(hostname);
    for (const { address } of results) {
      const safe = asSafeAddress(address);
      if (safe !== undefined) return safe;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Public boolean form of {@link resolveSafeAddress} kept for the existing
 * test surface / any external reuse (M6-03 follow-up). A hostname is "safe"
 * if at least one resolved address is not private/loopback/link-local.
 */
export async function isSafeResolvedAddress(
  hostname: string,
  lookupAddresses: AddressLookup = defaultAddressLookup,
): Promise<boolean> {
  return (await resolveSafeAddress(hostname, lookupAddresses)) !== undefined;
}

/**
 * Fetch a single URL whose hostname has already been resolved to a
 * known-safe `address`/`family` (M6-03 follow-up, TOCTOU fix): rather than
 * re-validating a hostname and then letting the HTTP client perform its own,
 * second, independent DNS resolution at connect time — the exact gap an
 * attacker-controlled DNS name (a "rebinding" host that answers safely to
 * the guard and privately to the real connection) can exploit — this pins
 * the *already-validated* address into the connection via undici's
 * `Agent({ connect: { lookup } })` override, so validation and connection
 * are guaranteed to use the identical address. Redirects are fetched with
 * `redirect: "manual"` and returned to the caller un-followed; the caller
 * (`safeFetchFollowingRedirects`) re-runs full validation (schema-level
 * `isSafeRefUrl` + resolved-address check) on every redirect target before
 * following it, so a public URL cannot use a redirect to smuggle a request to
 * a private target past the guard.
 */
export async function fetchWithPinnedAddress(
  url: string,
  address: string,
  family: 4 | 6,
): Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}> {
  const pinnedAgent = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      },
    },
  });
  try {
    const response = await undiciFetch(url, { redirect: "manual", dispatcher: pinnedAgent });
    const body = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: async () => body,
    };
  } finally {
    await pinnedAgent.close();
  }
}

const MAX_REF_URL_REDIRECTS = 5;

/**
 * Fetch `refUrl`, following redirects manually and re-validating every hop
 * (M6-03 follow-up — closes both blocking gaps from the security-audit
 * re-review): each hop must (1) pass the schema-level `isSafeRefUrl` check —
 * scheme + syntactic private-range rules — and (2) resolve to a non-private
 * address, which is then pinned into the actual connection via
 * {@link fetchWithPinnedAddress} so the validated and connected addresses can
 * never diverge. A public URL that redirects to a private target (loopback,
 * link-local, cloud metadata, or another rebinding host) is rejected at the
 * first unsafe hop rather than silently followed by the HTTP client's own
 * redirect handling.
 */
async function safeFetchFollowingRedirects(
  fetchImpl: FetchFn | undefined,
  fetchPinnedAddress: PinnedFetchFn,
  startUrl: string,
  lookupAddresses: AddressLookup,
): Promise<{ ok: boolean; status: number; text(): Promise<string> } | undefined> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REF_URL_REDIRECTS; hop++) {
    if (!isSafeRefUrl(currentUrl)) {
      logStderr({ event: "conjure.ref_url.ssrf_blocked", refUrl: currentUrl, startUrl, hop });
      return undefined;
    }
    const hostname = new URL(currentUrl).hostname;
    const resolved = await resolveSafeAddress(hostname, lookupAddresses);
    if (!resolved) {
      logStderr({ event: "conjure.ref_url.ssrf_blocked", refUrl: currentUrl, startUrl, hop });
      return undefined;
    }
    const res = fetchImpl
      ? await fetchImpl(currentUrl)
      : await fetchPinnedAddress(currentUrl, resolved.address, resolved.family);

    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers?.get("location") ?? null;
      if (!location) {
        logStderr({ event: "conjure.ref_url.skip", refUrl: currentUrl, status });
        return undefined;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  logStderr({ event: "conjure.ref_url.skip", refUrl: startUrl, reason: "too_many_redirects" });
  return undefined;
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
  files: GeneratedFileWithEncoding[];
  manifestEntry: ValidatedComponent["manifestEntry"];
  usage: UsageInfo;
}

/** The URL-fetch seam (AC7). Defaults to the global `fetch`; injectable for tests.
 * `headers` is optional so existing test doubles that only stub `{ ok, status, text }`
 * keep compiling; the redirect-following logic treats a missing `headers` on a
 * 3xx response as "no Location to follow" and stops rather than throwing. */
export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;
export type PinnedFetchFn = typeof fetchWithPinnedAddress;

export interface ConjureDeps {
  chat?: ChatCompletionFn;
  fetchImpl?: FetchFn;
  /** Pinned socket seam for deterministic production-path tests. */
  fetchPinnedAddress?: PinnedFetchFn;
  /** DNS seam for deterministic SSRF tests. Production uses `dns.lookup`. */
  lookupAddresses?: AddressLookup;
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
async function fetchReference(
  fetchImpl: FetchFn | undefined,
  fetchPinnedAddress: PinnedFetchFn,
  refUrl: string,
  lookupAddresses: AddressLookup,
): Promise<string | undefined> {
  try {
    // Re-validate at fetch time against the *resolved* address, pin that exact
    // address into the connection, and re-validate every redirect hop the same
    // way (M6-03 follow-up — closes both the TOCTOU and redirect-bypass gaps
    // from the security-audit re-review). See `safeFetchFollowingRedirects`.
    const res = await safeFetchFollowingRedirects(
      fetchImpl,
      fetchPinnedAddress,
      refUrl,
      lookupAddresses,
    );
    if (!res) return undefined;
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
 * optional vision image, which is attached as a separate content part).
 * `frameworkDirective` is the target-framework instruction the selected adapter
 * owns (AC4) — it begins with `Target framework: <framework>` and adds the
 * per-framework source-shape guidance. */
function buildUserText(
  args: ConjureArgs,
  frameworkDirective: string,
  referenceHtml: string | undefined,
): string {
  const lines = [
    frameworkDirective,
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
  frameworkDirective: string,
  referenceHtml: string | undefined,
  retry: RetryContext | undefined,
): ChatCompletionInput["messages"] {
  let userText = buildUserText(args, frameworkDirective, referenceHtml);
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

// ── Default (production) chat impl: lazy client import ─────────────────────────

/**
 * Default `chat` seam: dynamically imports the M2-01 client on first call, so
 * building the server never eagerly triggers `MissingLLMConfigError` (see module
 * header). A real `conjure` call in a properly-configured deployment resolves
 * this to `withRetry(createChatCompletion)` (M2-06, DRO-253) — every
 * production LLM call this tool makes is retry/backoff-wrapped by default;
 * callers (and tests, via `deps.chat`) never need to remember to apply the
 * wrapper themselves.
 *
 * `withRetry` is called fresh on every invocation rather than wrapped once at
 * module scope: the module-scope `createChatCompletion` binding doesn't exist
 * until the dynamic import resolves, and re-wrapping a plain async function
 * is cheap (no state beyond reading `GENIE_LLM_RETRY_MAX` from `process.env`
 * per call, matching every other env read in this codebase's request path).
 */
const defaultChatCompletion: ChatCompletionFn = async (input) => {
  const { createChatCompletion } = await import("../llm/client.js");
  return withRetry(createChatCompletion)(input);
};

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
  const fetchImpl = deps.fetchImpl;
  const fetchPinnedAddress = deps.fetchPinnedAddress ?? fetchWithPinnedAddress;
  const lookupAddresses = deps.lookupAddresses ?? defaultAddressLookup;
  const systemPrompt = (
    deps.loadSystemPrompt ?? (() => loadPrompt(GENERATE_COMPONENT_SYSTEM_PROMPT_FILE))
  )();

  const startedAt = performance.now();

  // AC4 — pick the framework adapter from the validated `framework` input. The
  // adapter owns the framework-specific prompt directive (the one such bit
  // `conjure` carried inline). Selection works for every framework, including
  // the Vue/HTML stubs: their codegen is stubbed, but `promptDirective` is
  // metadata the model reads, so pure generation still targets them.
  const adapter = await getAdapter(parsed.framework);
  const frameworkDirective = adapter.promptDirective;

  const referenceHtml = parsed.refUrl
    ? await fetchReference(fetchImpl, fetchPinnedAddress, parsed.refUrl, lookupAddresses)
    : undefined;

  const { outcome, usage, attempts } = await runComponentGeneration({
    chat,
    model: parsed.model,
    validateGeneratedComponent: validateGeneratedBinaryContent,
    buildMessages: (retry) =>
      buildMessages(systemPrompt.text, parsed, frameworkDirective, referenceHtml, retry),
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
    files: normalizeGeneratedFiles(component.files),
    manifestEntry: component.manifestEntry,
    usage,
  };
}

// ── MCP registration ──────────────────────────────────────────────────────────

const conjureOutputShape = {
  componentName: z.string(),
  group: z.string(),
  files: z.array(
    z
      .object({
        path: z.string(),
        content: z.string(),
        mimeType: z.string(),
        encoding: z.enum(["utf-8", "base64"]),
      })
      .strict(),
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
        "them to a kit is the caller's separate, plan-gated step: plan the returned paths, map " +
        "each {path, content, mimeType, encoding} to write_files " +
        "{path, data: content, mimeType, encoding}, then preview to show the result. " +
        "`design-default` is the valid gateway routing alias; " +
        "override it only with a concrete model id exposed by the configured endpoint.",
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
