/**
 * Unit tests for the M2-04 `refine` tool (DRO-251) — all 8 ACs, driven by
 * stubbed seams (chat-completion, kit store, region cropper) so no real
 * endpoint, `GENIE_LLM_*` env, kit on disk, or Playwright browser is touched.
 *
 * The stubs mirror `conjure.test.ts`'s capture pattern: the chat stub records
 * every request so the request *shape* (system prompt, current-files inlining,
 * region text, vision crop part, retry feedback) can be asserted independently
 * of whatever component the scripted reply returns.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFINE_TOOL_NAME,
  DEFAULT_MODEL,
  buildUnifiedDiff,
  deriveRenderViewport,
  refine,
  registerRefineTool,
  type LoadedFile,
  type RefineArgs,
  type RefineDeps,
  type RefineKitStore,
  type RegionCropper,
} from "./refine.js";
import type { ChatCompletionInput, ChatCompletionResult } from "../llm/client.js";
import type { ChatCompletionFn } from "../llm/component-response.js";
import type { ValidatedComponent } from "../llm/schema.js";
import { gitBlobHash, loadRefineComponentSystemPrompt } from "../llm/prompts.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A schema-valid component the model "returns" after refining. */
function refinedComponent(overrides: Partial<ValidatedComponent> = {}): ValidatedComponent {
  return {
    componentName: "Button",
    group: "actions",
    files: [
      {
        path: "components/actions/Button/Button.tsx",
        content: "export default function Button() { return null; } // radius: 12px",
        mimeType: "text/tsx",
      },
      {
        path: "components/actions/Button/Button.html",
        content:
          '<!-- @genie group="actions" -->\n<button style="border-radius:12px">Click me</button>',
        mimeType: "text/html",
      },
      {
        path: "components/actions/Button/meta.json",
        content: '{"group":"actions","viewport":{"width":320,"height":140}}',
        mimeType: "application/json",
      },
    ],
    manifestEntry: { viewport: { width: 320, height: 140 }, subtitle: "Primary button" },
    ...overrides,
  };
}

/** The component's CURRENT files, as the kit store would return them (pre-edit:
 * radius 4px). */
function currentFiles(): LoadedFile[] {
  return [
    {
      path: "components/actions/Button/Button.tsx",
      content: "export default function Button() { return null; } // radius: 4px",
      encoding: "utf-8",
      mimeType: "text/tsx",
    },
    {
      path: "components/actions/Button/Button.html",
      content:
        '<!-- @genie group="actions" -->\n<button style="border-radius:4px">Click me</button>',
      encoding: "utf-8",
      mimeType: "text/html",
    },
    {
      path: "components/actions/Button/meta.json",
      content: '{"group":"actions","viewport":{"width":320,"height":140}}',
      encoding: "utf-8",
      mimeType: "application/json",
    },
  ];
}

/** Build a stub `ChatCompletionResult` around a given assistant text payload. */
function completionOf(
  content: string,
  usage = { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
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

/** A stub chat seam returning scripted replies in order, recording requests. */
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

/** A stub kit store backed by a fixed file list. */
function stubKitStore(files: LoadedFile[] = currentFiles()): RefineKitStore & {
  listCalls: string[];
  readCalls: string[];
} {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const listCalls: string[] = [];
  const readCalls: string[] = [];
  return {
    listCalls,
    readCalls,
    async listFiles(kitId: string) {
      listCalls.push(kitId);
      return files.map((f) => ({ path: f.path }));
    },
    async readFile(kitId: string, path: string) {
      readCalls.push(path);
      const f = byPath.get(path);
      if (!f) throw new Error(`no such file ${path}`);
      return f;
    },
  };
}

/** A cropper stub that returns a fixed data URL (or null to model unavailability). */
function stubCropper(dataUrl: string | null): RegionCropper & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async crop(req) {
      calls.push(req);
      return { dataUrl };
    },
  };
}

/** Baseline valid args. */
function args(overrides: Partial<RefineArgs> = {}): Record<string, unknown> {
  return {
    kitId: "acme-kit-a1b2c3",
    componentName: "Button",
    instruction: "make the border radius softer",
    ...overrides,
  };
}

/** Deps with all seams stubbed and no region crop by default. */
function deps(overrides: Partial<RefineDeps> = {}): RefineDeps {
  return {
    kitStore: stubKitStore(),
    chat: stubChat([completionOf(JSON.stringify(refinedComponent()))]),
    cropper: stubCropper(null),
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
  it("is mcp__genie__refine", () => {
    expect(REFINE_TOOL_NAME).toBe("mcp__genie__refine");
  });

  it("registers under that exact name and is discoverable via tools/list", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerRefineTool(server, deps());
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("mcp__genie__refine");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ── AC2 — input schema ────────────────────────────────────────────────────────

describe("AC2 — input", () => {
  it("accepts { kitId, componentName, instruction, region?, model? }", async () => {
    await expect(
      refine(deps(), args({ region: { x: 10, y: 20, w: 30, h: 40 }, model: "design-best" })),
    ).resolves.toBeDefined();
  });

  it("rejects a missing instruction (required)", async () => {
    await expect(
      refine(deps(), { kitId: "acme-kit-a1b2c3", componentName: "Button" }),
    ).rejects.toThrow();
  });

  it("rejects a non-PascalCase componentName", async () => {
    await expect(refine(deps(), args({ componentName: "button" }))).rejects.toThrow();
  });

  it("rejects a malformed region rect (zero width / negative coords)", async () => {
    await expect(
      refine(deps(), args({ region: { x: 0, y: 0, w: 0, h: 10 } as never })),
    ).rejects.toThrow();
    await expect(
      refine(deps(), args({ region: { x: -1, y: 0, w: 10, h: 10 } as never })),
    ).rejects.toThrow();
  });

  it("defaults model to design-default", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(deps({ chat }), args());
    expect(DEFAULT_MODEL).toBe("design-default");
    expect(chat.calls[0]!.model).toBe("design-default");
  });
});

// ── AC3 — loads current files via the kit store ───────────────────────────────

describe("AC3 — loads component files from the kit store", () => {
  it("lists files, then reads each file of the named component (one read per file)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    const kitStore = stubKitStore();
    await refine(deps({ chat, kitStore }), args());
    expect(kitStore.listCalls).toEqual(["acme-kit-a1b2c3"]);
    // One readFile per component file (3 files in the fixture).
    expect(kitStore.readCalls.sort()).toEqual([
      "components/actions/Button/Button.html",
      "components/actions/Button/Button.tsx",
      "components/actions/Button/meta.json",
    ]);
  });

  it("only reads files of the requested component, not siblings in the kit", async () => {
    const files: LoadedFile[] = [
      ...currentFiles(),
      {
        path: "components/actions/Card/Card.tsx",
        content: "// other component",
        encoding: "utf-8",
        mimeType: "text/tsx",
      },
      {
        path: "components/actions/Card/Card.html",
        content: '<!-- @genie group="actions" -->\n<div>card</div>',
        encoding: "utf-8",
        mimeType: "text/html",
      },
    ];
    const kitStore = stubKitStore(files);
    await refine(deps({ kitStore }), args());
    expect(kitStore.readCalls.every((p) => p.includes("/Button/"))).toBe(true);
    expect(kitStore.readCalls.some((p) => p.includes("/Card/"))).toBe(false);
  });

  it("throws ERR_COMPONENT_NOT_FOUND when no files match the component", async () => {
    const kitStore = stubKitStore([
      {
        path: "components/actions/Card/Card.html",
        content: "x",
        encoding: "utf-8",
        mimeType: "text/html",
      },
    ]);
    await expect(refine(deps({ kitStore }), args())).rejects.toMatchObject({
      code: "ERR_COMPONENT_NOT_FOUND",
    });
  });

  it("maps a kit-store listFiles failure (missing kit) to ERR_COMPONENT_NOT_FOUND", async () => {
    const kitStore: RefineKitStore = {
      async listFiles() {
        throw new Error('Kit "acme-kit-a1b2c3" not found.');
      },
      async readFile() {
        throw new Error("unreachable");
      },
    };
    await expect(refine(deps({ kitStore }), args())).rejects.toMatchObject({
      code: "ERR_COMPONENT_NOT_FOUND",
    });
  });
});

// ── AC4 — prompt includes original files + instruction (+ region) ─────────────

describe("AC4 — prompt assembly", () => {
  it("includes the instruction, the original tsx, and the original html in the user message", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(deps({ chat }), args());
    const userMsg = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userMsg).toContain("make the border radius softer");
    expect(userMsg).toContain("radius: 4px"); // original tsx content
    expect(userMsg).toContain("border-radius:4px"); // original html content
  });

  it("loads the real refine system prompt as message[0] (role: system)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(deps({ chat }), args());
    const sys = chat.calls[0]!.messages[0]!;
    expect(sys.role).toBe("system");
    const loaded = loadRefineComponentSystemPrompt();
    expect(sys.content).toBe(loaded.text);
    expect(loaded.file).toBe("refine-component.system.md");
  });

  it("describes the region coordinates in the prompt when a region is given", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(
      deps({ chat, cropper: stubCropper(null) }),
      args({ region: { x: 12, y: 34, w: 56, h: 78 } }),
    );
    const userMsg = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userMsg).toContain("x=12");
    expect(userMsg).toContain("width=56");
  });
});

// ── AC5 — output: unified diff + updated files ────────────────────────────────

describe("AC5 — returns { diff, files }", () => {
  it("returns the full updated files as the source of truth", async () => {
    const res = await refine(deps(), args());
    expect(res.files).toHaveLength(3);
    expect(res.files.find((f) => f.path.endsWith("Button.tsx"))?.content).toContain("radius: 12px");
    expect(res.componentName).toBe("Button");
    expect(res.group).toBe("actions");
  });

  it("returns a unified diff that shows the change (4px → 12px) and only changed files", async () => {
    const res = await refine(deps(), args());
    // The tsx + html changed (4px→12px); meta.json is identical → no hunk for it.
    expect(res.diff).toContain("Button.tsx");
    expect(res.diff).toContain("Button.html");
    expect(res.diff).toContain("-export default function Button() { return null; } // radius: 4px");
    expect(res.diff).toContain(
      "+export default function Button() { return null; } // radius: 12px",
    );
    // meta.json is unchanged, so it should NOT appear as a diff hunk header.
    expect(res.diff).not.toContain("a/components/actions/Button/meta.json");
  });

  it("buildUnifiedDiff emits hunks only for changed/added/removed paths", () => {
    const before = new Map([
      ["a.txt", "one\n"],
      ["keep.txt", "same\n"],
      ["gone.txt", "bye\n"],
    ]);
    const after = new Map([
      ["a.txt", "two\n"],
      ["keep.txt", "same\n"],
      ["new.txt", "hi\n"],
    ]);
    const diff = buildUnifiedDiff(before, after);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("new.txt");
    expect(diff).toContain("gone.txt");
    expect(diff).not.toContain("keep.txt"); // unchanged → omitted
  });

  it("carries an original binary asset forward and omits it from the diff (PR #127 review)", async () => {
    // A binary (base64) file lives in the component dir. It is never sent to the
    // model (can't be inlined as prompt text), so the model's reply omits it.
    // The tool must still return it (no data loss) and must NOT show it as a
    // deleted file in the diff.
    const files: LoadedFile[] = [
      ...currentFiles(),
      {
        path: "components/actions/Button/icon.png",
        content:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        encoding: "base64",
        mimeType: "image/png",
      },
    ];
    const kitStore = stubKitStore(files);
    // The model returns only the text files (as it must — it never saw the png).
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    const res = await refine(deps({ chat, kitStore }), args());

    // The prompt never carried the binary content.
    const userMsg = JSON.stringify(chat.calls[0]!.messages[1]!.content);
    expect(userMsg).toContain("[binary file, base64 — omitted]");
    expect(userMsg).not.toContain("iVBORw0KGgo"); // the base64 bytes stayed out

    // The binary file is preserved in the returned set, byte-for-byte.
    const carried = res.files.find((f) => f.path.endsWith("icon.png"));
    expect(carried).toBeDefined();
    expect(carried?.content).toBe(files.find((f) => f.path.endsWith("icon.png"))!.content);
    expect(carried?.mimeType).toBe("image/png");

    // And it is NOT misreported as deleted (or anything) in the diff.
    expect(res.diff).not.toContain("icon.png");
  });

  it("does not carry a binary forward (or duplicate it) when the model returns that path (PR #128 review)", async () => {
    // The original component has a binary icon.png. This time the model's reply
    // DOES include an icon.png entry (e.g. it was instructed to swap the icon).
    // The `returnedPaths` guard must let the model's entry win — exactly one
    // icon.png in the result, and it's the model's content, not the original's.
    const originalPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const files: LoadedFile[] = [
      ...currentFiles(),
      {
        path: "components/actions/Button/icon.png",
        content: originalPng,
        encoding: "base64",
        mimeType: "image/png",
      },
    ];
    const kitStore = stubKitStore(files);
    // The model returns the standard component PLUS a new icon.png (its own bytes).
    const modelPng = "REPLACED_ICON_BYTES_BASE64==";
    const withIcon = refinedComponent({
      files: [
        ...refinedComponent().files,
        {
          path: "components/actions/Button/icon.png",
          content: modelPng,
          mimeType: "image/png",
        },
      ],
    });
    const chat = stubChat([completionOf(JSON.stringify(withIcon))]);
    const res = await refine(deps({ chat, kitStore }), args());

    // Exactly one icon.png — no duplicate from the carry-forward step.
    const icons = res.files.filter((f) => f.path.endsWith("icon.png"));
    expect(icons).toHaveLength(1);
    // The model's entry wins; the original was NOT re-added over it.
    expect(icons[0]!.content).toBe(modelPng);
    expect(icons[0]!.content).not.toBe(originalPng);
  });
});

// ── AC6 — schema validation + retry once (same as M2-03) ──────────────────────

describe("AC6 — schema validation + retry once", () => {
  it("returns immediately when the first reply validates (no retry)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(deps({ chat }), args());
    expect(chat.calls).toHaveLength(1);
  });

  it("sends response_format json_schema wrapping COMPONENT_SCHEMA", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(deps({ chat }), args());
    const rf = chat.calls[0]!.response_format as {
      type: string;
      json_schema: { name: string; schema: { $id?: string } };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("GenieComponent");
    expect(rf.json_schema.schema.$id).toBe("https://genie.dev/schema/component.schema.json");
  });

  it("retries once with the validation error + prior output appended, then succeeds", async () => {
    const invalid = JSON.stringify({ componentName: "Button", group: "actions", files: [] });
    const chat = stubChat([
      completionOf(invalid),
      completionOf(JSON.stringify(refinedComponent())),
    ]);
    const res = await refine(deps({ chat }), args());
    expect(chat.calls).toHaveLength(2);
    const retryUser = JSON.stringify(chat.calls[1]!.messages[1]!.content);
    expect(retryUser).toContain("failed schema validation");
    expect(retryUser).toContain("previous");
    expect(res.componentName).toBe("Button");
  });

  it("throws RefineError(ERR_LLM_OUTPUT_INVALID) after a second invalid reply", async () => {
    const invalid = JSON.stringify({ nope: true });
    const chat = stubChat([completionOf(invalid), completionOf(invalid)]);
    await expect(refine(deps({ chat }), args())).rejects.toMatchObject({
      code: "ERR_LLM_OUTPUT_INVALID",
    });
    expect(chat.calls).toHaveLength(2); // exactly two attempts, never three
  });

  it("sums usage across the retry attempt", async () => {
    const invalid = JSON.stringify({ nope: true });
    const chat = stubChat([
      completionOf(invalid),
      completionOf(JSON.stringify(refinedComponent())),
    ]);
    const res = await refine(deps({ chat }), args());
    expect(res.usage.totalTokens).toBe(600); // 300 + 300
  });
});

// ── AC7 — region crop via headless-Chromium seam (+ graceful degradation) ─────

describe("AC7 — region cropping", () => {
  it("renders the preview and attaches the crop as a vision image part", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    const cropper = stubCropper("data:image/png;base64,AAAA");
    await refine(deps({ chat, cropper }), args({ region: { x: 5, y: 5, w: 50, h: 30 } }));
    // The cropper was handed the preview html + the region + a viewport.
    expect(cropper.calls).toHaveLength(1);
    const cropReq = cropper.calls[0] as { html: string; region: unknown; viewport: unknown };
    expect(cropReq.html).toContain("border-radius:4px");
    expect(cropReq.region).toEqual({ x: 5, y: 5, w: 50, h: 30 });
    // The user message became a content-parts array with an image_url part.
    const parts = chat.calls[0]!.messages[1]!.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(Array.isArray(parts)).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img?.image_url?.url).toBe("data:image/png;base64,AAAA");
  });

  it("degrades gracefully when the cropper yields no image (Playwright absent)", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    const cropper = stubCropper(null); // simulate Playwright unavailable
    const res = await refine(
      deps({ chat, cropper }),
      args({ region: { x: 5, y: 5, w: 50, h: 30 } }),
    );
    // Still succeeds; the user message stays a plain string (no image part), but
    // the coordinates are described in text so the model can still scope its edit.
    expect(res.componentName).toBe("Button");
    expect(typeof chat.calls[0]!.messages[1]!.content).toBe("string");
    expect(chat.calls[0]!.messages[1]!.content as string).toContain("could not be produced");
  });

  it("does not invoke the cropper at all when no region is given", async () => {
    const cropper = stubCropper("data:image/png;base64,AAAA");
    await refine(deps({ cropper }), args());
    expect(cropper.calls).toHaveLength(0);
  });

  it("deriveRenderViewport uses meta.json viewport but grows to contain the region", () => {
    const files = currentFiles(); // meta viewport 320x140
    // Region fits inside → viewport stays the meta size.
    expect(deriveRenderViewport(files, { x: 0, y: 0, w: 100, h: 50 })).toEqual({
      width: 320,
      height: 140,
    });
    // Region extends beyond → viewport grows to contain it.
    expect(deriveRenderViewport(files, { x: 300, y: 130, w: 100, h: 50 })).toEqual({
      width: 400,
      height: 180,
    });
  });
});

// ── AC8 — per-call structured log ─────────────────────────────────────────────

describe("AC8 — per-call structured log", () => {
  it("logs componentName, hasRegion, model, promptTokens, completionTokens, latencyMs", async () => {
    const chat = stubChat([completionOf(JSON.stringify(refinedComponent()))]);
    await refine(
      deps({ chat }),
      args({ model: "design-best", region: { x: 1, y: 2, w: 3, h: 4 } }),
    );
    const line = stderrLines().find((l) => l.event === "refine" && l.ok === true);
    expect(line).toMatchObject({
      event: "refine",
      ok: true,
      componentName: "Button",
      hasRegion: true,
      model: "design-best",
      promptTokens: 100,
      completionTokens: 200,
    });
    expect(typeof line?.latencyMs).toBe("number");
    expect(Number.isInteger(line?.latencyMs)).toBe(true);
  });

  it("logs hasRegion:false when no region is given", async () => {
    await refine(deps(), args());
    const line = stderrLines().find((l) => l.event === "refine" && l.ok === true);
    expect(line?.hasRegion).toBe(false);
  });

  it("logs the prompt version (git blob hash) on every call", async () => {
    await refine(deps(), args());
    const loaded = loadRefineComponentSystemPrompt();
    expect(loaded.version).toBe(gitBlobHash(loaded.text));
    const line = stderrLines().find((l) => l.event === "refine");
    expect(line?.promptVersion).toBe(loaded.version);
  });

  it("never writes to stdout (stdio transport safety)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await refine(deps(), args());
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

// ── Tool-boundary error mapping ───────────────────────────────────────────────

describe("tool boundary", () => {
  it("maps RefineError to an isError result with a code (not a thrown transport error)", async () => {
    const invalid = JSON.stringify({ nope: true });
    const server = new McpServer({ name: "t", version: "0" });
    registerRefineTool(
      server,
      deps({ chat: stubChat([completionOf(invalid), completionOf(invalid)]) }),
    );
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({ name: REFINE_TOOL_NAME, arguments: args() })) as {
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

  it("maps a missing component to an isError result with ERR_COMPONENT_NOT_FOUND", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerRefineTool(server, deps({ kitStore: stubKitStore([]) }));
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({
        name: REFINE_TOOL_NAME,
        arguments: args({ componentName: "Ghost" }),
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError).toBe(true);
      const payload = JSON.parse(res.content[0]!.text) as { code: string };
      expect(payload.code).toBe("ERR_COMPONENT_NOT_FOUND");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structuredContent on success through the transport", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerRefineTool(server, deps());
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({ name: REFINE_TOOL_NAME, arguments: args() })) as {
        structuredContent?: { componentName: string; diff: string };
      };
      expect(res.structuredContent?.componentName).toBe("Button");
      expect(typeof res.structuredContent?.diff).toBe("string");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse every JSON line the stderr spy captured. */
function stderrLines(): Array<
  Record<string, unknown> & {
    event?: string;
    ok?: boolean;
    hasRegion?: boolean;
    promptVersion?: string;
    latencyMs?: number;
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
