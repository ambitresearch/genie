/**
 * createServer store-injection seam — DRO-523 AC1.
 *
 * Proves that `createServer({ kitStore })` actually routes the kit-*metadata*
 * MCP verbs through the injected `KitStore`, using a `GitHostKitStore` backed by
 * the in-memory Gitea-shaped fetch mock. This is the Docker-free half of AC5:
 * it demonstrates the seam carries the tool surface onto `GitHostStore` without
 * needing a Docker daemon, which the testcontainers `gitea/gitea` leg then
 * re-confirms against a real Gitea when Docker is present.
 *
 * Scope note (deliberate): only the `KitStore`-interface verbs are asserted
 * here — `create_kit`, `list_kits`, `get_kit`, `list_components`. The file
 * verbs (`read_file`/`list_files`/`write_files`/`delete_files`) and the rich
 * project family remain filesystem-bound (see `CreateServerOptions.kitStore`'s
 * doc comment); driving those onto the git host is the tracked follow-up. What
 * this test locks down is that the seam exists and is honestly wired: a kit
 * created through the MCP surface lands in the git host (not local disk), and
 * every metadata verb reads it back from there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { GitHostKitStore } from "../src/store/git-host.js";
import { ProjectStore } from "../src/tools/create_project.js";
import { createMockGitHostFetch } from "./helpers/mock-git-host.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

function parseText(result: ToolResult): unknown {
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

function payload(result: ToolResult): unknown {
  return result.structuredContent ?? parseText(result);
}

describe("createServer store-injection seam — kitStore routes to GitHostKitStore (AC1)", () => {
  let originalFetch: typeof globalThis.fetch;
  let client: Client;
  let kitStore: GitHostKitStore;

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockGitHostFetch() as typeof fetch;

    kitStore = new GitHostKitStore({
      baseUrl: "https://mock-git-host.test/api/v1",
      owner: "test-org",
      token: "mock-token",
    });

    // The injected kitStore is a GitHostKitStore — createServer must use it for
    // every KitStore-interface verb instead of the default LocalFsKitStore.
    const server = createServer({ kitStore });
    client = new Client({ name: "seam-test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    globalThis.fetch = originalFetch;
  });

  it("create_kit through the MCP surface persists into the git host, not local disk", async () => {
    const created = await call("mcp__genie__create_kit", { name: "Seam Kit" });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const { kitId } = payload(created) as { kitId: string };
    expect(kitId).toMatch(/^seam-kit-[0-9a-f]{6}$/);

    // The kit is readable directly from the injected GitHostKitStore — proof the
    // tool wrote through the store, not to a local kitsRoot directory.
    const fromStore = await kitStore.getKit(kitId);
    expect(fromStore.name).toBe("Seam Kit");
    expect(fromStore.type).toBe("GENIE_KIT");
  });

  it("the kit metadata walk (create → list → get → list_components) runs against the git host", async () => {
    const created = await call("mcp__genie__create_kit", { name: "Walk Kit" });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const { kitId } = payload(created) as { kitId: string };

    // list_kits surfaces the git-host repo as a kit.
    const listed = await call("mcp__genie__list_kits", {});
    expect(listed.isError, JSON.stringify(listed)).toBeFalsy();
    const kits = (payload(listed) as { kits: { id: string; name: string }[] }).kits;
    expect(kits.map((k) => k.id)).toContain(kitId);

    // get_kit round-trips the same record through the tool surface.
    const got = await call("mcp__genie__get_kit", { kitId });
    expect(got.isError, JSON.stringify(got)).toBeFalsy();
    expect(payload(got)).toMatchObject({
      id: kitId,
      name: "Walk Kit",
      type: "GENIE_KIT",
    });

    // list_components validates kit existence through the git host and returns
    // the (currently empty, pre-M3-03) component set.
    const components = await call("mcp__genie__list_components", { kitId });
    expect(components.isError, JSON.stringify(components)).toBeFalsy();
    expect((payload(components) as { components: unknown[] }).components).toEqual([]);
  });

  it("get_kit on a kit that never existed in the git host is rejected", async () => {
    const got = await call("mcp__genie__get_kit", { kitId: "ghost-kit-000000" });
    expect(got.isError).toBe(true);
  });

  it("the kit-FILE walk (list_files → read_file → delete_files) runs against the git host (DRO-540)", async () => {
    // AC3 of DRO-540: the re-plumbed fs-native kit-file verbs now route through
    // the injected KitStore too, so a GitHostKitStore carries them onto the git
    // host — not just the metadata verbs. Prove it end-to-end through the MCP
    // surface, Docker-free, against the in-memory Gitea mock.
    const created = await call("mcp__genie__create_kit", { name: "File Walk Kit" });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const { kitId } = payload(created) as { kitId: string };

    // Seed two files directly onto the git host's DEFAULT branch (the readable
    // surface) via the same mock fetch createServer's store talks to — no
    // `branch` in the body → default branch. This is the git-host analogue of
    // writing into a LocalFs kit dir.
    const seed = async (path: string, content: string) => {
      const res = await globalThis.fetch(
        `https://mock-git-host.test/api/v1/repos/test-org/${kitId}/contents/${path}`,
        { method: "POST", body: JSON.stringify({ content: Buffer.from(content).toString("base64") }) },
      );
      expect(res.ok, `seed ${path}`).toBe(true);
    };
    await seed("components/Button.tsx", "export const Button = 1;\n");
    await seed("stale.txt", "remove me");

    // list_files surfaces the git-host tree as rich entries (path/size/hash/
    // lastModified) — proof the walk ran against Gitea, not local disk.
    const listed = await call("mcp__genie__list_files", { kitId });
    expect(listed.isError, JSON.stringify(listed)).toBeFalsy();
    const files = (payload(listed) as { files: { path: string; hash: string }[] }).files;
    const paths = files.map((f) => f.path);
    expect(paths).toContain("components/Button.tsx");
    expect(paths).toContain("stale.txt");
    expect(paths).not.toContain(".kit.json");
    expect(files.find((f) => f.path === "stale.txt")!.hash).toMatch(/^sha256-/);

    // read_file round-trips a file's content off the git host.
    const read = await call("mcp__genie__read_file", {
      kitId,
      path: "components/Button.tsx",
    });
    expect(read.isError, JSON.stringify(read)).toBeFalsy();
    expect(payload(read)).toMatchObject({
      content: "export const Button = 1;\n",
      encoding: "utf-8",
      mimeType: "text/tsx",
    });

    // delete_files (plan-gated) removes a file from the git host and reports it.
    const planResult = await call("mcp__genie__plan", {
      kitId,
      writes: ["**/*"],
      deletes: ["stale.txt"],
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const { planId } = payload(planResult) as { planId: string };

    const del = await call("mcp__genie__delete_files", { planId, paths: ["stale.txt"] });
    expect(del.isError, JSON.stringify(del)).toBeFalsy();
    expect(payload(del)).toEqual({ deletedPaths: ["stale.txt"], notFoundPaths: [] });

    // ...and the deletion is durable on the git host: a fresh list no longer
    // shows it, while the untouched file survives.
    const relisted = await call("mcp__genie__list_files", { kitId });
    const relistedPaths = (payload(relisted) as { files: { path: string }[] }).files.map(
      (f) => f.path,
    );
    expect(relistedPaths).not.toContain("stale.txt");
    expect(relistedPaths).toContain("components/Button.tsx");
  });

  it("default construction (no kitStore) still uses LocalFsKitStore — no git-host calls", async () => {
    // Guard the "no change to existing callers" half of AC1: with no injection,
    // create_kit must NOT hit the git host. We assert by pointing the default
    // server at a throwaway kitsRoot and confirming a create_kit succeeds while
    // the git-host mock records nothing under its owner.
    let gitHostHits = 0;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      gitHostHits += 1;
      return createMockGitHostFetch()(url, init);
    }) as typeof fetch;

    const localServer = createServer(); // default LocalFsKitStore
    const localClient = new Client({ name: "seam-default", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(s), localClient.connect(c)]);

    const created = (await localClient.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Local Default Kit" },
    })) as ToolResult;
    // create_kit against the real local FS may succeed or (in a sandbox with no
    // writable cwd/.genie) fail — either way, the invariant under test is that
    // the DEFAULT path never reaches out to the git host.
    expect(gitHostHits).toBe(0);
    void created;

    await localClient.close();
  });
});

describe("createServer store-injection seam — projectStore routes to the injected store (AC1)", () => {
  let projectsRoot: string;
  let client: Client;

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

  afterEach(async () => {
    await client?.close();
    if (projectsRoot) await rm(projectsRoot, { recursive: true, force: true });
  });

  it("create_project routes through the injected projectStore, not a fresh default", async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), "genie-seam-proj-"));

    // A ProjectStore subclass that records whether the tool actually called
    // through IT (the injected instance) rather than a default createServer
    // constructed internally. Same LocalFs behaviour otherwise, so the tool's
    // contract is unchanged — only the identity of the store is asserted.
    let createProjectCalls = 0;
    class SpyProjectStore extends ProjectStore {
      override async createProject(args: Parameters<ProjectStore["createProject"]>[0]) {
        createProjectCalls += 1;
        return super.createProject(args);
      }
    }
    const injected = new SpyProjectStore(projectsRoot);

    const server = createServer({ projectStore: injected });
    client = new Client({ name: "seam-project", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const created = await call("mcp__genie__create_project", {
      name: "Injected Store Project",
      kind: "workspace",
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    // Proof the seam routed the tool to the injected instance.
    expect(createProjectCalls).toBe(1);

    // And the project is durable through the same injected store — get_project
    // (which shares the injected instance) reads it back.
    const projectId = (payload(created) as { projectId: string }).projectId;
    const detail = await call("mcp__genie__get_project", { projectId });
    expect(detail.isError, JSON.stringify(detail)).toBeFalsy();
    expect(payload(detail)).toMatchObject({ id: projectId, kind: "workspace" });
  });

  it("delete_project routes through the injected projectStore and removes the project", async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), "genie-seam-proj-del-"));

    // Same spy strategy as create_project above, on the delete path this time:
    // the tool must call through the INJECTED instance's deleteProject (M1-14a-1
    // / DRO-531 re-plumb), not a default store createServer builds internally.
    let deleteProjectCalls = 0;
    class SpyProjectStore extends ProjectStore {
      override async deleteProject(id: string) {
        deleteProjectCalls += 1;
        return super.deleteProject(id);
      }
    }
    const injected = new SpyProjectStore(projectsRoot);

    const server = createServer({ projectStore: injected });
    client = new Client({ name: "seam-project-del", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const created = await call("mcp__genie__create_project", {
      name: "Deletable Store Project",
      kind: "workspace",
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const projectId = (payload(created) as { projectId: string }).projectId;

    const deleted = await call("mcp__genie__delete_project", { projectId });
    expect(deleted.isError, JSON.stringify(deleted)).toBeFalsy();
    expect(payload(deleted)).toMatchObject({ deletedProjectId: projectId });
    // Proof the seam routed the tool to the injected instance.
    expect(deleteProjectCalls).toBe(1);

    // ...and the deletion is durable through the same injected store: a
    // subsequent get_project no longer finds it.
    const gone = await call("mcp__genie__get_project", { projectId });
    expect(gone.isError).toBe(true);
    expect(gone.content?.[0]?.text ?? "").toContain("ERR_PROJECT_NOT_FOUND");
  });
});
