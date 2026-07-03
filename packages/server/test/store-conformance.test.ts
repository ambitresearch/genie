/**
 * Store conformance test suite.
 *
 * AC5: Both adapters (LocalFsStore, GitHostStore) pass the same conformance
 * test suite. We define a shared test contract and run it against each adapter.
 *
 * For LocalFsStore: uses real FS in a temp directory.
 * For GitHostStore: uses a mock HTTP server (msw or hand-rolled fetch mock).
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KitStore, ProjectStore } from "../src/store/interface.js";
import {
  FileTooLargeError,
  KitAlreadyExistsError,
  MAX_FILE_BYTES,
  NotFoundError,
} from "../src/store/interface.js";
import { LocalFsKitStore, LocalFsProjectStore } from "../src/store/local.js";

// ─── Shared contract tests ───────────────────────────────────────────────────

/**
 * Seed a file onto a kit's READABLE surface (LocalFs kit dir / git-host default
 * branch) — distinct from `openPlan`, which stages onto an isolated plan
 * branch/dir. Lets the shared contract exercise readFile/listFiles/deleteFile
 * identically on both adapters (DRO-540: the new {content,encoding,mimeType} /
 * {path,size,hash,lastModified} shapes are proven on LocalFs AND GitHost).
 */
type SeedFile = (kitId: string, path: string, content: Buffer | string) => Promise<void>;

function kitStoreContract(
  name: string,
  factory: () => Promise<{
    store: KitStore;
    cleanup: () => Promise<void>;
    seedFile: SeedFile;
  }>,
) {
  describe(`KitStore contract — ${name}`, () => {
    let store: KitStore;
    let cleanup: () => Promise<void>;
    let seedFile: SeedFile;

    beforeEach(async () => {
      const ctx = await factory();
      store = ctx.store;
      cleanup = ctx.cleanup;
      seedFile = ctx.seedFile;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("listKits returns empty array initially", async () => {
      const kits = await store.listKits();
      expect(kits).toEqual([]);
    });

    it("createKit + getKit round-trips", async () => {
      const kit = await store.createKit("test-kit");
      expect(kit.name).toBe("test-kit");
      expect(kit.id).toBeTruthy();
      expect(kit.createdAt).toBeTruthy();

      const fetched = await store.getKit(kit.id);
      expect(fetched.id).toBe(kit.id);
      expect(fetched.name).toBe("test-kit");
    });

    it("createKit throws KitAlreadyExistsError for an explicit id collision", async () => {
      await store.createKit("first kit", "collision-kit-abc123");

      // Trigger the collision exactly once, then assert both facets (error type
      // + carried kitId) against the same settled promise. Awaiting a rejected
      // promise twice is safe and avoids a second createKit call, which on the
      // GitHost adapter would be a redundant repo-create API round-trip.
      const collision = store.createKit("second kit", "collision-kit-abc123");
      await expect(collision).rejects.toThrow(KitAlreadyExistsError);
      await expect(collision).rejects.toMatchObject({
        kitId: "collision-kit-abc123",
      });
    });

    it("createKit preserves the display name when explicit kitId differs", async () => {
      const kit = await store.createKit("Display Kit", "display-kit-abc123");
      expect(kit.name).toBe("Display Kit");

      const fetched = await store.getKit("display-kit-abc123");
      expect(fetched.name).toBe("Display Kit");
    });

    it("listKits returns created kits", async () => {
      await store.createKit("kit-a");
      await store.createKit("kit-b");
      const kits = await store.listKits();
      expect(kits.length).toBe(2);
      const names = kits.map((k) => k.name).sort();
      expect(names).toEqual(["kit-a", "kit-b"]);
    });

    it("getKit throws NotFoundError for non-existent kit", async () => {
      await expect(store.getKit("no-such-kit")).rejects.toThrow(NotFoundError);
    });

    it("listFiles returns files in a kit", async () => {
      const kit = await store.createKit("file-kit");
      // Write files via openPlan
      const planId = await store.openPlan(kit.id, [
        { kind: "write", path: "hello.txt", content: "hello world" },
        { kind: "write", path: "sub/nested.txt", content: "nested" },
      ]);
      await store.closePlan(kit.id, planId);

      // For LocalFsStore, files are only in the plan staging, not the kit itself.
      // The kit directory should list its own files.
      const files = await store.listFiles(kit.id);
      expect(Array.isArray(files)).toBe(true);
    });

    it("readFile rejects files staged in a plan but never committed to the kit", async () => {
      // Both adapters isolate plan staging from the kit's readable surface
      // (LocalFs uses a separate plans dir; GitHost writes to a plan branch
      // rather than the default branch). After closePlan, those files must
      // NOT be visible via readFile on the kit itself.
      const kit = await store.createKit("read-kit");
      const planId = await store.openPlan(kit.id, [
        { kind: "write", path: "test.txt", content: "test content" },
      ]);
      await store.closePlan(kit.id, planId);

      // listFiles still returns an array (may be empty for either adapter
      // depending on whether the plan persisted anything to the kit).
      const files = await store.listFiles(kit.id);
      expect(Array.isArray(files)).toBe(true);

      // readFile must reject for content that was only ever in the plan.
      await expect(store.readFile(kit.id, "test.txt")).rejects.toThrow(NotFoundError);
    });

    it("readFile throws NotFoundError for missing file", async () => {
      const kit = await store.createKit("read-miss-kit");
      await expect(store.readFile(kit.id, "nope.txt")).rejects.toThrow(NotFoundError);
    });

    // AC-SEC (DRO-581): an empty or otherwise-unsafe kitId must never resolve to
    // the kits root (LocalFs) or a stray repo (GitHost) and leak a SIBLING kit's
    // bytes. On LocalFs, `kitDir("")` === the kits root, so a crafted `path`
    // like `victim/secret.txt` would escape into the sibling; on GitHost each
    // kit is its own repo so `""` is simply missing — both adapters must reject
    // identically with NotFoundError and surface none of the secret.
    it("rejects an empty/unsafe kitId instead of reading across sibling kits", async () => {
      const victim = await store.createKit("victim-kit");
      await seedFile(victim.id, "secret.txt", "cross-kit-secret");

      for (const kitId of ["", ".", "..", "a/b", "..\\x"]) {
        // Aim `path` straight at the sibling so a root-resolving kitId WOULD
        // reach it if the guard were absent.
        await expect(store.readFile(kitId, `${victim.id}/secret.txt`)).rejects.toThrow(
          NotFoundError,
        );
        // listFiles shares the same guard.
        await expect(store.listFiles(kitId)).rejects.toThrow(NotFoundError);
      }
    });

    // AC9 — both LocalFsStore and GitHostStore implement listComponents with
    // identical empty/not-found semantics. (Populated-manifest ordering is
    // covered per-adapter: the tool suite for LocalFs, a git-host-specific test
    // below for the git host.)
    it("listComponents returns [] for a kit with no manifest (AC8)", async () => {
      const kit = await store.createKit("no-manifest-kit");
      await expect(store.listComponents({ kitId: kit.id })).resolves.toEqual([]);
    });

    it("listComponents returns [] when the group filter matches nothing (AC8)", async () => {
      const kit = await store.createKit("group-miss-kit");
      await expect(
        store.listComponents({ kitId: kit.id, group: "nope" }),
      ).resolves.toEqual([]);
    });

    it("listComponents throws NotFoundError for a non-existent kit", async () => {
      await expect(
        store.listComponents({ kitId: "ghost-kit" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("openPlan + commitPlan + closePlan lifecycle", async () => {
      const kit = await store.createKit("plan-kit");
      const planId = await store.openPlan(kit.id, [
        { kind: "write", path: "a.txt", content: "initial" },
      ]);
      expect(planId).toBeTruthy();

      // commitPlan adds more ops
      await store.commitPlan(kit.id, planId, [{ kind: "write", path: "b.txt", content: "second" }]);

      // closePlan cleans up
      await store.closePlan(kit.id, planId);

      // closePlan is idempotent
      await store.closePlan(kit.id, planId);
    });

    it("openPlan throws NotFoundError for non-existent kit", async () => {
      await expect(store.openPlan("ghost-kit", [])).rejects.toThrow(NotFoundError);
    });

    it("commitPlan throws NotFoundError for non-existent plan", async () => {
      const kit = await store.createKit("commit-miss-kit");
      await expect(store.commitPlan(kit.id, "no-such-plan", [])).rejects.toThrow(NotFoundError);
    });

    // ── File-content contract (DRO-540) ──────────────────────────────────────
    // readFile → { content, encoding, mimeType }; listFiles → rich entries;
    // deleteFile → { existed }. Run against BOTH adapters so the shapes are
    // byte-identical across LocalFs and GitHost.

    it("readFile returns { content, encoding: 'utf-8', mimeType } for a text file", async () => {
      const kit = await store.createKit("rich-read-kit");
      await seedFile(kit.id, "hello.txt", "hello world");

      const file = await store.readFile(kit.id, "hello.txt");
      expect(file).toEqual({
        content: "hello world",
        encoding: "utf-8",
        mimeType: "text/plain",
      });
    });

    it("readFile returns base64 for a binary file (PNG header)", async () => {
      const kit = await store.createKit("rich-read-bin-kit");
      // PNG magic bytes — a binary MIME (image/png), so the store must base64 it.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await seedFile(kit.id, "icon.png", png);

      const file = await store.readFile(kit.id, "icon.png");
      expect(file.encoding).toBe("base64");
      expect(file.mimeType).toBe("image/png");
      expect(Buffer.from(file.content, "base64").equals(png)).toBe(true);
    });

    it("readFile throws FileTooLargeError above the 256 KiB cap", async () => {
      const kit = await store.createKit("rich-read-big-kit");
      await seedFile(kit.id, "big.bin", "x".repeat(MAX_FILE_BYTES + 1));
      await expect(store.readFile(kit.id, "big.bin")).rejects.toThrow(FileTooLargeError);
    });

    it("listFiles returns rich entries (path + size + sha256 SRI + lastModified)", async () => {
      const kit = await store.createKit("rich-list-kit");
      await seedFile(kit.id, "components/Button.tsx", "export const Button = 1;\n");

      const files = await store.listFiles(kit.id);
      const entry = files.find((f) => f.path === "components/Button.tsx");
      expect(entry).toBeDefined();
      expect(entry!.size).toBe(Buffer.byteLength("export const Button = 1;\n"));
      expect(entry!.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
      // ISO-8601 round-trips.
      expect(new Date(entry!.lastModified).toISOString()).toBe(entry!.lastModified);
      // The .kit.json marker is never surfaced as kit content.
      expect(files.map((f) => f.path)).not.toContain(".kit.json");
    });

    it("deleteFile removes a file (existed: true) then is an idempotent no-op (existed: false)", async () => {
      const kit = await store.createKit("rich-del-kit");
      await seedFile(kit.id, "stale.txt", "stale");

      expect(await store.deleteFile(kit.id, "stale.txt")).toEqual({ existed: true });
      expect((await store.listFiles(kit.id)).map((f) => f.path)).not.toContain("stale.txt");
      // Second delete: already gone → not an error, just existed: false.
      expect(await store.deleteFile(kit.id, "stale.txt")).toEqual({ existed: false });
    });

    it("deleteFile on a file that never existed is existed: false", async () => {
      const kit = await store.createKit("rich-del-absent-kit");
      expect(await store.deleteFile(kit.id, "never-here.txt")).toEqual({ existed: false });
    });

    it("deleteFile on a directory target rejects (parity), leaving its contents intact (DRO-568)", async () => {
      // The parity fix: a directory target is NOT a deletable file, and BOTH
      // adapters must REJECT rather than silently no-op. GitHost previously
      // returned `{ existed: false }` for a directory (contents-API array
      // response) — which the `delete_files` tool routes to `notFoundPaths` (a
      // silent success) — while LocalFs's `unlink` throws → the tool maps it to
      // `DeleteFailed`. That divergence broke the byte-identical cross-adapter
      // parity DRO-540 claimed (RFC G-5). We assert the shared, platform-robust
      // invariant here; the exact errno (EISDIR) is pinned per-adapter below,
      // since the real filesystem yields EISDIR on Linux/CI but EPERM on
      // macOS/BSD, whereas GitHost synthesizes EISDIR deterministically.
      const kit = await store.createKit("dir-target-kit");
      // A nested file makes `adir` a real directory on both surfaces (LocalFs
      // mkdir; GitHost contents-API GET on `adir` returns an array of children).
      await seedFile(kit.id, "adir/inner.txt", "inner");

      let caught: NodeJS.ErrnoException | undefined;
      try {
        await store.deleteFile(kit.id, "adir");
      } catch (e) {
        caught = e as NodeJS.ErrnoException;
      }
      // Must have REJECTED — not resolved to `{ existed: false }`. A resolve
      // would leave `caught` undefined and route the path to `notFoundPaths`.
      expect(caught).toBeDefined();
      // A native-shaped fs error carrying a `code` the tool reads to compose its
      // `DeleteFailed` message — never the silent-retry `{ existed: false }` case.
      expect(caught?.code).toBeTruthy();

      // The failed delete must not have removed the directory's contents.
      expect((await store.listFiles(kit.id)).map((f) => f.path)).toContain("adir/inner.txt");
    });
  });
}

function projectStoreContract(
  name: string,
  factory: () => Promise<{
    store: ProjectStore;
    cleanup: () => Promise<void>;
  }>,
) {
  describe(`ProjectStore contract — ${name}`, () => {
    let store: ProjectStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      store = ctx.store;
      cleanup = ctx.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("listProjects returns empty array initially", async () => {
      const projects = await store.listProjects();
      expect(projects).toEqual([]);
    });

    it("createProject + getProject round-trips", async () => {
      const project = await store.createProject("my-project");
      expect(project.name).toBe("my-project");
      expect(project.id).toBeTruthy();
      expect(project.createdAt).toBeTruthy();

      const fetched = await store.getProject(project.id);
      expect(fetched.id).toBe(project.id);
      expect(fetched.name).toBe("my-project");
    });

    it("listProjects returns created projects", async () => {
      await store.createProject("proj-a");
      await store.createProject("proj-b");
      const projects = await store.listProjects();
      expect(projects.length).toBe(2);
      const names = projects.map((p) => p.name).sort();
      expect(names).toEqual(["proj-a", "proj-b"]);
    });

    it("getProject throws NotFoundError for non-existent project", async () => {
      await expect(store.getProject("no-such-project")).rejects.toThrow(NotFoundError);
    });

    it("deleteProject removes the project", async () => {
      const project = await store.createProject("del-me");
      await store.deleteProject(project.id);
      await expect(store.getProject(project.id)).rejects.toThrow(NotFoundError);
    });

    it("deleteProject throws NotFoundError for non-existent project", async () => {
      await expect(store.deleteProject("nope")).rejects.toThrow(NotFoundError);
    });

    it("bindKit sets kitId on the project", async () => {
      const project = await store.createProject("bind-proj");
      expect(project.kitId).toBeUndefined();
      await store.bindKit(project.id, "some-kit-id");
      const updated = await store.getProject(project.id);
      expect(updated.kitId).toBe("some-kit-id");
    });

    it("bindKit throws NotFoundError for non-existent project", async () => {
      await expect(store.bindKit("ghost", "kit")).rejects.toThrow(NotFoundError);
    });

    it("recordScreen appends screen ref", async () => {
      const project = await store.createProject("screen-proj");
      await store.recordScreen(project.id, "screenshot-001.png");
      await store.recordScreen(project.id, "screenshot-002.png");
      // No direct getter for screens in the interface, but the call should not throw
    });

    it("recordScreen throws NotFoundError for non-existent project", async () => {
      await expect(store.recordScreen("ghost", "img.png")).rejects.toThrow(NotFoundError);
    });
  });
}

// ─── LocalFsStore adapter factory ────────────────────────────────────────────

async function createLocalFsKitFactory() {
  const tmpDir = await mkdtemp(join(tmpdir(), "genie-test-kits-"));

  // Override GENIE_HOME so plans go to our temp dir
  const origHome = process.env["GENIE_HOME"];
  const fakeGenieHome = await mkdtemp(join(tmpdir(), "genie-home-"));
  process.env["GENIE_HOME"] = fakeGenieHome;

  const store = new LocalFsKitStore(tmpDir);
  return {
    store,
    // Seed writes straight into the kit dir — the readable surface listFiles/
    // readFile/deleteFile operate on (vs openPlan, which stages elsewhere).
    seedFile: async (kitId: string, path: string, content: Buffer | string) => {
      const full = join(tmpDir, kitId, ...path.split("/"));
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    },
    cleanup: async () => {
      // Restore env var carefully: assigning `undefined` to process.env coerces
      // to the literal string "undefined" and would leak into other tests.
      if (origHome === undefined) {
        delete process.env["GENIE_HOME"];
      } else {
        process.env["GENIE_HOME"] = origHome;
      }
      await rm(tmpDir, { recursive: true, force: true });
      await rm(fakeGenieHome, { recursive: true, force: true });
    },
  };
}

async function createLocalFsProjectFactory() {
  const tmpDir = await mkdtemp(join(tmpdir(), "genie-test-projects-"));
  const store = new LocalFsProjectStore(tmpDir);
  return {
    store,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// ─── Run conformance tests against LocalFsStore ──────────────────────────────

kitStoreContract("LocalFsKitStore", createLocalFsKitFactory);
projectStoreContract("LocalFsProjectStore", createLocalFsProjectFactory);

// ─── GitHostStore mock factory ───────────────────────────────────────────────

import { GitHostKitStore, GitHostProjectStore } from "../src/store/git-host.js";
import { createMockGitHostFetch } from "./helpers/mock-git-host.js";

/**
 * Mock fetch for GitHostStore conformance tests — the shared in-memory
 * Gitea-shaped REST mock (`test/helpers/mock-git-host.ts`), reused by the
 * createServer store-injection seam test (DRO-523 AC1) so both suites drive one
 * reference host rather than two drifting copies.
 */
function createMockGitHostFactory() {
  return createMockGitHostFetch();
}

async function createGitHostKitFactory() {
  const mockFetch = createMockGitHostFactory();
  // Override global fetch for the test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  const store = new GitHostKitStore({
    baseUrl: "https://mock-git-host.test/api/v1",
    owner: "test-org",
    token: "mock-token",
  });

  return {
    store,
    // Seed onto the DEFAULT branch (no `branch` in the body → the mock writes to
    // the repo's default branch), which is the readable surface readFile/
    // listFiles/deleteFile see — NOT a plan branch. Content is base64, exactly
    // as the real Gitea contents API expects.
    seedFile: async (kitId: string, path: string, content: Buffer | string) => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const base64 = Buffer.from(content).toString("base64");
      const res = await mockFetch(
        `https://mock-git-host.test/api/v1/repos/test-org/${kitId}/contents/${encodedPath}`,
        { method: "POST", body: JSON.stringify({ content: base64 }) },
      );
      if (!res.ok) throw new Error(`seedFile failed: ${res.status}`);
    },
    cleanup: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function createGitHostProjectFactory() {
  const mockFetch = createMockGitHostFactory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  const store = new GitHostProjectStore({
    baseUrl: "https://mock-git-host.test/api/v1",
    owner: "test-org",
    token: "mock-token",
  });

  return {
    store,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// Run conformance tests against GitHostStore
kitStoreContract("GitHostKitStore", createGitHostKitFactory);
projectStoreContract("GitHostProjectStore", createGitHostProjectFactory);

// ─── Adapter-specific tests: GitHostKitStore.listComponents (AC9) ─────────────

describe("GitHostKitStore — listComponents parses a seeded manifest", () => {
  let originalFetch: typeof globalThis.fetch;
  let store: GitHostKitStore;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockGitHostFactory() as typeof fetch;
    store = new GitHostKitStore({
      baseUrl: "https://mock-git-host.test/api/v1",
      owner: "test-org",
      token: "mock-token",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Write a file to the kit's default branch via the mock contents API. */
  async function seedFile(kitId: string, path: string, content: string): Promise<void> {
    const res = await fetch(
      `https://mock-git-host.test/api/v1/repos/test-org/${kitId}/contents/${path}`,
      {
        method: "POST",
        headers: { Authorization: "token mock-token", "Content-Type": "application/json" },
        body: JSON.stringify({ content: Buffer.from(content, "utf-8").toString("base64") }),
      },
    );
    if (!res.ok) throw new Error(`seedFile failed: ${res.status}`);
  }

  it("fetches .genie/manifest.json, parses it, and sorts deterministically (AC6)", async () => {
    const kit = await store.createKit("git-manifest-kit");
    // Deliberately out of AC6 order on disk to prove the store re-sorts.
    const manifest = {
      version: 1,
      components: [
        { name: "Select", group: "forms", path: "forms/select.html", viewport: "desktop", hash: "sha256-c", lastModified: "2026-07-01T00:00:00.000Z" },
        { name: "Button", group: "actions", path: "actions/button.html", viewport: "desktop", hash: "sha256-a", lastModified: "2026-07-01T00:00:00.000Z" },
        { name: "Anchor", group: "actions", path: "actions/anchor.html", viewport: "375x812", hash: "sha256-b", lastModified: "2026-07-01T00:00:00.000Z" },
      ],
    };
    await seedFile(kit.id, ".genie/manifest.json", JSON.stringify(manifest));

    const out = await store.listComponents({ kitId: kit.id });
    expect(out.map((c) => `${c.group}/${c.name}`)).toEqual([
      "actions/Anchor",
      "actions/Button",
      "forms/Select",
    ]);

    // Group filter narrows to the exact group (AC4).
    const actions = await store.listComponents({ kitId: kit.id, group: "actions" });
    expect(actions).toHaveLength(2);
    expect(actions.every((c) => c.group === "actions")).toBe(true);
  });
});

// ─── Adapter-specific tests: LocalFsKitStore ─────────────────────────────────

describe("LocalFsKitStore — adapter-specific", () => {
  let tmpDir: string;
  let genieHomeDir: string;
  let store: LocalFsKitStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "genie-local-kit-"));
    genieHomeDir = await mkdtemp(join(tmpdir(), "genie-home-"));
    process.env["GENIE_HOME"] = genieHomeDir;
    store = new LocalFsKitStore(tmpDir);
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(tmpDir, { recursive: true, force: true });
    await rm(genieHomeDir, { recursive: true, force: true });
  });

  it("AC7 — readFile throws FileTooLargeError for files > 256 KiB", async () => {
    const kit = await store.createKit("big-file-kit");
    // Write a file larger than MAX_FILE_BYTES directly to the kit directory
    const kitDir = join(tmpDir, kit.id);
    const bigContent = "x".repeat(MAX_FILE_BYTES + 1);
    await writeFile(join(kitDir, "big.bin"), bigContent);

    await expect(store.readFile(kit.id, "big.bin")).rejects.toThrow(FileTooLargeError);

    try {
      await store.readFile(kit.id, "big.bin");
    } catch (e) {
      expect(e).toBeInstanceOf(FileTooLargeError);
      const err = e as FileTooLargeError;
      expect(err.actualBytes).toBe(MAX_FILE_BYTES + 1);
      expect(err.message).toContain("262145");
      expect(err.message).toContain("256 KiB");
    }
  });

  it("readFile returns content for files within size limit", async () => {
    const kit = await store.createKit("small-file-kit");
    const kitDir = join(tmpDir, kit.id);
    await writeFile(join(kitDir, "hello.txt"), "hello world");

    const file = await store.readFile(kit.id, "hello.txt");
    expect(file).toEqual({
      content: "hello world",
      encoding: "utf-8",
      mimeType: "text/plain",
    });
  });

  it("listFiles returns rich entries (path + size + SRI hash + lastModified), excluding .kit.json", async () => {
    const kit = await store.createKit("multi-file-kit");
    const kitDir = join(tmpDir, kit.id);
    await mkdir(join(kitDir, "sub"), { recursive: true });
    await writeFile(join(kitDir, "a.txt"), "a");
    await writeFile(join(kitDir, "sub", "b.txt"), "b");

    const files = await store.listFiles(kit.id);
    const paths = files.map((f) => f.path);
    // Paths are kit-root-relative, forward-slash, and .kit.json is hidden.
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub/b.txt");
    expect(paths).not.toContain(".kit.json");

    const a = files.find((f) => f.path === "a.txt")!;
    expect(a.size).toBe(1);
    expect(a.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    // ISO-8601 round-trips.
    expect(new Date(a.lastModified).toISOString()).toBe(a.lastModified);
  });

  it("deleteFile removes a file and is idempotent past an absent one", async () => {
    const kit = await store.createKit("del-file-kit");
    const kitDir = join(tmpDir, kit.id);
    await writeFile(join(kitDir, "gone.txt"), "bye");

    // Present → existed: true, and it disappears from the listing.
    expect(await store.deleteFile(kit.id, "gone.txt")).toEqual({ existed: true });
    expect((await store.listFiles(kit.id)).map((f) => f.path)).not.toContain("gone.txt");

    // Absent (already deleted) → existed: false, a non-error idempotent no-op.
    expect(await store.deleteFile(kit.id, "gone.txt")).toEqual({ existed: false });
  });

  it("listFiles throws NotFoundError for non-existent kit", async () => {
    await expect(store.listFiles("ghost")).rejects.toThrow(NotFoundError);
  });

  it("plan operations stage files in a temp directory", async () => {
    const kit = await store.createKit("plan-staging-kit");
    const planId = await store.openPlan(kit.id, [
      { kind: "write", path: "staged.txt", content: "staged content" },
    ]);
    expect(planId).toBeTruthy();

    // The plan directory should exist under GENIE_HOME/plans
    await store.commitPlan(kit.id, planId, [
      { kind: "write", path: "staged2.txt", content: "more content" },
    ]);

    // Close plan removes the staging dir
    await store.closePlan(kit.id, planId);
  });

  it("readFile denies path traversal attacks", async () => {
    const kit = await store.createKit("traversal-kit");
    await expect(store.readFile(kit.id, "../../etc/passwd")).rejects.toThrow(
      "Path traversal denied",
    );
  });

  it("openPlan denies path traversal in file ops", async () => {
    const kit = await store.createKit("traversal-plan-kit");
    await expect(
      store.openPlan(kit.id, [{ kind: "write", path: "../../../tmp/evil.txt", content: "pwned" }]),
    ).rejects.toThrow("Path traversal denied");
  });
});

// ─── Adapter-specific tests: GitHostKitStore ─────────────────────────────────

describe("GitHostKitStore — adapter-specific", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("treats the repo name as authoritative when .kit.json embeds a divergent id", async () => {
    // Reviewer concern (PR #90): readKitMeta must not trust the `id` field
    // inside .kit.json. If that file is hand-edited or corrupted so its `id`
    // diverges from the repository name, getKit/listKits must still return the
    // repo name — the path every subsequent API call routes through — not the
    // stale embedded id that would resolve to no repo.
    const mockFetch = createMockGitHostFactory();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;

    const store = new GitHostKitStore({
      baseUrl: "https://mock-git-host.test/api/v1",
      owner: "test-org",
      token: "mock-token",
    });

    // Create a kit, then overwrite its .kit.json with a divergent embedded id.
    const kit = await store.createKit("Corrupt Meta Kit", "corrupt-kit-abc123");
    await mockFetch(
      `https://mock-git-host.test/api/v1/repos/test-org/${kit.id}/contents/.kit.json`,
      {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(
            JSON.stringify({
              id: "some-other-id-999999",
              name: "Corrupt Meta Kit",
              type: "GENIE_KIT",
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          ).toString("base64"),
        }),
      },
    );

    const fetched = await store.getKit(kit.id);
    expect(fetched.id).toBe("corrupt-kit-abc123");
    expect(fetched.name).toBe("Corrupt Meta Kit");

    const listed = await store.listKits();
    expect(listed.map((k) => k.id)).toContain("corrupt-kit-abc123");
    expect(listed.map((k) => k.id)).not.toContain("some-other-id-999999");
  });

  it("deleteFile on a directory target throws EISDIR, not a silent no-op (DRO-568)", async () => {
    // The exact-errno pin the shared conformance contract deliberately leaves
    // platform-robust: GitHost synthesizes an EISDIR-shaped error for a
    // directory / non-file target REGARDLESS of host OS, so the `delete_files`
    // tool's `DeleteFailed` message ("Failed to delete \"adir\": EISDIR.") is
    // byte-identical to LocalFs on the Linux/CI path. Regression guard against
    // the old `return { existed: false }` silent no-op that violated the
    // `interface.ts` deleteFile contract (RFC G-5).
    const mockFetch = createMockGitHostFactory();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;

    const store = new GitHostKitStore({
      baseUrl: "https://mock-git-host.test/api/v1",
      owner: "test-org",
      token: "mock-token",
    });

    const kit = await store.createKit("git-dir-del-kit");
    // Seed a nested file so a GET on `adir` returns a contents-API array (dir).
    await mockFetch(
      `https://mock-git-host.test/api/v1/repos/test-org/${kit.id}/contents/adir/inner.txt`,
      {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from("inner", "utf-8").toString("base64"),
        }),
      },
    );

    await expect(store.deleteFile(kit.id, "adir")).rejects.toMatchObject({
      code: "EISDIR",
    });
    // The directory's contents survive the rejected delete.
    expect((await store.listFiles(kit.id)).map((f) => f.path)).toContain("adir/inner.txt");
  });
});

// ─── GitHostStore credential test (AC6) ──────────────────────────────────────

describe("GitHostStore — credential check (AC6)", () => {
  /**
   * Helper: restore an env var to its original value, deleting it when the
   * original was undefined (assigning `undefined` to process.env coerces to
   * the string "undefined" and leaks into later tests).
   */
  const restoreEnv = (key: string, original: string | undefined) => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  };

  it("fails fast with MissingCredentialError if GENIE_GIT_TOKEN is unset", async () => {
    const origToken = process.env["GENIE_GIT_TOKEN"];
    delete process.env["GENIE_GIT_TOKEN"];
    try {
      const { MissingCredentialError } = await import("../src/store/interface.js");
      const { GitHostKitStore } = await import("../src/store/git-host.js");

      expect(
        () =>
          new GitHostKitStore({
            baseUrl: "https://gitea.example.com/api/v1",
            owner: "test-org",
          }),
      ).toThrow(MissingCredentialError);
    } finally {
      restoreEnv("GENIE_GIT_TOKEN", origToken);
    }
  });

  it("does not throw if GENIE_GIT_TOKEN is set", async () => {
    const origToken = process.env["GENIE_GIT_TOKEN"];
    process.env["GENIE_GIT_TOKEN"] = "test-token-123";
    try {
      const { GitHostKitStore } = await import("../src/store/git-host.js");

      expect(
        () =>
          new GitHostKitStore({
            baseUrl: "https://gitea.example.com/api/v1",
            owner: "test-org",
          }),
      ).not.toThrow();
    } finally {
      restoreEnv("GENIE_GIT_TOKEN", origToken);
    }
  });

  it("accepts token via config without env var", async () => {
    const origToken = process.env["GENIE_GIT_TOKEN"];
    delete process.env["GENIE_GIT_TOKEN"];
    try {
      const { GitHostKitStore } = await import("../src/store/git-host.js");

      expect(
        () =>
          new GitHostKitStore({
            baseUrl: "https://gitea.example.com/api/v1",
            owner: "test-org",
            token: "explicit-token",
          }),
      ).not.toThrow();
    } finally {
      restoreEnv("GENIE_GIT_TOKEN", origToken);
    }
  });
});
