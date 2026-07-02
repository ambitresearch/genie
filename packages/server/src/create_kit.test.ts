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

    const kitJson = JSON.parse(
      await readFile(join(tempDir, "kits", kitId, ".kit.json"), "utf-8"),
    );
    expect(kitJson.id).toBe(kitId);
    expect(kitJson.name).toBe("My Kit");
    expect(kitJson.type).toBe("GENIE_KIT");
    expect(kitJson.createdAt).toBeTruthy();
  });

  it("throws KitAlreadyExistsError on collision", async () => {
    const kitId = "dup-kit-aaaaaa";
    await store.createKit("Dup Kit", kitId);
    await expect(store.createKit("Dup Kit 2", kitId)).rejects.toThrow(
      KitAlreadyExistsError,
    );
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
