import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "./server.js";
import { LocalFsKitStore } from "./store/local.js";
import { KitAlreadyExistsError, KIT_TYPE } from "./store/interface.js";
import { slugify, buildKitId } from "./tools/create_kit.js";
import { KIT_ID_PATTERN } from "./tools/get_kit.js";
import { compileManifest } from "./manifest/compiler.js";
import { resolveKitDir } from "./ui/grid-resource.js";

// ────────────────────────────────────────────────────────────
// Unit tests — pure functions
// ────────────────────────────────────────────────────────────
describe("slugify", () => {
  it("lowercases and converts spaces to hyphens", () => {
    expect(slugify("My Cool Kit")).toBe("my-cool-kit");
  });

  it("converts underscores to hyphens", () => {
    expect(slugify("my_cool_kit")).toBe("my-cool-kit");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("a--b")).toBe("a-b");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("-foo-")).toBe("foo");
  });

  it("handles single word", () => {
    expect(slugify("Widgets")).toBe("widgets");
  });

  it("truncates a maximally long name so the id budget still fits", () => {
    // NAME_MAX_LENGTH (64 'a's) slugifies to something short enough that
    // `<slug>-<6-char-hex>` still satisfies KIT_ID_PATTERN's 64-char cap.
    const slug = slugify("a".repeat(64));
    expect(slug.length).toBeLessThanOrEqual(57);
  });

  it("re-trims a trailing hyphen exposed by truncation", () => {
    // The hyphen must land as the LAST character kept by `.slice(0,
    // SLUG_MAX_LENGTH)` for this test to actually exercise the re-trim step:
    // 56 'a's (indices 0-55) + '-' (index 56) is exactly SLUG_MAX_LENGTH (57)
    // characters, so the pre-retrim slice ends in '-' and the re-trim must
    // fire to strip it. (An earlier version of this test used 57 'a's before
    // the hyphen, which pushed the hyphen to index 57 — past the slice
    // boundary — so it was silently dropped by `.slice()` itself and the
    // assertion passed without ever touching the re-trim `.replace(/-$/, "")`
    // call; caught by review.)
    const name = "a".repeat(56) + "-" + "b".repeat(10);
    const slug = slugify(name);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("a".repeat(56));
  });
});

describe("buildKitId", () => {
  it("appends a 6-char suffix to the slug", () => {
    const id = buildKitId("My Kit", "abc123");
    expect(id).toBe("my-kit-abc123");
  });

  it("generates a random 6-char suffix when none given", () => {
    const id = buildKitId("Test");
    expect(id).toMatch(/^test-[0-9a-f]{6}$/);
  });

  it("always satisfies KIT_ID_PATTERN, even for a maximally long name", () => {
    // Regression test: buildKitId used to be able to emit ids up to 71
    // chars for a 64-char name, which get_kit/bind_kit's shared
    // KIT_ID_PATTERN (3-64 chars) would then reject — making the kit
    // un-retrievable and un-bindable right after creation.
    const id = buildKitId("a".repeat(64), "abc123");
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(KIT_ID_PATTERN);
  });
});

// ────────────────────────────────────────────────────────────
// LocalFsKitStore tests
// ────────────────────────────────────────────────────────────
describe("LocalFsKitStore", () => {
  let tempDir: string;
  let store: LocalFsKitStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    store = new LocalFsKitStore(join(tempDir, "kits"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the kit directory and writes .kit.json", async () => {
    const kitId = "my-kit-abc123";
    const kit = await store.createKit("My Kit", kitId);

    expect(kit.id).toBe(kitId);
    expect(kit.name).toBe("My Kit");
    expect(kit.type).toBe(KIT_TYPE);
    expect(kit.createdAt).toBeTruthy();

    const kitJson = JSON.parse(await readFile(join(tempDir, "kits", kitId, ".kit.json"), "utf-8"));
    expect(kitJson.id).toBe(kitId);
    expect(kitJson.name).toBe("My Kit");
    expect(kitJson.type).toBe("GENIE_KIT");
    expect(kitJson.createdAt).toBeTruthy();
  });

  it("throws KitAlreadyExistsError on collision", async () => {
    const kitId = "dup-kit-aaaaaa";
    await store.createKit("Dup Kit", kitId);
    await expect(store.createKit("Dup Kit 2", kitId)).rejects.toThrow(KitAlreadyExistsError);
  });
});

// ────────────────────────────────────────────────────────────
// Integration: create_kit via MCP client
// ────────────────────────────────────────────────────────────
describe("create_kit tool (via MCP)", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is listed in tools/list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp__genie__create_kit");
  });

  it("happy path — creates kit and returns kitId", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "My Awesome Kit" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { kitId: string };
    expect(parsed.kitId).toMatch(/^my-awesome-kit-[0-9a-f]{6}$/);

    // Verify directory was created on disk.
    await access(join(tempDir, "kits", parsed.kitId));

    // Verify .kit.json was written with correct metadata.
    const kitJson = JSON.parse(
      await readFile(join(tempDir, "kits", parsed.kitId, ".kit.json"), "utf-8"),
    );
    expect(kitJson.type).toBe("GENIE_KIT");
    expect(kitJson.name).toBe("My Awesome Kit");
    expect(kitJson.id).toBe(parsed.kitId);
  });

  it("scaffolds the viewer's static shell (index.html/viewer.js/viewer.css) into the new kit root — zero manual copying (DRO-764 AC1/AC2)", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Viewer Scaffold Kit" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const { kitId } = JSON.parse(text) as { kitId: string };

    const kitRoot = join(tempDir, "kits", kitId);
    const viewerStaticDir = join(import.meta.dirname, "../../viewer/static");

    for (const asset of ["index.html", "viewer-browse.js", "viewer.js", "viewer.css"]) {
      const [scaffolded, source] = await Promise.all([
        readFile(join(kitRoot, asset)),
        readFile(join(viewerStaticDir, asset)),
      ]);
      expect(
        scaffolded.equals(source),
        `"${asset}" must be byte-identical to packages/viewer/static`,
      ).toBe(true);
    }
  });

  it("a freshly created kit renders the empty-state grid (.ds-empty) with ZERO files touched after creation (DRO-764 AC3)", async () => {
    // The literal AC3 scenario: create_kit, touch nothing else, open the
    // scaffolded index.html. We drive the REAL viewer.js (not a stand-in)
    // through jsdom's `window.eval` — the same harness
    // `viewer/test/grid-renderer.test.ts` uses to test this classic script
    // (DRO-749: it has no ES exports to `import`) — with `fetch` wired to
    // really read the kit's own scaffolded files off disk, so this exercises
    // the true "does the seeded manifest make boot() resolve to .ds-empty"
    // question end-to-end, not a stubbed approximation of it. A real `url`
    // is passed to `JSDOM` (mirroring an actual `file://` navigation)
    // because without one jsdom treats the document as an opaque origin,
    // and some of its internals reach for `localStorage` on first access —
    // which throws for an opaque origin. `file://` is exactly AC3's own
    // vehicle, so this is also more faithful, not just a workaround.
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Fresh Empty-State Kit" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const { kitId } = JSON.parse(text) as { kitId: string };
    const kitRoot = join(tempDir, "kits", kitId);

    const { JSDOM } = await import("jsdom");
    // Both classic scripts index.html loads, in its document order
    // (browse BEFORE core, #253) — the same thing a real file:// navigation
    // does with the scaffolded shell.
    const viewerBrowseJs = await readFile(join(kitRoot, "viewer-browse.js"), "utf-8");
    const viewerJs = await readFile(join(kitRoot, "viewer.js"), "utf-8");
    const dom = new JSDOM(await readFile(join(kitRoot, "index.html"), "utf-8"), {
      runScripts: "outside-only",
      url: `file://${kitRoot}/index.html`,
    });
    const { window } = dom;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__genieViewerTestHooks = {};
    window.eval(viewerBrowseJs);
    window.eval(viewerJs);

    // A `fetch` that reads relative to the kit root, mirroring what a real
    // `file://` navigation's relative-URL resolution does — NOT a stub that
    // hands back canned JSON; it reads the exact bytes create_kit wrote.
    const kitFetch = async (url: string) => {
      const filePath = join(kitRoot, url.toString());
      try {
        const body = await readFile(filePath, "utf-8");
        return new Response(body, { status: 200 });
      } catch {
        return new Response("", { status: 404 });
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__genieViewerTestHooks.boot(window.document, kitFetch);

    // Read plain strings/booleans out of the DOM before asserting — never
    // hand a live DOM node to `expect()`. On a failing assertion, Vitest's
    // diff printer would otherwise try to pretty-print the jsdom `Element`,
    // which can itself throw reaching for jsdom internals; plain values
    // keep the failure message about the actual grid markup instead.
    const grid = window.document.getElementById("grid")!;
    const gridHtml = grid.innerHTML;
    const hasError = grid.querySelector(".ds-error") !== null;
    const emptyEl = grid.querySelector(".ds-empty");
    const hasEmpty = emptyEl !== null;
    const emptyText = (emptyEl?.textContent ?? "").toLowerCase();
    const iframeCount = grid.querySelectorAll("iframe").length;

    expect(hasError, `expected no .ds-error; got: ${gridHtml}`).toBe(false);
    expect(hasEmpty, `expected .ds-empty; got: ${gridHtml}`).toBe(true);
    expect(emptyText).toContain("no components");
    expect(iframeCount).toBe(0);
  });

  it("rejects empty name", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects name with invalid characters", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "bad/name!" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("InvalidKitName");
  });

  it("rejects name exceeding 64 characters", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "a".repeat(65) },
    });
    expect(result.isError).toBe(true);
  });

  it("accepts name with spaces, hyphens, and underscores", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "My Kit_v2-final" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { kitId: string };
    expect(parsed.kitId).toMatch(/^my-kit-v2-final-[0-9a-f]{6}$/);
  });

  it("accepts max-length name (64 chars)", async () => {
    const name = "a".repeat(64);
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name },
    });
    expect(result.isError).toBeFalsy();
  });

  it("creates unique kitIds for the same name", async () => {
    const r1 = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Same Name" },
    });
    const r2 = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Same Name" },
    });
    const id1 = (
      JSON.parse((r1.content as { text: string }[])[0]?.text ?? "{}") as { kitId: string }
    ).kitId;
    const id2 = (
      JSON.parse((r2.content as { text: string }[])[0]?.text ?? "{}") as { kitId: string }
    ).kitId;
    expect(id1).not.toBe(id2);
  });

  it("rejects name consisting only of hyphens", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "---" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("InvalidKitName");
  });

  it("rejects name consisting only of spaces", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "   " },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("InvalidKitName");
  });

  it("rejects name consisting only of underscores", async () => {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "___" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("InvalidKitName");
  });
});

// ────────────────────────────────────────────────────────────
// Kit-identity invariant (#254)
// ────────────────────────────────────────────────────────────
/**
 * Browse's `read_file` and the cross-kit guard both key off the id embedded in a
 * compiled manifest. That works only because `manifest.name` happens to equal the
 * server kit id, and that equality is *incidental* — it falls out of two unrelated
 * lines:
 *
 *   - `LocalFsKitStore.kitDir(id) = join(baseDir, id)`  — the dir is named by the id
 *   - `compileManifest`'s `name: basename(projectRoot)` — the name is read back off
 *     that dir
 *
 * Nothing declares the two must agree. A compiler that took an explicit name, or a
 * store that nested kits one level deeper, would silently decouple them and Browse
 * would start resolving `read_file` against a directory that does not exist. These
 * tests pin the equality across the real chain so such a change fails loudly here
 * instead of in the viewer.
 */
describe("kit identity — manifest.name === kit.id (#254)", () => {
  let tempDir: string;
  let kitsRoot: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-"));
    kitsRoot = join(tempDir, "kits");
    const server = createServer({ kitsRoot });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Create a kit through the real MCP tool and return its server-assigned id. */
  async function createKitViaMcp(name: string): Promise<string> {
    const result = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    return (JSON.parse(text) as { kitId: string }).kitId;
  }

  it("compiles a manifest whose `name` is the server kit id, not the display name", async () => {
    const kitId = await createKitViaMcp("My Fancy Kit");
    const { manifest } = await compileManifest(join(kitsRoot, kitId));

    expect(manifest.name).toBe(kitId);
    // The display name is a *different* field and must not leak into the manifest:
    // "My Fancy Kit" is not a resolvable directory.
    expect(manifest.name).not.toBe("My Fancy Kit");
  });

  it("Browse can resolve the compiled manifest.name straight back to the kit dir", async () => {
    const kitId = await createKitViaMcp("Round Trip Kit");
    const { manifest } = await compileManifest(join(kitsRoot, kitId));

    // This is the exact call Browse's resource handler makes. If `manifest.name`
    // ever stopped being the kit id this returns a path that does not exist (or
    // null, for a name that fails KIT_ID_PATTERN) and every read_file 404s.
    expect(resolveKitDir(kitsRoot, manifest.name)).toBe(join(kitsRoot, kitId));
    await access(join(kitsRoot, kitId, ".kit.json"));
  });

  it("assigns a slug-derived id — the store's randomUUID() fallback is unreachable from create_kit", async () => {
    // create_kit always passes an explicit `buildKitId(name)`, so `createKit`'s
    // `kitId ?? randomUUID()` never fires on this path. A UUID would still satisfy
    // KIT_ID_PATTERN, so the equality above would survive — but the id would stop
    // being human-traceable, which is a regression worth catching.
    const kitId = await createKitViaMcp("Slug Derived");
    expect(kitId).toMatch(/^slug-derived-[0-9a-f]{6}$/);
    expect(kitId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("holds for a name whose slug differs sharply from the display name", async () => {
    // Punctuation/casing/spacing all collapse in the slug, so this is the case
    // where a display-name leak would be most obvious.
    const kitId = await createKitViaMcp("  Weird   NAME  with__spaces  ");
    const { manifest } = await compileManifest(join(kitsRoot, kitId));

    expect(manifest.name).toBe(kitId);
    expect(resolveKitDir(kitsRoot, manifest.name)).toBe(join(kitsRoot, kitId));
  });
});
