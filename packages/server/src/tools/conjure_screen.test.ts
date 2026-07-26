import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./create_project.js";
import { LocalFsKitStore } from "../store/local.js";
import { isSafeKitId } from "../store/kit-files.js";
import {
  CONJURE_SCREEN_TOOL_NAME,
  LocalScaffoldScreenGenerator,
  conjureScreen,
  deriveScreenTitle,
  promptRequiresKit,
  registerConjureScreenTool,
  uniqueScreenId,
} from "./conjure_screen.js";
import type {
  ConjureScreenDeps,
  ScreenGenerationRequest,
  ScreenGenerator,
} from "./conjure_screen.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-conjure-projects-"));
}

async function tempKitsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-conjure-kits-"));
}

/**
 * A stub generator that records the request it was handed and returns a fixed,
 * inspectable artifact set. Lets us assert *what the tool resolved* (kit, id,
 * path, blueprint) without depending on the real scaffold's bytes (AC8 — no
 * model call).
 */
function stubGenerator(): ScreenGenerator & { calls: ScreenGenerationRequest[] } {
  const calls: ScreenGenerationRequest[] = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      return {
        files: [
          {
            path: request.entryPath,
            content: `// stub for ${request.screenId}`,
            encoding: "utf-8",
          },
        ],
        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33, costUsd: 0.001 },
      };
    },
  };
}

/**
 * Build a ready-to-conjure fixture: a real kit store + project store, and a stub
 * generator. `kitBindings` seeds the project's bindings so we can drive the
 * explicit/default/sole/none resolution branches.
 */
async function fixture(
  options: {
    kitBindings?: { kitId: string; default?: boolean }[];
    kits?: { name: string; id: string }[];
    kind?: "workspace" | "blueprint";
  } = {},
): Promise<{
  deps: ConjureScreenDeps & { generator: ReturnType<typeof stubGenerator> };
  store: ProjectStore;
  kitStore: LocalFsKitStore;
  projectId: string;
}> {
  const kitStore = new LocalFsKitStore(await tempKitsRoot());
  for (const kit of options.kits ?? []) {
    await kitStore.createKit(kit.name, kit.id);
  }
  const store = new ProjectStore(await tempProjectsRoot(), kitStore);
  const { projectId } = await store.createProject({
    name: "Marketing Site",
    kind: options.kind ?? "workspace",
    kitBindings: options.kitBindings,
  });
  const generator = stubGenerator();
  return { deps: { projectStore: store, kitStore, generator }, store, kitStore, projectId };
}

let testClient: Client | null = null;

async function connectClient(deps: ConjureScreenDeps): Promise<Client> {
  const server = new McpServer({ name: "genie-test", version: "0" });
  registerConjureScreenTool(server, deps);
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  testClient = client;
  return client;
}

interface ToolText {
  type: string;
  text: string;
}

function errorPayload(result: { content?: unknown }): {
  code: string;
  message: string;
  projectId?: string;
  kitId?: string;
} {
  const text = (result.content as ToolText[])[0]?.text ?? "";
  return JSON.parse(text);
}

afterEach(async () => {
  if (testClient) {
    await testClient.close();
    testClient = null;
  }
  vi.restoreAllMocks();
});

// ── promptRequiresKit heuristic (AC4 vs AC5 boundary) ─────────────────────────

describe("promptRequiresKit", () => {
  it("is true when the prompt names kit-level component nouns", () => {
    expect(promptRequiresKit("A checkout page with a primary Button and a Card")).toBe(true);
    expect(promptRequiresKit("Add a modal dialog for confirmation")).toBe(true);
    expect(promptRequiresKit("A form with an input and a select dropdown")).toBe(true);
  });

  it("is true when the prompt explicitly invokes the kit / component library", () => {
    expect(promptRequiresKit("Lay out a hero using the kit")).toBe(true);
    expect(promptRequiresKit("Build the page from the component library")).toBe(true);
  });

  it("is false for basic structural / layout prompts (AC5)", () => {
    expect(promptRequiresKit("A landing page with a header, hero section and footer")).toBe(false);
    expect(promptRequiresKit("A two-column responsive page layout with a sidebar region")).toBe(
      false,
    );
    expect(promptRequiresKit("An about page with three stacked sections")).toBe(false);
  });

  it("matches component nouns only as whole words (no substring false-positives)", () => {
    // "information" contains "form", "platform" contains "form", "throughput"
    // contains "input" — none should trip the kit requirement.
    expect(promptRequiresKit("A page describing our platform and information architecture")).toBe(
      false,
    );
    expect(promptRequiresKit("A dashboard summarizing throughput over time")).toBe(false);
  });

  it("matches singular and plural component nouns", () => {
    expect(promptRequiresKit("Two buttons side by side")).toBe(true);
    expect(promptRequiresKit("A grid of cards")).toBe(true);
  });
});

// ── id / title derivation ─────────────────────────────────────────────────────

describe("deriveScreenTitle / uniqueScreenId", () => {
  it("uses the first non-empty prompt line, collapsed and capped", () => {
    expect(deriveScreenTitle("\n  Checkout page  \nmore detail")).toBe("Checkout page");
    const long = "x".repeat(200);
    expect(deriveScreenTitle(long).length).toBeLessThanOrEqual(80);
  });

  it("falls back to 'Screen' for an unusable prompt", () => {
    expect(deriveScreenTitle("   \n  ")).toBe("Screen");
  });

  it("produces a slug id and disambiguates against existing screens", () => {
    expect(uniqueScreenId([], "Checkout Page")).toBe("checkout-page");
    const existing = [{ id: "checkout-page", path: "p", title: "t", updatedAt: "u" }];
    expect(uniqueScreenId(existing, "Checkout Page")).toBe("checkout-page-2");
  });

  it("falls back to 'screen' when a title has no slug-able characters", () => {
    expect(uniqueScreenId([], "!!!")).toBe("screen");
  });
});

// ── conjureScreen (standalone) — resolution ladder + validation ───────────────

describe("conjureScreen (standalone function)", () => {
  it("rejects malformed args before touching the store", async () => {
    const { deps } = await fixture();
    // short prompt (<8), bad projectId, unknown extra key, bad framework
    await expect(conjureScreen(deps, { projectId: "ab", prompt: "too short" })).rejects.toThrow();
    await expect(
      conjureScreen(deps, { projectId: "marketing-site", prompt: "short" }),
    ).rejects.toThrow();
    await expect(
      conjureScreen(deps, {
        projectId: "marketing-site",
        prompt: "a valid length prompt",
        extra: 1,
      }),
    ).rejects.toThrow();
    await expect(
      conjureScreen(deps, {
        projectId: "marketing-site",
        prompt: "a valid length prompt",
        framework: "svelte",
      }),
    ).rejects.toThrow();
  });

  it("AC3 (explicit) — uses an explicitly named kitId over the project default", async () => {
    const { deps, projectId } = await fixture({
      kits: [
        { name: "Default Kit", id: "default-kit" },
        { name: "Explicit Kit", id: "explicit-kit" },
      ],
      kitBindings: [{ kitId: "default-kit", default: true }, { kitId: "explicit-kit" }],
    });

    await conjureScreen(deps, {
      projectId,
      prompt: "A dashboard with a data table and cards",
      kitId: "explicit-kit",
    });

    expect(deps.generator.calls[0]?.kit).toEqual({ kitId: "explicit-kit", via: "explicit" });
  });

  it("AC3 (default) — falls back to the project's default kit when none is named", async () => {
    const { deps, projectId } = await fixture({
      kits: [
        { name: "Default Kit", id: "default-kit" },
        { name: "Other Kit", id: "other-kit" },
      ],
      kitBindings: [{ kitId: "default-kit", default: true }, { kitId: "other-kit" }],
    });

    await conjureScreen(deps, { projectId, prompt: "A settings page with a form and inputs" });

    expect(deps.generator.calls[0]?.kit).toEqual({ kitId: "default-kit", via: "default" });
  });

  it("AC3 (sole) — uses the sole reachable binding when there is no default", async () => {
    const { deps, projectId } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });

    await conjureScreen(deps, { projectId, prompt: "A pricing page with cards and buttons" });

    expect(deps.generator.calls[0]?.kit).toEqual({ kitId: "only-kit", via: "sole" });
  });

  it("AC4 — a kit-specific prompt with no resolvable kit raises ERR_PROJECT_KIT_REQUIRED", async () => {
    const { deps, projectId } = await fixture(); // no bindings
    await expect(
      conjureScreen(deps, { projectId, prompt: "A checkout page with a primary Button and Card" }),
    ).rejects.toMatchObject({ code: "ERR_PROJECT_KIT_REQUIRED", projectId });
    // Nothing was generated or recorded.
    expect(deps.generator.calls).toHaveLength(0);
  });

  it("AC4 — an ambiguous multi-kit project with no default also raises ERR_PROJECT_KIT_REQUIRED", async () => {
    const { deps, projectId } = await fixture({
      kits: [
        { name: "Kit A", id: "kit-a" },
        { name: "Kit B", id: "kit-b" },
      ],
      kitBindings: [{ kitId: "kit-a" }, { kitId: "kit-b" }], // two bound, no default
    });
    await expect(
      conjureScreen(deps, { projectId, prompt: "A page with a modal dialog and buttons" }),
    ).rejects.toMatchObject({ code: "ERR_PROJECT_KIT_REQUIRED" });
    expect(deps.generator.calls).toHaveLength(0);
  });

  it("AC5 — a basic-structure prompt with no kit generates a kitless (null) scaffold", async () => {
    const { deps, projectId, store } = await fixture(); // no bindings
    const result = await conjureScreen(deps, {
      projectId,
      prompt: "A landing page with a header, a hero section, and a footer",
    });

    // Generated against a null kit — no invented kit (AC5).
    expect(deps.generator.calls[0]?.kit).toBeNull();
    expect(result.files.length).toBeGreaterThan(0);
    // And it was still recorded.
    const detail = await store.getProject(projectId);
    expect(detail.screens).toHaveLength(1);
  });

  it("AC6 — seeds from a blueprint when blueprintId is given", async () => {
    const { deps, store } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    const blueprint = await store.createProject({ name: "Starter Blueprint", kind: "blueprint" });
    const workspace = await store.createProject({ name: "Derived Workspace", kind: "workspace" });

    // Bind a kit on the workspace so resolution succeeds independent of the seed.
    await store.bindKit({ projectId: workspace.projectId, kitId: "only-kit", default: true });

    await conjureScreen(deps, {
      projectId: workspace.projectId,
      prompt: "A hero section seeded from the starter",
      blueprintId: blueprint.projectId,
    });

    expect(deps.generator.calls[0]?.blueprint).toEqual({ id: blueprint.projectId });
  });

  it("AC6 — a non-existent or non-blueprint blueprintId raises ERR_BLUEPRINT_NOT_FOUND", async () => {
    const { deps, projectId, store } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    // missing blueprint
    await expect(
      conjureScreen(deps, {
        projectId,
        prompt: "A page seeded from nothing",
        blueprintId: "no-such-blueprint",
      }),
    ).rejects.toMatchObject({ code: "ERR_BLUEPRINT_NOT_FOUND" });

    // a workspace is not a blueprint
    const ws = await store.createProject({ name: "Not A Blueprint", kind: "workspace" });
    await expect(
      conjureScreen(deps, {
        projectId,
        prompt: "A page seeded from a workspace",
        blueprintId: ws.projectId,
      }),
    ).rejects.toMatchObject({ code: "ERR_BLUEPRINT_NOT_FOUND" });
  });

  it("AC7 — records the screen in the manifest and returns screenId, files, and usage", async () => {
    const { deps, projectId, store } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });

    const result = await conjureScreen(deps, {
      projectId,
      prompt: "A pricing page with cards",
    });

    expect(result.screenId).toMatch(/^[a-z0-9-]{3,64}$/);
    expect(result.files[0]?.path).toBe(`screens/${result.screenId}/index.tsx`);
    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      costUsd: 0.001,
    });

    const detail = await store.getProject(projectId);
    expect(detail.screens).toEqual([
      {
        id: result.screenId,
        path: `screens/${result.screenId}/index.tsx`,
        title: "A pricing page with cards",
        updatedAt: expect.any(String),
      },
    ]);
    // The recorded reference persisted to disk.
    const raw = JSON.parse(
      await readFile(join(store.root, projectId, ".genie", "project.json"), "utf8"),
    );
    expect(raw.screens).toHaveLength(1);
  });

  it("AC7 — a second conjure appends a second, uniquely-id'd screen", async () => {
    const { deps, projectId, store } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    const first = await conjureScreen(deps, { projectId, prompt: "Checkout page with a table" });
    const second = await conjureScreen(deps, { projectId, prompt: "Checkout page with a table" });

    expect(first.screenId).toBe("checkout-page-with-a-table");
    expect(second.screenId).toBe("checkout-page-with-a-table-2");
    const detail = await store.getProject(projectId);
    expect(detail.screens.map((s) => s.id)).toEqual([first.screenId, second.screenId]);
  });

  it("respects the requested framework in the reserved entry path", async () => {
    const { deps, projectId } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    const result = await conjureScreen(deps, {
      projectId,
      prompt: "A landing page hero section",
      framework: "html",
    });
    expect(result.files[0]?.path).toBe(`screens/${result.screenId}/index.html`);
  });

  it("raises ERR_PROJECT_NOT_FOUND for a missing project (no generation, no record)", async () => {
    const { deps } = await fixture();
    await expect(
      conjureScreen(deps, { projectId: "no-such-project", prompt: "A basic landing page" }),
    ).rejects.toMatchObject({ code: "ERR_PROJECT_NOT_FOUND" });
    expect(deps.generator.calls).toHaveLength(0);
  });

  it("raises ERR_KIT_NOT_FOUND for an explicit kitId that does not exist", async () => {
    const { deps, projectId } = await fixture();
    await expect(
      conjureScreen(deps, {
        projectId,
        prompt: "A dashboard with cards",
        kitId: "ghost-kit",
      }),
    ).rejects.toMatchObject({ code: "ERR_KIT_NOT_FOUND", kitId: "ghost-kit" });
    expect(deps.generator.calls).toHaveLength(0);
  });

  it("raises ERR_PROJECT_READONLY for a read-only project (before any generation)", async () => {
    const { deps, projectId, store } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    await writeFile(join(store.root, projectId, ".genie", ".readonly"), "", "utf8");
    await expect(
      conjureScreen(deps, { projectId, prompt: "A page with cards" }),
    ).rejects.toMatchObject({ code: "ERR_PROJECT_READONLY" });
    expect(deps.generator.calls).toHaveLength(0);
  });
});

// ── LocalScaffoldScreenGenerator (the default M1 generator) ────────────────────

describe("LocalScaffoldScreenGenerator", () => {
  const generator = new LocalScaffoldScreenGenerator();

  function request(overrides: Partial<ScreenGenerationRequest> = {}): ScreenGenerationRequest {
    return {
      projectId: "marketing-site",
      screenId: "hero",
      entryPath: "screens/hero/index.tsx",
      prompt: "A hero section",
      framework: "react",
      model: "design-default",
      kit: null,
      ...overrides,
    };
  }

  it("AC8 — reports zero usage (no model call) and writes the reserved entry path", async () => {
    const result = await generator.generate(request());
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
    expect(result.files[0]?.path).toBe("screens/hero/index.tsx");
  });

  it("AC5 — a kitless scaffold states honestly that no kit was used", async () => {
    const result = await generator.generate(request({ kit: null }));
    expect(result.files[0]?.content).toContain("no UI kit was used");
    expect(result.files[0]?.content).not.toContain("targeting kit");
  });

  it("names the resolved kit + provenance, without claiming it pulled components", async () => {
    const result = await generator.generate(request({ kit: { kitId: "acme-ui", via: "default" } }));
    expect(result.files[0]?.content).toContain('targeting kit "acme-ui"');
    expect(result.files[0]?.content).toContain("resolved via default");
  });

  it("notes a blueprint seed when present", async () => {
    const result = await generator.generate(
      request({ kit: { kitId: "acme-ui", via: "sole" }, blueprint: { id: "starter" } }),
    );
    expect(result.files[0]?.content).toContain('seeded from blueprint "starter"');
  });

  it("is deterministic — the same request yields byte-identical output", async () => {
    const a = await generator.generate(request());
    const b = await generator.generate(request());
    expect(a.files[0]?.content).toBe(b.files[0]?.content);
  });

  it("emits framework-appropriate entry artifacts", async () => {
    const html = await generator.generate(
      request({ framework: "html", entryPath: "s/index.html" }),
    );
    expect(html.files[0]?.content).toContain("<!doctype html>");
    const vue = await generator.generate(request({ framework: "vue", entryPath: "s/index.vue" }));
    expect(vue.files[0]?.content).toContain("<template>");
    const react = await generator.generate(request({ framework: "react" }));
    expect(react.files[0]?.content).toContain("export default function Screen()");
  });

  // ── 🔒 provenance-note injection (the header comment is a sink) ─────────────
  //
  // `renderScaffold` escapes `title` at all four of its sinks (`escapeHtml` ×3,
  // `escapeJsx` ×1) but embedded `note` raw at all three. `note` carries
  // `kitId`, and `isSafeKitId` is a *containment* rule about path segments — it
  // deliberately permits `>` and newlines, neither of which can escape a
  // directory. So a listable kit can carry a comment-terminator into generated
  // source.
  //
  // Attribution, precisely: `KIT_ID_PATTERN` banned these characters *by
  // accident*, as a side effect of being a narrow slug allowlist. #276 widened
  // the gate — correctly — and removed that incidental cover without replacing
  // it. Pre-existing for the `default`/`sole` arms (which `resolveKit` returns
  // raw from persisted bindings, and `create_project`'s `kitBindingShape` gates
  // only with `z.string().min(1)`); a partial #276 regression for `explicit`.
  //
  // The remedy is to escape at the SINK, not to re-narrow the id rule —
  // re-narrowing would re-create the visible-but-unusable defect the whole
  // #276/#279/#281/#283/#286 cycle existed to remove.
  describe("🔒 the provenance note cannot escape its comment", () => {
    // Pinned mechanically rather than asserted in prose: if a future change to
    // `isSafeKitId` were to start rejecting these, THIS is the line that should
    // fail, so the reachability claim above can never quietly go stale.
    const HTML_BREAKOUT = "evil--><img src=x onerror=alert(1)><!--";
    // ECMAScript LineTerminator :: <LF> <CR> <LS> <PS>. All four end a `//`
    // comment — verified by executing each through Node, not read off the spec.
    //
    // Named, rather than interpolated with %j: `JSON.stringify` leaves U+2028 and
    // U+2029 as literal (invisible) characters, so those two cases would render
    // identically in the reporter. When a mutation reds exactly two of these four,
    // "which two" is the whole finding — the names have to carry it.
    const JS_LINE_TERMINATORS = [
      ["LF U+000A", "\n"],
      ["CR U+000D", "\r"],
      ["LS U+2028", "\u2028"],
      ["PS U+2029", "\u2029"],
    ] as const;
    const lineBreakout = (term: string) => `evil${term}alert(1)`;

    it("the payloads really are listable kitIds (reachability, not hypothesis)", () => {
      expect(isSafeKitId(HTML_BREAKOUT)).toBe(true);
      for (const [, term] of JS_LINE_TERMINATORS) {
        expect(isSafeKitId(lineBreakout(term))).toBe(true);
      }
    });

    // `<!-- … -->` can only be closed by a sequence ending in `>`, so "the note
    // contributes no `>`" is a *provable* containment property, not a blocklist.
    it.each(["html", "vue"] as const)("%s — a kitId cannot terminate the comment", async (fw) => {
      const result = await generator.generate(
        request({
          framework: fw,
          entryPath: fw === "html" ? "s/index.html" : "s/index.vue",
          kit: { kitId: HTML_BREAKOUT, via: "explicit" },
        }),
      );
      const content = result.files[0]?.content ?? "";
      const header = content.split("\n").find((l) => l.includes("genie conjure_screen")) ?? "";
      expect(header).not.toBe("");
      // Exactly one terminator, and it is the one we appended.
      expect(header.split("-->").length - 1).toBe(1);
      expect(header.trimEnd().endsWith("-->")).toBe(true);
      // The live markup the payload was trying to smuggle never materialises.
      expect(content).not.toContain("<img src=x onerror=alert(1)>");
      // The note contributes neither `<` nor `>`, so it cannot contribute *any*
      // markup construct — not a terminator, not a nested `<!--`, not a tag.
      // Stated as one property rather than argued per-construct: HTML forbids
      // `<!--` inside comment text (WHATWG §13.1.6), so leaving it would emit a
      // non-conforming document even though no parser in this repo rejects it.
      const note = header.slice(header.indexOf(":") + 1, header.lastIndexOf("-->"));
      expect(note).not.toContain("<");
      expect(note).not.toContain(">");
    });

    // Suggested in review. The string-level assertions above prove the note cannot
    // *terminate* the comment; this proves the artifact a caller actually receives
    // still parses. Independent detector, and a stricter one: under a mutant that
    // drops the escape entirely the SFC does not merely change, it loses its
    // `<template>` block and `@vue/compiler-sfc#parse` raises — which
    // `VueAdapter.renderPreview` turns into a hard rejection. So an unescaped note
    // makes a *listable* kitId render as nothing at all.
    //
    // Dynamically imported exactly as `framework/vue.ts` does it — that module
    // documents `@vue/compiler-sfc` as a heavy transitive graph kept off the hot path.
    it("vue — the generated SFC still parses after escaping (renderable, not just safe)", async () => {
      const { parse } = await import("@vue/compiler-sfc");
      const result = await generator.generate(
        request({
          framework: "vue",
          entryPath: "s/index.vue",
          kit: { kitId: HTML_BREAKOUT, via: "explicit" },
        }),
      );
      const source = result.files[0]?.content ?? "";
      const { descriptor, errors } = parse(source, { filename: "Screen.vue" });
      expect(errors).toHaveLength(0);
      expect(descriptor.template?.content).toContain("<main");
    });

    // A `//` comment runs to the end of the line, so a line terminator inside the
    // note puts attacker text on a live code line.
    //
    // Splitting on the FULL terminator class — not just "\n" — is load-bearing.
    // A "\n"-only split leaves a U+2028 breakout sitting on the same apparent
    // line, so the assertion passes while the scaffold is escapable. That is the
    // shape of false-green this file exists to prevent.
    it.each(JS_LINE_TERMINATORS)(
      "react — a kitId cannot break out of the `//` line comment (terminator %s)",
      async (_name, term) => {
        const result = await generator.generate(
          request({ framework: "react", kit: { kitId: lineBreakout(term), via: "explicit" } }),
        );
        const content = result.files[0]?.content ?? "";
        const lines = content.split(/[\r\n\u2028\u2029]/);
        const headerIdx = lines.findIndex((l) => l.includes("genie conjure_screen"));
        expect(headerIdx).toBeGreaterThanOrEqual(0);
        // The whole note stays on the commented line — nothing spills past it.
        expect(lines[headerIdx]).toContain("alert(1)");
        // No line carries the payload as executable source.
        const uncommented = lines.filter((l) => !l.trimStart().startsWith("//"));
        expect(uncommented.some((l) => l.includes("alert(1)"))).toBe(false);
      },
    );

    it("ordinary kit names stay human-readable (the fix must not entity-noise them)", async () => {
      const result = await generator.generate(
        request({
          framework: "html",
          entryPath: "s/index.html",
          kit: { kitId: "acme-ui", via: "default" },
        }),
      );
      expect(result.files[0]?.content).toContain('targeting kit "acme-ui"');
    });
  });
});

// ── MCP tool registration + wire behavior ──────────────────────────────────────

describe("mcp__genie__conjure_screen", () => {
  it("AC1 — tool name is mcp__genie__conjure_screen", () => {
    expect(CONJURE_SCREEN_TOOL_NAME).toBe("mcp__genie__conjure_screen");
  });

  it("AC2 — registers a strict input schema and an output schema", async () => {
    const { deps } = await fixture();
    const client = await connectClient(deps);
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === CONJURE_SCREEN_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description?.length).toBeLessThanOrEqual(2048);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["projectId", "prompt"],
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["screenId", "files", "usage"],
    });
  });

  it("AC7 — a successful call returns structuredContent with screenId/files/usage", async () => {
    const { deps, projectId } = await fixture({
      kits: [{ name: "Only Kit", id: "only-kit" }],
      kitBindings: [{ kitId: "only-kit" }],
    });
    const client = await connectClient(deps);

    const result = await client.callTool({
      name: CONJURE_SCREEN_TOOL_NAME,
      arguments: { projectId, prompt: "A pricing page with cards" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      screenId: expect.stringMatching(/^[a-z0-9-]{3,64}$/),
      usage: { totalTokens: 33 },
    });
  });

  it("AC4 — surfaces ERR_PROJECT_KIT_REQUIRED as a tool error payload", async () => {
    const { deps, projectId } = await fixture(); // no bindings
    const client = await connectClient(deps);

    const result = await client.callTool({
      name: CONJURE_SCREEN_TOOL_NAME,
      arguments: { projectId, prompt: "A signup page with a form and inputs" },
    });

    expect(result.isError).toBe(true);
    const payload = errorPayload(result);
    expect(payload.code).toBe("ERR_PROJECT_KIT_REQUIRED");
    expect(payload.projectId).toBe(projectId);
  });

  it("surfaces ERR_KIT_NOT_FOUND for a bad explicit kitId as a tool error payload", async () => {
    const { deps, projectId } = await fixture();
    const client = await connectClient(deps);

    const result = await client.callTool({
      name: CONJURE_SCREEN_TOOL_NAME,
      arguments: { projectId, prompt: "A dashboard with cards", kitId: "ghost-kit" },
    });

    expect(result.isError).toBe(true);
    const payload = errorPayload(result);
    expect(payload.code).toBe("ERR_KIT_NOT_FOUND");
    expect(payload.kitId).toBe("ghost-kit");
  });

  it("rejects malformed projectId at the MCP protocol layer", async () => {
    const { deps } = await fixture();
    const client = await connectClient(deps);

    // The SDK surfaces input-schema violations as an isError result, not a
    // throw (same contract the sibling bind_kit test asserts).
    const result = await client.callTool({
      name: CONJURE_SCREEN_TOOL_NAME,
      arguments: { projectId: "AB", prompt: "A valid length prompt here" },
    });
    expect(result.isError).toBe(true);
  });

  it("end-to-end with the real LocalScaffoldScreenGenerator records a fixture screen", async () => {
    // The DoD manual-verification path, automated: real generator, real store.
    const kitStore = new LocalFsKitStore(await tempKitsRoot());
    await kitStore.createKit("Acme UI", "acme-ui");
    const store = new ProjectStore(await tempProjectsRoot(), kitStore);
    const { projectId } = await store.createProject({
      name: "Real Site",
      kind: "workspace",
      kitBindings: [{ kitId: "acme-ui", default: true }],
    });
    const client = await connectClient({
      projectStore: store,
      kitStore,
      generator: new LocalScaffoldScreenGenerator(),
    });

    const result = await client.callTool({
      name: CONJURE_SCREEN_TOOL_NAME,
      arguments: { projectId, prompt: "A dashboard overview with cards", framework: "react" },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      screenId: string;
      files: { path: string; content: string }[];
      usage: { totalTokens: number };
    };
    expect(structured.files[0]?.content).toContain("export default function Screen()");
    expect(structured.usage.totalTokens).toBe(0);

    const detail = await store.getProject(projectId);
    expect(detail.screens.map((s) => s.id)).toContain(structured.screenId);
  });
});
