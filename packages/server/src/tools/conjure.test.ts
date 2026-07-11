/**
 * Unit tests for the M2-03 `conjure` tool (DRO-250) — all 10 ACs, driven by a
 * stub chat-completion seam so no real endpoint or `GENIE_LLM_*` env is touched
 * (the M2-03 DoD's "unit (stub LLM)" leg; the "$5-capped real endpoint" leg is
 * the separate integration test M2-09 owns).
 *
 * The stub captures every request it's handed (mirroring `client.test.ts`'s
 * capture pattern) so we can assert the *request shape* — model, response_format,
 * vision content parts, retry feedback — independent of whatever component the
 * scripted reply returns.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONJURE_TOOL_NAME,
  DEFAULT_FRAMEWORK,
  DEFAULT_MODEL,
  REF_URL_WARN_BYTES,
  conjure,
  isSafeRefUrl,
  truncateUtf8,
  registerConjureTool,
  ConjureError,
  type ChatCompletionFn,
  type ConjureArgs,
  type ConjureDeps,
} from "./conjure.js";
import type { ChatCompletionInput, ChatCompletionResult } from "../llm/client.js";
import type { ValidatedComponent } from "../llm/schema.js";
import { gitBlobHash, loadGenerateComponentSystemPrompt } from "../llm/prompts.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal schema-valid component (same shape as schema.test.ts's goodFixture). */
function goodComponent(overrides: Partial<ValidatedComponent> = {}): ValidatedComponent {
  return {
    componentName: "Button",
    group: "actions",
    files: [
      {
        path: "components/actions/Button/Button.tsx",
        content: "export default function Button() { return null; }",
        mimeType: "text/tsx",
      },
      {
        path: "components/actions/Button/Button.html",
        content: '<!-- @genie group="actions" -->\n<button>Click me</button>',
        mimeType: "text/html",
      },
    ],
    manifestEntry: { viewport: { width: 320, height: 140 }, subtitle: "Primary button" },
    ...overrides,
  };
}

/** Build a stub `ChatCompletionResult` around a given assistant text payload. */
function completionOf(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 100,
    completion_tokens: 200,
    total_tokens: 300,
  },
): ChatCompletionResult {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "stub-model",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } },
    ],
    usage,
  } as unknown as ChatCompletionResult;
}

/**
 * A stub chat seam that returns scripted replies in order and records every
 * request. When it runs out of scripted replies it repeats the last one.
 */
function stubChat(
  replies: ChatCompletionResult[],
): ChatCompletionFn & { calls: ChatCompletionInput[] } {
  const calls: ChatCompletionInput[] = [];
  let i = 0;
  const fn = (async (input: ChatCompletionInput) => {
    calls.push(input);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply!;
  }) as ChatCompletionFn & { calls: ChatCompletionInput[] };
  fn.calls = calls;
  return fn;
}

/** Baseline valid args. */
function args(overrides: Partial<ConjureArgs> = {}): Record<string, unknown> {
  return {
    kitId: "acme-kit-a1b2c3",
    kit: "Acme kit: clay accent #c87c5e, 8px radius, Inter type scale.",
    prompt: "A primary button",
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
});

// ── AC1 — tool name ───────────────────────────────────────────────────────────

describe("AC1 — tool name", () => {
  it("is mcp__genie__conjure", () => {
    expect(CONJURE_TOOL_NAME).toBe("mcp__genie__conjure");
  });

  it("registers under that exact name and is discoverable via tools/list", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerConjureTool(server, {
      chat: stubChat([completionOf(JSON.stringify(goodComponent()))]),
    });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("mcp__genie__conjure");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ── AC2 — input schema ────────────────────────────────────────────────────────

describe("AC2 — input", () => {
  it("accepts the full documented input set", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    // Inject a fetch stub so this unit test never touches the network for refUrl.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<main>ref</main>",
    }));
    await expect(
      conjure(
        { chat, fetchImpl },
        args({
          group: "actions",
          refUrl: "https://example.com/ref",
          framework: "vue",
          model: "design-best",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a missing kit (required)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await expect(
      conjure({ chat }, { kitId: "acme-kit-a1b2c3", prompt: "x y z" }),
    ).rejects.toThrow();
  });

  it("rejects an http(s) URL in refImageDataUrl (that belongs in refUrl)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await expect(
      conjure(
        { chat },
        args({ refImageDataUrl: "https://example.com/x.png" } as Partial<ConjureArgs>),
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown framework", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await expect(
      conjure({ chat }, args({ framework: "svelte" } as unknown as Partial<ConjureArgs>)),
    ).rejects.toThrow();
  });
});

// ── AC3 — defaults ────────────────────────────────────────────────────────────

describe("AC3 — defaults", () => {
  it("defaults framework to react and model to design-default", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    expect(DEFAULT_FRAMEWORK).toBe("react");
    expect(DEFAULT_MODEL).toBe("design-default");
    // The model default reaches the wire.
    expect(chat.calls[0]!.model).toBe("design-default");
    // The framework default reaches the user message.
    const userMsg = chat.calls[0]!.messages[1]!;
    expect(JSON.stringify(userMsg.content)).toContain("Target framework: react");
  });

  it("honors an explicit model + framework over the defaults", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args({ model: "design-local", framework: "html" }));
    expect(chat.calls[0]!.model).toBe("design-local");
    expect(JSON.stringify(chat.calls[0]!.messages[1]!.content)).toContain("Target framework: html");
  });
});

// ── M2-08 AC4 — conjure picks the framework adapter ───────────────────────────

describe("M2-08 AC4 — adapter selection drives the framework directive", () => {
  it("injects the React adapter's directive (source-shape guidance, not just the label)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args({ framework: "react" }));
    const userContent = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userContent).toContain("Target framework: react");
    // The directive is sourced from ReactAdapter.promptDirective — it carries
    // React-specific guidance the old inline `Target framework:` line never had.
    expect(userContent).toContain(".tsx");
  });

  it("injects the Vue adapter's directive when framework=vue (pure generation still works)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const res = await conjure({ chat }, args({ framework: "vue" }));
    const userContent = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userContent).toContain("Target framework: vue");
    expect(userContent).toContain("Single File Component");
    // conjure is pure generation — targeting vue does NOT invoke stubbed codegen.
    expect(res.componentName).toBe("Button");
  });

  it("injects the HTML adapter's directive when framework=html", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args({ framework: "html" }));
    const userContent = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userContent).toContain("Target framework: html");
    expect(userContent).toContain("vanilla");
  });
});

// ── AC4 — response_format json_schema ─────────────────────────────────────────

describe("AC4 — structured output request", () => {
  it("sends response_format json_schema wrapping COMPONENT_SCHEMA", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    const rf = chat.calls[0]!.response_format as {
      type: string;
      json_schema: { name: string; schema: { title?: string; $id?: string } };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("GenieComponent");
    // The wrapped schema is genie's COMPONENT_SCHEMA (identified by its $id/title).
    expect(rf.json_schema.schema.$id).toBe("https://genie.dev/schema/component.schema.json");
    expect(rf.json_schema.schema.title).toBe("GenieComponent");
  });
});

// ── AC5 — versioned system prompt ─────────────────────────────────────────────

describe("AC5 — versioned system prompt", () => {
  it("loads the real prompt as message[0] (role: system)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    const sys = chat.calls[0]!.messages[0]!;
    expect(sys.role).toBe("system");
    // It's the on-disk prompt, not an inline literal.
    const loaded = loadGenerateComponentSystemPrompt();
    expect(sys.content).toBe(loaded.text);
    expect(loaded.file).toBe("generate-component.system.md");
  });

  it("logs the prompt version (git blob hash) on every call (AC5/AC10)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    const loaded = loadGenerateComponentSystemPrompt();
    // version == git hash-object of the prompt text.
    expect(loaded.version).toBe(gitBlobHash(loaded.text));
    expect(loaded.version).toMatch(/^[0-9a-f]{40}$/);
    const logged = stderrLines().find((l) => l.event === "conjure");
    expect(logged?.promptVersion).toBe(loaded.version);
  });
});

// ── AC6 — vision input ────────────────────────────────────────────────────────

describe("AC6 — reference image as vision input", () => {
  it("attaches refImageDataUrl as an image content part alongside the text", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    await conjure({ chat }, args({ refImageDataUrl: dataUrl }));
    const userMsg = chat.calls[0]!.messages[1]!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === "text")).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img?.image_url?.url).toBe(dataUrl);
  });

  it("uses a plain string user message when no image is given", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    expect(typeof chat.calls[0]!.messages[1]!.content).toBe("string");
  });
});

// ── AC7 — refUrl fetch + 1 MB warn ────────────────────────────────────────────

describe("AC7 — reference URL fetch + inline", () => {
  it("fetches refUrl and inlines the body into the user message", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<h1>Ref Page</h1>",
    }));
    await conjure({ chat, fetchImpl }, args({ refUrl: "https://example.com/ref" }));
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/ref");
    expect(JSON.stringify(chat.calls[0]!.messages[1]!.content)).toContain("<h1>Ref Page</h1>");
  });

  it("warns and truncates when the fetched body exceeds 1 MB", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const big = "x".repeat(REF_URL_WARN_BYTES + 1000);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => big }));
    await conjure({ chat, fetchImpl }, args({ refUrl: "https://example.com/big" }));
    const warn = stderrLines().find((l) => l.event === "conjure.ref_url.oversize");
    expect(warn).toBeDefined();
    expect(warn?.bytes).toBeGreaterThan(REF_URL_WARN_BYTES);
    // Truncated, not sent whole.
    const sent = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(sent).toContain("reference truncated by genie");
  });

  it("skips a failed fetch (non-ok) and still generates", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }));
    const res = await conjure({ chat, fetchImpl }, args({ refUrl: "https://example.com/missing" }));
    expect(res.componentName).toBe("Button");
    expect(stderrLines().some((l) => l.event === "conjure.ref_url.skip")).toBe(true);
  });

  it("truncates an oversize body on a UTF-8 byte boundary (not a char count)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    // Multi-byte chars: a char-count slice at REF_URL_WARN_BYTES would keep
    // ~3× the byte budget (€ is 3 bytes); a byte-correct slice must land within
    // the cap plus only the small fixed message preamble/marker.
    const multibyte = "€".repeat(REF_URL_WARN_BYTES); // 3 bytes each → ~3 MB
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => multibyte }));
    await conjure({ chat, fetchImpl }, args({ refUrl: "https://example.com/utf8" }));
    const sent = chat.calls[0]!.messages[1]!.content as string;
    // The whole message (preamble + capped reference + marker) stays within the
    // cap plus a small fixed overhead — i.e. the 3 MB body was truncated, not
    // sent whole (which would be ~3× the cap).
    expect(Buffer.byteLength(sent, "utf-8")).toBeLessThan(REF_URL_WARN_BYTES + 4096);
  });

  it("truncateUtf8 caps by bytes on a codepoint boundary (no U+FFFD)", () => {
    const cap = 10;
    // 4 × "€" (3 bytes each) = 12 bytes; cap 10 must drop to 3 chars (9 bytes),
    // never splitting the 4th char into a replacement character.
    const out = truncateUtf8("€€€€", cap);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(cap);
    expect(out).toBe("€€€");
    expect(out).not.toContain("�");
    // ASCII under the cap is returned unchanged.
    expect(truncateUtf8("hello", 100)).toBe("hello");
  });

  it("rejects an SSRF-risky refUrl (file:, localhost, private/link-local) at the boundary", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    for (const bad of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/x",
      "http://10.0.0.5/x",
      "ftp://example.com/x",
    ]) {
      await expect(conjure({ chat }, args({ refUrl: bad }))).rejects.toThrow();
    }
  });

  it("accepts a public http(s) refUrl", () => {
    expect(isSafeRefUrl("https://example.com/page")).toBe(true);
    expect(isSafeRefUrl("http://93.184.216.34/x")).toBe(true); // public IP literal
    expect(isSafeRefUrl("http://localhost/x")).toBe(false);
    expect(isSafeRefUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeRefUrl("http://172.16.0.1/x")).toBe(false);
    expect(isSafeRefUrl("http://172.32.0.1/x")).toBe(true); // .32 is outside 16-31 private range
  });
});

// ── AC8 — validate + retry once ───────────────────────────────────────────────

describe("AC8 — schema validation + retry once", () => {
  it("returns immediately when the first reply validates (no retry)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    expect(chat.calls).toHaveLength(1);
  });

  it("retries once with the validation error + prior output appended, then succeeds", async () => {
    // First reply: schema-invalid (missing manifestEntry). Second: valid.
    const invalid = JSON.stringify({ componentName: "Button", group: "actions", files: [] });
    const chat = stubChat([completionOf(invalid), completionOf(JSON.stringify(goodComponent()))]);
    const res = await conjure({ chat }, args());
    expect(chat.calls).toHaveLength(2);
    // The retry message names the failure and echoes the prior attempt.
    const retryUser = JSON.stringify(chat.calls[1]!.messages[1]!.content);
    expect(retryUser).toContain("failed schema validation");
    expect(retryUser).toContain("previous");
    expect(res.componentName).toBe("Button");
  });

  it("throws ConjureError after a second invalid reply (only one retry)", async () => {
    const invalid = JSON.stringify({ componentName: "x", files: [] });
    const chat = stubChat([completionOf(invalid), completionOf(invalid)]);
    await expect(conjure({ chat }, args())).rejects.toBeInstanceOf(ConjureError);
    expect(chat.calls).toHaveLength(2); // exactly two attempts, never three
  });

  it("treats an empty reply as invalid and retries", async () => {
    const chat = stubChat([completionOf(""), completionOf(JSON.stringify(goodComponent()))]);
    const res = await conjure({ chat }, args());
    expect(chat.calls).toHaveLength(2);
    expect(res.componentName).toBe("Button");
  });

  it("recovers from a ```json-fenced but otherwise valid reply without a retry", async () => {
    const fenced = "```json\n" + JSON.stringify(goodComponent()) + "\n```";
    const chat = stubChat([completionOf(fenced)]);
    const res = await conjure({ chat }, args());
    expect(chat.calls).toHaveLength(1);
    expect(res.componentName).toBe("Button");
  });
});

// ── AC9 — pure output shape ───────────────────────────────────────────────────

describe("AC9 — returns { componentName, files, manifestEntry }, writes nothing", () => {
  it("returns the validated component + summed usage", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    const res = await conjure({ chat }, args());
    expect(res.componentName).toBe("Button");
    expect(res.group).toBe("actions");
    expect(res.files).toHaveLength(2);
    expect(res.files.every((file) => file.encoding === "utf-8")).toBe(true);
    expect(res.manifestEntry.viewport).toEqual({ width: 320, height: 140 });
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 200, totalTokens: 300 });
  });

  it("retries invalid model binary content and returns normalized encoding", async () => {
    const invalid = goodComponent({
      files: [
        ...goodComponent().files,
        {
          path: "components/actions/Button/icon.png",
          content: "not base64!",
          mimeType: "text/plain",
        },
      ],
    });
    const valid = goodComponent({
      files: [
        ...goodComponent().files,
        {
          path: "components/actions/Button/icon.png",
          content: "aGVsbG8=",
          mimeType: "text/plain",
        },
      ],
    });
    const chat = stubChat([
      completionOf(JSON.stringify(invalid)),
      completionOf(JSON.stringify(valid)),
    ]);

    const res = await conjure({ chat }, args());

    expect(chat.calls).toHaveLength(2);
    expect(res.files.find((file) => file.path.endsWith("icon.png"))).toMatchObject({
      content: "aGVsbG8=",
      encoding: "base64",
      mimeType: "image/png",
    });
  });

  it("sums usage across the retry attempt", async () => {
    const invalid = JSON.stringify({ componentName: "x", files: [] });
    const chat = stubChat([completionOf(invalid), completionOf(JSON.stringify(goodComponent()))]);
    const res = await conjure({ chat }, args());
    expect(res.usage.totalTokens).toBe(600); // 300 + 300
  });

  it("exposes no write side effect on ConjureDeps (generation is pure)", () => {
    // Structural guard: the deps a caller wires are chat/fetch/prompt only —
    // no store, no writer. If a future edit adds a write path it must add a dep
    // here, which would surface in this list.
    const deps: ConjureDeps = {};
    expect(Object.keys(deps)).toEqual([]);
  });
});

// ── AC10 — per-call log ───────────────────────────────────────────────────────

describe("AC10 — per-call structured log", () => {
  it("logs model/promptTokens/completionTokens/latencyMs/componentName", async () => {
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args({ model: "design-best" }));
    const line = stderrLines().find((l) => l.event === "conjure" && l.ok === true);
    expect(line).toMatchObject({
      event: "conjure",
      ok: true,
      model: "design-best",
      promptTokens: 100,
      completionTokens: 200,
      componentName: "Button",
    });
    expect(typeof line?.latencyMs).toBe("number");
    expect(Number.isInteger(line?.latencyMs)).toBe(true);
  });

  it("never writes to stdout (stdio transport safety)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const chat = stubChat([completionOf(JSON.stringify(goodComponent()))]);
    await conjure({ chat }, args());
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

// ── Tool-boundary error mapping ───────────────────────────────────────────────

describe("tool boundary", () => {
  it("maps ConjureError to an isError result with a code (not a thrown transport error)", async () => {
    const invalid = JSON.stringify({ nope: true });
    const server = new McpServer({ name: "t", version: "0" });
    registerConjureTool(server, { chat: stubChat([completionOf(invalid), completionOf(invalid)]) });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({ name: CONJURE_TOOL_NAME, arguments: args() })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(res.isError).toBe(true);
      const payload = JSON.parse(res.content[0]!.text) as { code: string };
      expect(payload.code).toBe("ERR_LLM_OUTPUT_INVALID");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structuredContent on success through the transport", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerConjureTool(server, {
      chat: stubChat([completionOf(JSON.stringify(goodComponent()))]),
    });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({ name: CONJURE_TOOL_NAME, arguments: args() })) as {
        structuredContent?: { componentName: string; files: { encoding: string }[] };
      };
      expect(res.structuredContent?.componentName).toBe("Button");
      expect(res.structuredContent?.files.every((file) => file.encoding === "utf-8")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ── Production wiring — defaultChatCompletion is retry-wrapped (M2-06, DRO-253) ──
//
// Every other describe block above injects `deps.chat` and never touches
// `defaultChatCompletion` at all — which is exactly how a Copilot review on
// PR #126 caught this gap in the first place: this file's own module
// docstring claimed conjure "calls the endpoint through the M2-01 client",
// but nothing exercised the REAL default seam, so nothing would have failed
// if `withRetry` were silently dropped from it. These tests go around
// `deps.chat` on purpose and drive a real HTTP stub server through
// `defaultChatCompletion`, the same way `client.test.ts` and `retry.test.ts`'s
// own "integration with createChatCompletion against a real stub" block do.

describe("production wiring — defaultChatCompletion applies withRetry (M2-06)", () => {
  const BASE_URL_ENV = "GENIE_LLM_BASE_URL";
  const API_KEY_ENV = "GENIE_LLM_API_KEY";

  function goodComponentBody(): { status: number; body: unknown } {
    return {
      status: 200,
      body: {
        id: "chatcmpl-conjure-prod-wiring",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "design-default",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(goodComponent()) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    };
  }

  async function startStubServer(
    handler: (callNumber: number) => { status: number; body: unknown },
  ): Promise<{ baseURL: string; calls: number; close: () => Promise<void> }> {
    let calls = 0;
    const server: Server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        calls += 1;
        const { status, body } = handler(calls);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return {
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      get calls() {
        return calls;
      },
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  it("recovers a mid-flight 503 without deps.chat — proves the DEFAULT seam retries, not just the injectable one", async () => {
    // A version of conjure.ts that dropped `withRetry` from
    // `defaultChatCompletion` (regressing back to a bare `createChatCompletion`)
    // would make exactly one request here and reject on the first 503 — this
    // test would fail, whereas every `deps.chat`-injecting test above would
    // keep passing, since none of them touch the default seam at all.
    const stub = await startStubServer((call) =>
      call === 1
        ? { status: 503, body: { error: { message: "simulated transient upstream failure" } } }
        : goodComponentBody(),
    );
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-conjure-prod-wiring";
      const fresh = await import("./conjure.js");

      // No `chat` in deps — exercises `defaultChatCompletion` for real.
      const result = await fresh.conjure({}, args());

      expect(result.componentName).toBe("Button");
      expect(stub.calls).toBe(2); // 1 failed + 1 retried — proves a retry happened.
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });

  it("does not retry a permanent 400 through the default seam (AC2 still holds in production)", async () => {
    const stub = await startStubServer(() => ({
      status: 400,
      body: { error: { message: "simulated bad request" } },
    }));
    try {
      vi.resetModules();
      process.env[BASE_URL_ENV] = stub.baseURL;
      process.env[API_KEY_ENV] = "sk-conjure-prod-wiring-400";
      const fresh = await import("./conjure.js");

      await expect(fresh.conjure({}, args())).rejects.toThrow();
      expect(stub.calls).toBe(1); // no retry budget spent on a non-retryable error.
    } finally {
      delete process.env[BASE_URL_ENV];
      delete process.env[API_KEY_ENV];
      await stub.close();
    }
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse every JSON line the stderr spy captured. */
function stderrLines(): Array<
  Record<string, unknown> & {
    event?: string;
    ok?: boolean;
    promptVersion?: string;
    latencyMs?: number;
    bytes?: number;
  }
> {
  return stderrSpy.mock.calls
    .map((c) => String(c[0]).trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}
