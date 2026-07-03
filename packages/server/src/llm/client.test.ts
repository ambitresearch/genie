/**
 * Tests for the M2-01 LLM client wrapper.
 *
 * Uses a real local `node:http` stub server (not a `globalThis.fetch` mock):
 * the `openai` SDK's default fetch implementation is the real global `fetch`
 * (Node ≥ 22 has it built in — see `openai/internal/shims.js`
 * `getDefaultFetch`), so a stub server that actually accepts a TCP connection
 * is the only way to assert the *real* request shape (AC6) rather than
 * whatever a fetch-mock double happens to construct.
 *
 * No static top-level `import "./client.js"` in this file: the module's
 * `llmClient` singleton constructs eagerly at import time (AC1) and throws
 * `MissingLLMConfigError` when env vars are unset (AC2) — and per ESM
 * evaluation order, static imports are fully evaluated before any of this
 * file's own top-level statements run, so a `process.env[...] = …` line
 * placed textually "before" a static import would NOT actually run first.
 * Every import of `./client.js` below is therefore a dynamic `await
 * import(...)`, matching the existing `vi.resetModules()` + dynamic-import
 * pattern already used in `plan.test.ts` / `write_files.rollback.test.ts` for
 * the same reason (simulating a fresh module instance).
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatCompletionInput } from "./client.js";

const BASE_URL_ENV = "GENIE_LLM_BASE_URL";
const API_KEY_ENV = "GENIE_LLM_API_KEY";
const TIMEOUT_ENV = "GENIE_LLM_REQUEST_TIMEOUT_MS";

// ─── Bootstrap import ────────────────────────────────────────────────────────
//
// One working import of the module, so the pure-function exports
// (`createLLMClient`, `resolveTimeoutMs`, the error class, the env-var name
// constants) become available to every test below. The placeholder env vars
// use the RFC 2606 `.invalid` TLD so a bug that actually dispatched a network
// call against them would fail loudly (DNS resolution error) rather than
// silently hitting a real host. Cleared immediately after import — only this
// one module instance's already-constructed singleton depended on them;
// every test that cares about specific env-var handling does its own
// `vi.resetModules()` + fresh dynamic import with its own env setup.
process.env[BASE_URL_ENV] = "http://llm-client-test-bootstrap.invalid/v1";
process.env[API_KEY_ENV] = "sk-bootstrap-placeholder";
const {
  createLLMClient,
  resolveTimeoutMs,
  MissingLLMConfigError,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  GENIE_LLM_BASE_URL_ENV,
  GENIE_LLM_API_KEY_ENV,
  GENIE_LLM_REQUEST_TIMEOUT_MS_ENV,
} = await import("./client.js");
delete process.env[BASE_URL_ENV];
delete process.env[API_KEY_ENV];

// Sanity-check the bootstrap constants match the literal env var names used
// above — if these ever drift apart, every test below would be silently
// exercising the wrong env var.
if (
  GENIE_LLM_BASE_URL_ENV !== BASE_URL_ENV ||
  GENIE_LLM_API_KEY_ENV !== API_KEY_ENV ||
  GENIE_LLM_REQUEST_TIMEOUT_MS_ENV !== TIMEOUT_ENV
) {
  throw new Error("client.ts env var constants drifted from this test file's literals");
}

/** A captured request, as observed by the stub server. */
interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** Minimal shape of a chat-completion response the stub server returns. */
interface StubChatCompletionResponse {
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

function stubChatCompletion(
  overrides: Partial<StubChatCompletionResponse> = {},
): StubChatCompletionResponse {
  return {
    id: "chatcmpl-stub-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "design-default",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hello from the stub" },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    ...overrides,
  };
}

/**
 * Start a stub OpenAI-compatible HTTP server. `handler` decides the response;
 * every request is recorded to `requests` regardless of what the handler
 * does, so tests can assert on request shape (AC6) independent of the
 * response scripted for that test.
 */
async function startStubServer(
  handler: (
    req: CapturedRequest,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): Promise<{ baseURL: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];

  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        // Wrap the whole handler path in try/catch: if the scripted handler
        // throws/rejects (or JSON.stringify fails on a circular body), an
        // unhandled rejection here would leave the HTTP response un-ended and
        // hang the test on the SDK's fetch — a 500 instead makes the failure
        // deterministic and surfaces the real error rather than a timeout.
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

          const { status, body } = await handler(captured);
          res.writeHead(status, { "content-type": "application/json" });
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

// ─── createLLMClient / MissingLLMConfigError (AC1, AC2, AC3) ────────────────

describe("createLLMClient", () => {
  it("constructs an openai client from GENIE_LLM_BASE_URL / GENIE_LLM_API_KEY (AC1)", () => {
    const client = createLLMClient({
      [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1",
      [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
    });
    expect(client.baseURL).toBe("http://example.invalid/v1");
    expect(client.apiKey).toBe("sk-test-key");
  });

  it("throws MissingLLMConfigError when GENIE_LLM_BASE_URL is unset (AC2)", () => {
    expect(() => createLLMClient({ [GENIE_LLM_API_KEY_ENV]: "sk-test-key" })).toThrow(
      MissingLLMConfigError,
    );
  });

  it("throws MissingLLMConfigError when GENIE_LLM_API_KEY is unset (AC2)", () => {
    expect(() =>
      createLLMClient({ [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1" }),
    ).toThrow(MissingLLMConfigError);
  });

  it("throws MissingLLMConfigError when both are unset, naming both env vars (AC2, AC3)", () => {
    let caught: unknown;
    try {
      createLLMClient({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingLLMConfigError);
    const err = caught as InstanceType<typeof MissingLLMConfigError>;
    expect(err.missing).toEqual([GENIE_LLM_BASE_URL_ENV, GENIE_LLM_API_KEY_ENV]);
    // AC3: the error message names both env vars — assert on the exact
    // strings, not just that *some* message was thrown.
    expect(err.message).toContain(GENIE_LLM_BASE_URL_ENV);
    expect(err.message).toContain(GENIE_LLM_API_KEY_ENV);
  });

  it("treats a blank string base URL the same as unset (no silent empty-string endpoint)", () => {
    expect(() =>
      createLLMClient({
        [GENIE_LLM_BASE_URL_ENV]: "",
        [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
      }),
    ).toThrow(MissingLLMConfigError);
  });

  it("treats a whitespace-only base URL or API key the same as unset", () => {
    // Regression guard (Copilot review): a stray "  " from a misconfigured
    // .env file is truthy and would otherwise slip past the fail-fast guard,
    // only to fail later with a confusing URL-parse/auth error instead of a
    // clear MissingLLMConfigError.
    expect(() =>
      createLLMClient({
        [GENIE_LLM_BASE_URL_ENV]: "   ",
        [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
      }),
    ).toThrow(MissingLLMConfigError);
    expect(() =>
      createLLMClient({
        [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1",
        [GENIE_LLM_API_KEY_ENV]: "\t\n",
      }),
    ).toThrow(MissingLLMConfigError);
  });

  it("trims surrounding whitespace from valid base URL / API key values", () => {
    const client = createLLMClient({
      [GENIE_LLM_BASE_URL_ENV]: "  http://example.invalid/v1  ",
      [GENIE_LLM_API_KEY_ENV]: "  sk-test-key  ",
    });
    expect(client.baseURL).toBe("http://example.invalid/v1");
    expect(client.apiKey).toBe("sk-test-key");
  });

  it("never falls back to a hardcoded default base URL (AC3)", () => {
    // Regression guard: constructing with only an API key must not silently
    // resolve to some baked-in provider URL — it must fail closed, naming
    // exactly the one missing var.
    let caught: unknown;
    try {
      createLLMClient({ [GENIE_LLM_API_KEY_ENV]: "sk-test-key" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingLLMConfigError);
    expect((caught as InstanceType<typeof MissingLLMConfigError>).missing).toEqual([
      GENIE_LLM_BASE_URL_ENV,
    ]);
  });

  it("applies the resolved timeout to the constructed client (AC5)", () => {
    const client = createLLMClient({
      [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1",
      [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
      [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "5000",
    });
    expect(client.timeout).toBe(5000);
  });

  it("defaults to DEFAULT_LLM_REQUEST_TIMEOUT_MS when the timeout env var is unset (AC5)", () => {
    const client = createLLMClient({
      [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1",
      [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
    });
    expect(client.timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  });

  it("disables the openai SDK's own built-in retries (maxRetries: 0) — M2-06 owns retry policy", () => {
    const client = createLLMClient({
      [GENIE_LLM_BASE_URL_ENV]: "http://example.invalid/v1",
      [GENIE_LLM_API_KEY_ENV]: "sk-test-key",
    });
    expect(client.maxRetries).toBe(0);
  });
});

// ─── resolveTimeoutMs (AC5) ──────────────────────────────────────────────────

describe("resolveTimeoutMs", () => {
  it("returns the default when unset", () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({})).toBe(120_000);
  });

  it("parses a valid positive integer from env", () => {
    expect(resolveTimeoutMs({ [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "45000" })).toBe(45_000);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(resolveTimeoutMs({ [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "not-a-number" })).toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  });

  it("falls back to the default for zero or negative values", () => {
    expect(resolveTimeoutMs({ [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "0" })).toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
    expect(resolveTimeoutMs({ [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "-1000" })).toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  });

  it("falls back to the default for a blank string", () => {
    expect(resolveTimeoutMs({ [GENIE_LLM_REQUEST_TIMEOUT_MS_ENV]: "" })).toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  });

  it("defaults its env argument to process.env when called with none", () => {
    const prev = process.env[TIMEOUT_ENV];
    try {
      process.env[TIMEOUT_ENV] = "9999";
      expect(resolveTimeoutMs()).toBe(9999);
    } finally {
      if (prev === undefined) delete process.env[TIMEOUT_ENV];
      else process.env[TIMEOUT_ENV] = prev;
    }
  });
});

// ─── createChatCompletion against a stub server (AC4, AC6) ──────────────────

describe("createChatCompletion", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("sends model, messages, response_format, and a Bearer Authorization header (AC6)", async () => {
    const stub = await startStubServer(() => ({
      status: 200,
      body: stubChatCompletion(),
    }));
    try {
      // createLLMClient is a pure factory — no need to touch the shared
      // singleton or reset modules to point an independent client at the stub.
      const client = createLLMClient({
        [GENIE_LLM_BASE_URL_ENV]: stub.baseURL,
        [GENIE_LLM_API_KEY_ENV]: "sk-test-key-123",
      });

      const input: ChatCompletionInput = {
        model: "design-default",
        messages: [{ role: "user", content: "generate a primary button" }],
        response_format: { type: "json_object" },
      };
      await client.chat.completions.create(input);

      expect(stub.requests).toHaveLength(1);
      const sent = stub.requests[0]!;
      expect(sent.method).toBe("POST");
      expect(sent.path).toBe("/v1/chat/completions");
      expect(sent.headers["authorization"]).toBe("Bearer sk-test-key-123");
      const sentBody = sent.body as ChatCompletionInput;
      expect(sentBody.model).toBe("design-default");
      expect(sentBody.messages).toEqual([{ role: "user", content: "generate a primary button" }]);
      expect(sentBody.response_format).toEqual({ type: "json_object" });
    } finally {
      await stub.close();
    }
  });

  it("wraps client.chat.completions.create and resolves with the completion (AC4)", async () => {
    const stub = await startStubServer(() => ({
      status: 200,
      body: stubChatCompletion({ model: "design-best" }),
    }));
    try {
      // createChatCompletion calls through the module-scope `llmClient`
      // singleton, which is fixed at import time — reset the module registry
      // and set env vars first so THIS fresh instance's singleton points at
      // the stub server.
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-456";
      const fresh = await import("./client.js");

      const result = await fresh.createChatCompletion({
        model: "design-best",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.id).toBe("chatcmpl-stub-1");
      expect(result.model).toBe("design-best");
      expect(result.choices[0]?.message.content).toBe("hello from the stub");
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("logs a structured line to stderr with model/promptTokens/completionTokens/latencyMs (AC4)", async () => {
    const stub = await startStubServer(() => ({
      status: 200,
      body: stubChatCompletion({ model: "design-default" }),
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-789";
      const fresh = await import("./client.js");
      stderrSpy.mockClear();

      await fresh.createChatCompletion({
        model: "design-default",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        event: "llm.chat_completion",
        model: "design-default",
        promptTokens: 12,
        completionTokens: 4,
      });
      expect(typeof parsed["latencyMs"]).toBe("number");
      const latencyMs = parsed["latencyMs"] as number;
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(latencyMs)).toBe(true);
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("falls back to null token counts when the response carries no usage block", async () => {
    const stub = await startStubServer(() => {
      const body = stubChatCompletion();
      // @ts-expect-error — deliberately constructing a response missing `usage`
      delete body.usage;
      return { status: 200, body };
    });
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-no-usage";
      const fresh = await import("./client.js");
      stderrSpy.mockClear();

      await fresh.createChatCompletion({
        model: "design-default",
        messages: [{ role: "user", content: "hi" }],
      });

      const line = stderrSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
      expect(parsed["promptTokens"]).toBeNull();
      expect(parsed["completionTokens"]).toBeNull();
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("never writes to stdout (stdio transport safety)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stub = await startStubServer(() => ({
      status: 200,
      body: stubChatCompletion(),
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-stdout";
      const fresh = await import("./client.js");

      await fresh.createChatCompletion({
        model: "design-default",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      stdoutSpy.mockRestore();
      await stub.close();
    }
  });

  it("propagates the underlying error untouched on a non-2xx response (no retry/swallow)", async () => {
    // Regression guard (Copilot review): this must exercise `createChatCompletion`
    // itself, not just `client.chat.completions.create` — a version that called
    // the raw SDK method would pass even if createChatCompletion started
    // wrapping or swallowing errors, since it never actually invokes the
    // wrapper under test.
    const stub = await startStubServer(() => ({
      status: 500,
      body: { error: { message: "simulated upstream failure" } },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-propagate";
      const fresh = await import("./client.js");

      await expect(
        fresh.createChatCompletion({
          model: "design-default",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow();
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("makes exactly one attempt on a 5xx response — no built-in SDK retries (M2-06 owns retry policy)", async () => {
    // Regression guard: the `openai` SDK retries 429/5xx/408/409 internally
    // by default (maxRetries: 2). If this client left that enabled, M2-06's
    // retry/backoff wrapper around `createChatCompletion` would have its
    // "max N attempts" and "each attempt logged" acceptance criteria silently
    // undermined by extra attempts happening a layer below where M2-06's
    // wrapper can neither see nor count them. This client must make exactly
    // one request per call, full stop — exercised through createChatCompletion
    // itself (not just the raw SDK method) so this proves the invariant for
    // the actual call path every generation verb uses.
    const stub = await startStubServer(() => ({
      status: 503,
      body: { error: { message: "simulated transient failure" } },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-one-attempt";
      const fresh = await import("./client.js");

      await expect(
        fresh.createChatCompletion({
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

  it("does not log to stderr when the call fails", async () => {
    const stub = await startStubServer(() => ({
      status: 500,
      body: { error: { message: "simulated upstream failure" } },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-test-key-fail";
      const fresh = await import("./client.js");
      stderrSpy.mockClear();

      await expect(
        fresh.createChatCompletion({
          model: "design-default",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow();

      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });
});
