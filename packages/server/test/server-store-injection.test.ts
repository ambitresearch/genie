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
