import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalFsStore } from "./local.js";

/** Helper: compute expected SRI hash for content. */
function expectedHash(content: string | Buffer): string {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

describe("LocalFsStore.listFiles", () => {
  let baseDir: string;
  let store: LocalFsStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "genie-test-"));
    store = new LocalFsStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // ── Empty kit ─────────────────────────────────────────────

  it("returns an empty array for a non-existent kit", async () => {
    const files = await store.listFiles("no-such-kit");
    expect(files).toEqual([]);
  });

  it("returns an empty array for an empty kit directory", async () => {
    await mkdir(join(baseDir, "kits", "empty-kit"), { recursive: true });
    const files = await store.listFiles("empty-kit");
    expect(files).toEqual([]);
  });

  // ── Non-empty kit ─────────────────────────────────────────

  it("lists files with correct path, size, hash, and lastModified", async () => {
    const kitDir = join(baseDir, "kits", "my-kit");
    await mkdir(kitDir, { recursive: true });
    const content = "hello world";
    await writeFile(join(kitDir, "index.ts"), content);

    const files = await store.listFiles("my-kit");
    expect(files).toHaveLength(1);

    const f = files[0]!;
    expect(f.path).toBe("index.ts");
    expect(f.size).toBe(Buffer.byteLength(content));
    expect(f.hash).toBe(expectedHash(content));
    expect(f.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
  });

  it("lists nested files with forward-slash-delimited relative paths", async () => {
    const kitDir = join(baseDir, "kits", "nested-kit");
    await mkdir(join(kitDir, "src", "components"), { recursive: true });
    await writeFile(
      join(kitDir, "src", "components", "Button.tsx"),
      "export default () => <button/>",
    );
    await writeFile(join(kitDir, "src", "index.ts"), "export {}");

    const files = await store.listFiles("nested-kit");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/components/Button.tsx");
    expect(paths).toContain("src/index.ts");

    // AC4 — paths are forward-slash-delimited, never absolute
    for (const f of files) {
      expect(f.path).not.toContain("\\");
      expect(f.path).not.toMatch(/^[A-Z]:/); // no Windows absolute
      expect(f.path).not.toMatch(/^\//); // no Unix absolute
    }
  });

  it("sorts files alphabetically by path", async () => {
    const kitDir = join(baseDir, "kits", "sorted-kit");
    await mkdir(kitDir, { recursive: true });
    await writeFile(join(kitDir, "z.ts"), "z");
    await writeFile(join(kitDir, "a.ts"), "a");
    await writeFile(join(kitDir, "m.ts"), "m");

    const files = await store.listFiles("sorted-kit");
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  // ── Hash format (AC5) ─────────────────────────────────────

  it("produces SHA-256 hash in SRI format: sha256-<base64>", async () => {
    const kitDir = join(baseDir, "kits", "hash-kit");
    await mkdir(kitDir, { recursive: true });
    const content = "test content for hashing";
    await writeFile(join(kitDir, "file.txt"), content);

    const files = await store.listFiles("hash-kit");
    const f = files[0]!;
    expect(f.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(f.hash).toBe(expectedHash(content));
  });

  // ── Hidden files (AC6) ────────────────────────────────────

  it("includes hidden (dot-prefixed) files", async () => {
    const kitDir = join(baseDir, "kits", "hidden-kit");
    await mkdir(join(kitDir, ".genie"), { recursive: true });
    await writeFile(join(kitDir, ".genie", "recompile"), "true");
    await writeFile(join(kitDir, ".genie", "sync.json"), "{}");
    await writeFile(join(kitDir, ".hidden"), "secret");

    const files = await store.listFiles("hidden-kit");
    const paths = files.map((f) => f.path);
    expect(paths).toContain(".genie/recompile");
    expect(paths).toContain(".genie/sync.json");
    expect(paths).toContain(".hidden");
  });

  // ── Default excludes (AC7) ────────────────────────────────

  it("excludes node_modules, .git, and dist by default", async () => {
    const kitDir = join(baseDir, "kits", "default-excludes");
    await mkdir(join(kitDir, "node_modules", "foo"), { recursive: true });
    await mkdir(join(kitDir, ".git", "objects"), { recursive: true });
    await mkdir(join(kitDir, "dist"), { recursive: true });
    await mkdir(join(kitDir, "src"), { recursive: true });
    await writeFile(join(kitDir, "node_modules", "foo", "index.js"), "module.exports = {}");
    await writeFile(join(kitDir, ".git", "objects", "abc"), "blob");
    await writeFile(join(kitDir, "dist", "bundle.js"), "compiled");
    await writeFile(join(kitDir, "src", "app.ts"), "const x = 1;");
    await writeFile(join(kitDir, "readme.md"), "# Hello");

    const files = await store.listFiles("default-excludes");
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("node_modules/foo/index.js");
    expect(paths).not.toContain(".git/objects/abc");
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("readme.md");
  });

  // ── .genieignore (AC7 — configurable) ─────────────────────

  it("respects .genieignore for additional exclusions", async () => {
    const kitDir = join(baseDir, "kits", "ignore-kit");
    await mkdir(join(kitDir, "build"), { recursive: true });
    await mkdir(join(kitDir, "src"), { recursive: true });
    await writeFile(join(kitDir, ".genieignore"), "build\n# comment\n\n*.log");
    await writeFile(join(kitDir, "build", "output.js"), "compiled");
    await writeFile(join(kitDir, "src", "index.ts"), "export {}");
    await writeFile(join(kitDir, "debug.log"), "log data");
    await writeFile(join(kitDir, "app.ts"), "const y = 2;");

    const files = await store.listFiles("ignore-kit");
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("build/output.js");
    expect(paths).not.toContain("debug.log"); // *.log glob
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("app.ts");
    // .genieignore itself is included (it's a real file in the kit)
    expect(paths).toContain(".genieignore");
  });
});
