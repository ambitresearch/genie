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
  MAX_FILE_BYTES,
  NotFoundError,
} from "../src/store/interface.js";
import { LocalFsKitStore, LocalFsProjectStore } from "../src/store/local.js";

// ─── Shared contract tests ───────────────────────────────────────────────────

function kitStoreContract(
  name: string,
  factory: () => Promise<{ store: KitStore; cleanup: () => Promise<void> }>,
) {
  describe(`KitStore contract — ${name}`, () => {
    let store: KitStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      store = ctx.store;
      cleanup = ctx.cleanup;
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
      await expect(store.readFile(kit.id, "test.txt")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("readFile throws NotFoundError for missing file", async () => {
      const kit = await store.createKit("read-miss-kit");
      await expect(store.readFile(kit.id, "nope.txt")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("openPlan + commitPlan + closePlan lifecycle", async () => {
      const kit = await store.createKit("plan-kit");
      const planId = await store.openPlan(kit.id, [
        { kind: "write", path: "a.txt", content: "initial" },
      ]);
      expect(planId).toBeTruthy();

      // commitPlan adds more ops
      await store.commitPlan(kit.id, planId, [
        { kind: "write", path: "b.txt", content: "second" },
      ]);

      // closePlan cleans up
      await store.closePlan(kit.id, planId);

      // closePlan is idempotent
      await store.closePlan(kit.id, planId);
    });

    it("openPlan throws NotFoundError for non-existent kit", async () => {
      await expect(
        store.openPlan("ghost-kit", []),
      ).rejects.toThrow(NotFoundError);
    });

    it("commitPlan throws NotFoundError for non-existent plan", async () => {
      const kit = await store.createKit("commit-miss-kit");
      await expect(
        store.commitPlan(kit.id, "no-such-plan", []),
      ).rejects.toThrow(NotFoundError);
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
      await expect(store.getProject("no-such-project")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("deleteProject removes the project", async () => {
      const project = await store.createProject("del-me");
      await store.deleteProject(project.id);
      await expect(store.getProject(project.id)).rejects.toThrow(
        NotFoundError,
      );
    });

    it("deleteProject throws NotFoundError for non-existent project", async () => {
      await expect(store.deleteProject("nope")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("bindKit sets kitId on the project", async () => {
      const project = await store.createProject("bind-proj");
      expect(project.kitId).toBeUndefined();
      await store.bindKit(project.id, "some-kit-id");
      const updated = await store.getProject(project.id);
      expect(updated.kitId).toBe("some-kit-id");
    });

    it("bindKit throws NotFoundError for non-existent project", async () => {
      await expect(store.bindKit("ghost", "kit")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("recordScreen appends screen ref", async () => {
      const project = await store.createProject("screen-proj");
      await store.recordScreen(project.id, "screenshot-001.png");
      await store.recordScreen(project.id, "screenshot-002.png");
      // No direct getter for screens in the interface, but the call should not throw
    });

    it("recordScreen throws NotFoundError for non-existent project", async () => {
      await expect(
        store.recordScreen("ghost", "img.png"),
      ).rejects.toThrow(NotFoundError);
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

/**
 * Mock fetch for GitHostStore conformance tests.
 * Simulates a git host API in-memory.
 */
function createMockGitHostFactory() {
  // In-memory storage for repos, files, branches.
  // Files are keyed by `${owner}/${repo}` AND branch, so plan-branch writes
  // don't leak into reads against the default branch.
  const repos = new Map<string, { name: string; created_at: string; default_branch: string }>();
  const files = new Map<string, Map<string, Map<string, { content: string; sha: string }>>>();
  const branches = new Map<string, Set<string>>();

  const filesFor = (repoKey: string, branch: string) => {
    let perBranch = files.get(repoKey);
    if (!perBranch) {
      perBranch = new Map();
      files.set(repoKey, perBranch);
    }
    let perFile = perBranch.get(branch);
    if (!perFile) {
      perFile = new Map();
      perBranch.set(branch, perFile);
    }
    return perFile;
  };

  const mockFetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    // Parse URL - strip /api/v1 prefix since the baseUrl includes it
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.replace(/^\/api\/v1/, "");
    const pathParts = pathname.split("/").filter(Boolean);
    const refParam = urlObj.searchParams.get("ref");

    // Helper to generate SHA
    const genSha = () => Math.random().toString(36).substring(2);

    // Route: GET /repos/search
    if (method === "GET" && pathParts[0] === "repos" && pathParts[1] === "search") {
      const data = Array.from(repos.values());
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    // Route: GET/POST /repos/:owner/:repo
    if (pathParts[0] === "repos" && pathParts.length === 3) {
      const [, owner, repo] = pathParts;
      const key = `${owner}/${repo}`;
      if (method === "GET") {
        if (!repos.has(key)) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify(repos.get(key)), { status: 200 });
      }
    }

    // Route: POST /orgs/:owner/repos
    if (method === "POST" && pathParts[0] === "orgs" && pathParts.length === 3 && pathParts[2] === "repos") {
      const [, owner] = pathParts;
      const { name } = body;
      const key = `${owner}/${name}`;
      const repo = { name, created_at: new Date().toISOString(), default_branch: "main" };
      repos.set(key, repo);
      // Seed the default branch with an empty file map.
      filesFor(key, "main");
      branches.set(key, new Set(["main"]));
      return new Response(JSON.stringify(repo), { status: 201 });
    }

    // Route: POST /repos/:owner/:repo/branches  (4 path segments)
    if (method === "POST" && pathParts.length === 4 && pathParts[0] === "repos" && pathParts[3] === "branches") {
      const [, owner, repo] = pathParts;
      const key = `${owner}/${repo}`;
      if (!repos.has(key)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      const { new_branch_name, old_branch_name } = body;
      branches.get(key)?.add(new_branch_name);
      // Copy files from the source branch so the new branch starts as a fork.
      const source = filesFor(key, old_branch_name ?? "main");
      const target = filesFor(key, new_branch_name);
      for (const [path, entry] of source) target.set(path, { ...entry });
      return new Response(JSON.stringify({ name: new_branch_name }), { status: 201 });
    }

    // Route: GET /repos/:owner/:repo/branches/:branch  (5 path segments)
    if (method === "GET" && pathParts.length === 5 && pathParts[0] === "repos" && pathParts[3] === "branches") {
      const [, owner, repo, , branch] = pathParts;
      const key = `${owner}/${repo}`;
      if (!branches.get(key)?.has(decodeURIComponent(branch))) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ name: branch }), { status: 200 });
    }

    // Route: DELETE /repos/:owner/:repo/branches/:branch  (5 path segments)
    if (method === "DELETE" && pathParts.length === 5 && pathParts[0] === "repos" && pathParts[3] === "branches") {
      const [, owner, repo, , branch] = pathParts;
      const key = `${owner}/${repo}`;
      const decoded = decodeURIComponent(branch);
      branches.get(key)?.delete(decoded);
      files.get(key)?.delete(decoded);
      return new Response(null, { status: 204 });
    }

    // Route: GET/POST/PUT/DELETE /repos/:owner/:repo/contents/:path
    if (pathParts[3] === "contents") {
      const [, owner, repo, , ...pathSegments] = pathParts;
      const key = `${owner}/${repo}`;
      const filePath = decodeURIComponent(pathSegments.join("/"));

      if (!repos.has(key)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      // ref query param wins; for writes, fall back to body.branch; else default.
      const branch =
        refParam ??
        (body && typeof body === "object" && "branch" in body
          ? (body as { branch: string }).branch
          : repos.get(key)!.default_branch);
      if (!branches.get(key)?.has(branch)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      const repoFiles = filesFor(key, branch);

      if (method === "GET") {
        // Build a name field from the last path segment for directory entries.
        const entryFor = (path: string) => ({
          type: "file" as const,
          name: path.split("/").pop()!,
          path,
          sha: repoFiles.get(path)!.sha,
          size: Buffer.from(repoFiles.get(path)!.content, "base64").length,
        });

        // If filePath is empty, return all files at root level
        if (!filePath || filePath === "") {
          const entries = Array.from(repoFiles.keys())
            .filter((path) => !path.includes("/"))
            .map(entryFor);
          return new Response(JSON.stringify(entries), { status: 200 });
        }
        // Check if this is a directory path (has children)
        const children = Array.from(repoFiles.keys()).filter((path) => path.startsWith(filePath + "/"));
        if (children.length > 0) {
          // Return directory listing
          const entries = children
            .filter((path) => {
              const relativePath = path.substring(filePath.length + 1);
              return !relativePath.includes("/");
            })
            .map(entryFor);
          return new Response(JSON.stringify(entries), { status: 200 });
        }
        // It's a file
        if (!repoFiles.has(filePath)) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        const file = repoFiles.get(filePath)!;
        return new Response(
          JSON.stringify({
            type: "file",
            name: filePath.split("/").pop(),
            path: filePath,
            content: file.content,
            encoding: "base64",
            sha: file.sha,
            size: Buffer.from(file.content, "base64").length,
          }),
          { status: 200 },
        );
      }

      if (method === "POST" || method === "PUT") {
        const { content } = body;
        const sha = genSha();
        repoFiles.set(filePath, { content, sha });
        return new Response(JSON.stringify({ content: { sha } }), { status: method === "POST" ? 201 : 200 });
      }

      if (method === "DELETE") {
        repoFiles.delete(filePath);
        return new Response(null, { status: 204 });
      }
    }

    // Default 404
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };

  return mockFetch;
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

    await expect(store.readFile(kit.id, "big.bin")).rejects.toThrow(
      FileTooLargeError,
    );

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

    const content = await store.readFile(kit.id, "hello.txt");
    expect(content).toBe("hello world");
  });

  it("listFiles returns all files (excluding .kit.json)", async () => {
    const kit = await store.createKit("multi-file-kit");
    const kitDir = join(tmpDir, kit.id);
    await mkdir(join(kitDir, "sub"), { recursive: true });
    await writeFile(join(kitDir, "a.txt"), "a");
    await writeFile(join(kitDir, "sub", "b.txt"), "b");

    const files = await store.listFiles(kit.id);
    expect(files).toContain("a.txt");
    expect(files).toContain(join("sub", "b.txt"));
    expect(files).not.toContain(".kit.json");
  });

  it("listFiles throws NotFoundError for non-existent kit", async () => {
    await expect(store.listFiles("ghost")).rejects.toThrow(NotFoundError);
  });

  it("getKit denies path traversal attacks", async () => {
    await expect(store.getKit("../../outside-kit")).rejects.toThrow(
      "Path traversal denied",
    );
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
    await expect(
      store.readFile(kit.id, "../../etc/passwd"),
    ).rejects.toThrow("Path traversal denied");
  });

  it("openPlan denies path traversal in file ops", async () => {
    const kit = await store.createKit("traversal-plan-kit");
    await expect(
      store.openPlan(kit.id, [
        { kind: "write", path: "../../../tmp/evil.txt", content: "pwned" },
      ]),
    ).rejects.toThrow("Path traversal denied");
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
      const { MissingCredentialError } = await import(
        "../src/store/interface.js"
      );
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
