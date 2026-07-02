import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectStore, ProjectStoreError } from "./create_project.js";
import { LocalFsKitStore } from "../store/local.js";
import { KIT_TYPE } from "../store/interface.js";
import type { KitStore } from "../store/interface.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-projects-"));
}

async function tempKitsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-kits-"));
}

async function readProjectManifest(
  root: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, projectId, ".genie", "project.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("ProjectStore", () => {
  it("listProjects returns [] when no projects exist", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);

    await expect(store.listProjects()).resolves.toEqual([]);
  });

  it("creates a blank workspace with a workspace manifest", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);

    const result = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

    expect(result.projectId).toBe("checkout-flow");
    await expect(readProjectManifest(root, "checkout-flow")).resolves.toMatchObject({
      id: "checkout-flow",
      name: "Checkout Flow",
      kind: "workspace",
      kitBindings: [],
    });
  });

  it("creates a blank blueprint with a blueprint manifest", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);

    const result = await store.createProject({ name: "Admin Starter", kind: "blueprint" });

    expect(result.projectId).toBe("admin-starter");
    await expect(readProjectManifest(root, "admin-starter")).resolves.toMatchObject({
      id: "admin-starter",
      name: "Admin Starter",
      kind: "blueprint",
      kitBindings: [],
    });
  });

  it("listProjects returns workspace and blueprint summaries sorted by kind, name, then id", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const workspace = await store.createProject({
      name: "Checkout Flow",
      kind: "workspace",
      kitBindings: [{ kitId: "commerce-kit", default: true }],
    });
    const blueprint = await store.createProject({
      name: "Admin Starter",
      kind: "blueprint",
      kitBindings: [{ kitId: "base-kit" }],
    });

    await expect(store.listProjects()).resolves.toEqual([
      {
        id: blueprint.projectId,
        name: "Admin Starter",
        kind: "blueprint",
        kitBindings: [{ kitId: "base-kit" }],
        updatedAt: expect.any(String),
        canEdit: true,
      },
      {
        id: workspace.projectId,
        name: "Checkout Flow",
        kind: "workspace",
        defaultKitId: "commerce-kit",
        kitBindings: [{ kitId: "commerce-kit", default: true }],
        updatedAt: expect.any(String),
        canEdit: true,
      },
    ]);
  });

  it("listProjects deterministically sorts by id when kind and name match", async () => {
    const root = await tempProjectsRoot();
    await mkdir(join(root, "same-name-b", ".genie"), { recursive: true });
    await mkdir(join(root, "same-name-a", ".genie"), { recursive: true });
    const now = new Date().toISOString();
    for (const id of ["same-name-b", "same-name-a"]) {
      await writeFile(
        join(root, id, ".genie", "project.json"),
        JSON.stringify(
          {
            id,
            name: "Same Name",
            kind: "workspace",
            kitBindings: [],
            createdAt: now,
            updatedAt: now,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    const store = new ProjectStore(root);

    await expect(store.listProjects()).resolves.toMatchObject([
      { id: "same-name-a" },
      { id: "same-name-b" },
    ]);
  });

  it("listProjects skips directories without project manifests", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    await mkdir(join(root, "not-a-project"), { recursive: true });

    await expect(store.listProjects()).resolves.toEqual([]);
  });

  it("listProjects skips malformed project manifests and returns remaining projects", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    await store.createProject({ name: "Valid Workspace", kind: "workspace" });
    await mkdir(join(root, "broken-project", ".genie"), { recursive: true });
    await writeFile(join(root, "broken-project", ".genie", "project.json"), "{broken", "utf8");

    await expect(store.listProjects()).resolves.toMatchObject([
      { id: "valid-workspace", name: "Valid Workspace" },
    ]);
  });

  it("creates a workspace from a blueprint by copying files and kit bindings", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const blueprint = await store.createProject({
      name: "Dashboard Blueprint",
      kind: "blueprint",
      kitBindings: [{ kitId: "core-kit", default: true }],
    });
    await mkdir(join(root, blueprint.projectId, "src"), { recursive: true });
    await writeFile(
      join(root, blueprint.projectId, "src", "Dashboard.tsx"),
      "export function Dashboard() { return <main />; }\n",
      "utf8",
    );

    const workspace = await store.createProject({
      name: "Merchant Dashboard",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });

    await expect(readProjectManifest(root, workspace.projectId)).resolves.toMatchObject({
      id: "merchant-dashboard",
      kind: "workspace",
      sourceBlueprintId: "dashboard-blueprint",
      kitBindings: [{ kitId: "core-kit", default: true }],
    });
    await expect(
      readFile(join(root, workspace.projectId, "src", "Dashboard.tsx"), "utf8"),
    ).resolves.toBe("export function Dashboard() { return <main />; }\n");

    await writeFile(
      join(root, blueprint.projectId, "src", "Dashboard.tsx"),
      "export function Dashboard() { return <section />; }\n",
      "utf8",
    );
    await expect(
      readFile(join(root, workspace.projectId, "src", "Dashboard.tsx"), "utf8"),
    ).resolves.toBe("export function Dashboard() { return <main />; }\n");
  });

  it("raises ERR_PROJECT_EXISTS with a suggested slug for duplicate names", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    await store.createProject({ name: "Checkout Flow", kind: "workspace" });

    await expect(
      store.createProject({ name: "Checkout Flow", kind: "workspace" }),
    ).rejects.toMatchObject({
      code: "ERR_PROJECT_EXISTS",
      suggestedSlug: "checkout-flow-2",
    });
  });

  it("raises ERR_BLUEPRINT_NOT_FOUND for an invalid fromBlueprintId", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);

    await expect(
      store.createProject({
        name: "Missing Blueprint Consumer",
        kind: "workspace",
        fromBlueprintId: "no-such-blueprint",
      }),
    ).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(
      store.createProject({
        name: "Missing Blueprint Consumer",
        kind: "workspace",
        fromBlueprintId: "no-such-blueprint",
      }),
    ).rejects.toMatchObject({ code: "ERR_BLUEPRINT_NOT_FOUND" });
  });

  it("rejects project names that produce unusable project ids", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);

    await expect(store.createProject({ name: "UI", kind: "blueprint" })).rejects.toMatchObject({
      code: "ERR_INVALID_PROJECT_NAME",
    });
  });

  describe("getProject", () => {
    it("returns full detail for a workspace project, defaulting screens to []", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      const { projectId } = await store.createProject({
        name: "Checkout Flow",
        kind: "workspace",
        kitBindings: [{ kitId: "commerce-kit", default: true }],
      });

      await expect(store.getProject(projectId)).resolves.toEqual({
        id: projectId,
        name: "Checkout Flow",
        kind: "workspace",
        defaultKitId: "commerce-kit",
        kitBindings: [{ kitId: "commerce-kit", default: true }],
        updatedAt: expect.any(String),
        canEdit: true,
        screens: [],
      });
    });

    it('returns kind: "blueprint" through the same shape — no special-case tool family (AC4)', async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      const { projectId } = await store.createProject({
        name: "Admin Starter",
        kind: "blueprint",
        kitBindings: [{ kitId: "base-kit" }],
      });

      const detail = await store.getProject(projectId);
      expect(detail.kind).toBe("blueprint");
      expect(detail).toEqual({
        id: projectId,
        name: "Admin Starter",
        kind: "blueprint",
        kitBindings: [{ kitId: "base-kit" }],
        updatedAt: expect.any(String),
        canEdit: true,
        screens: [],
      });
    });

    it("includes sourceBlueprintId for a workspace instantiated from a blueprint", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      const blueprint = await store.createProject({
        name: "Dashboard Blueprint",
        kind: "blueprint",
        kitBindings: [{ kitId: "core-kit", default: true }],
      });
      const workspace = await store.createProject({
        name: "Merchant Dashboard",
        kind: "workspace",
        fromBlueprintId: blueprint.projectId,
      });

      await expect(store.getProject(workspace.projectId)).resolves.toMatchObject({
        id: workspace.projectId,
        kind: "workspace",
        sourceBlueprintId: blueprint.projectId,
      });
      // The blueprint itself has no sourceBlueprintId of its own.
      await expect(store.getProject(blueprint.projectId)).resolves.not.toHaveProperty(
        "sourceBlueprintId",
      );
    });

    it("raises ERR_PROJECT_NOT_FOUND with the id echoed for an invalid id", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);

      await expect(store.getProject("no-such-project")).rejects.toMatchObject({
        code: "ERR_PROJECT_NOT_FOUND",
        projectId: "no-such-project",
      });
    });

    it("rejects a path-traversal-shaped id before touching the filesystem (defense-in-depth for direct callers)", async () => {
      // ProjectStore is a public export and getProject a public method — a caller
      // that bypasses the MCP tool's regex-typed input schema (e.g. a future tool
      // calling the store directly) must not be able to probe paths outside the
      // projects root by passing a projectId like "../secret". Craft a manifest
      // whose own `id` field matches the traversal string exactly, so the
      // separate "manifest.id !== projectId" guard can't be the thing blocking it —
      // this isolates the PROJECT_ID_PATTERN check as the actual defense.
      const parent = await tempProjectsRoot();
      const root = join(parent, "projects");
      await mkdir(root, { recursive: true });
      const traversalId = "../secret-outside-root";
      const secretDir = join(parent, "secret-outside-root");
      await mkdir(join(secretDir, ".genie"), { recursive: true });
      await writeFile(
        join(secretDir, ".genie", "project.json"),
        JSON.stringify({
          id: traversalId,
          name: "Secret Outside Root",
          kind: "workspace",
          kitBindings: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      const store = new ProjectStore(root);

      await expect(store.getProject(traversalId)).rejects.toMatchObject({
        code: "ERR_PROJECT_NOT_FOUND",
        projectId: traversalId,
      });
    });

    it("raises ERR_PROJECT_NOT_FOUND for a directory with a malformed manifest", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      await mkdir(join(root, "broken-project", ".genie"), { recursive: true });
      await writeFile(join(root, "broken-project", ".genie", "project.json"), "{broken", "utf8");

      await expect(store.getProject("broken-project")).rejects.toMatchObject({
        code: "ERR_PROJECT_NOT_FOUND",
        projectId: "broken-project",
      });
    });

    it("returns canEdit: false for a read-only project (AC6)", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      const { projectId } = await store.createProject({
        name: "Read Only Project",
        kind: "workspace",
      });
      await writeFile(join(root, projectId, ".genie", ".readonly"), "", "utf8");

      await expect(store.getProject(projectId)).resolves.toMatchObject({ canEdit: false });
    });
  });

  describe("bindKit", () => {
    async function setup(): Promise<{ store: ProjectStore; projectId: string }> {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });
      return { store, projectId };
    }

    it("AC3 — writes a new binding to .genie/project.json for a valid project and kit", async () => {
      const { store, projectId } = await setup();

      const result = await store.bindKit({ projectId, kitId: "commerce-kit" });

      expect(result.kitBindings).toEqual([{ kitId: "commerce-kit" }]);
      await expect(readProjectManifest(store.root, projectId)).resolves.toMatchObject({
        kitBindings: [{ kitId: "commerce-kit" }],
      });
    });

    it("AC4 — default: true sets defaultKitId and clears default from the previous binding", async () => {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      await kitStore.createKit("Admin Kit", "admin-kit");
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

      await store.bindKit({ projectId, kitId: "commerce-kit", default: true });
      const result = await store.bindKit({ projectId, kitId: "admin-kit", default: true });

      expect(result.defaultKitId).toBe("admin-kit");
      expect(result.kitBindings).toEqual([
        { kitId: "commerce-kit" },
        { kitId: "admin-kit", default: true },
      ]);
    });

    it("a second binding without default: true does not disturb the existing default", async () => {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      await kitStore.createKit("Admin Kit", "admin-kit");
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

      await store.bindKit({ projectId, kitId: "commerce-kit", default: true });
      const result = await store.bindKit({ projectId, kitId: "admin-kit" });

      expect(result.defaultKitId).toBe("commerce-kit");
      expect(result.kitBindings).toEqual([
        { kitId: "commerce-kit", default: true },
        { kitId: "admin-kit" },
      ]);
    });

    it("default: false on the current default clears its default status without promoting another", async () => {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      await kitStore.createKit("Admin Kit", "admin-kit");
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

      await store.bindKit({ projectId, kitId: "commerce-kit", default: true });
      await store.bindKit({ projectId, kitId: "admin-kit" });
      const result = await store.bindKit({ projectId, kitId: "commerce-kit", default: false });

      expect(result.defaultKitId).toBeUndefined();
      expect(result.kitBindings).toEqual([{ kitId: "commerce-kit" }, { kitId: "admin-kit" }]);
    });

    it("default: false on a binding that was never default is a no-op for every binding's default status", async () => {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      await kitStore.createKit("Admin Kit", "admin-kit");
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

      await store.bindKit({ projectId, kitId: "commerce-kit", default: true });
      const result = await store.bindKit({ projectId, kitId: "admin-kit", default: false });

      expect(result.defaultKitId).toBe("commerce-kit");
      expect(result.kitBindings).toEqual([
        { kitId: "commerce-kit", default: true },
        { kitId: "admin-kit" },
      ]);
    });

    it("AC5 — an invalid projectId raises ERR_PROJECT_NOT_FOUND", async () => {
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      const store = new ProjectStore(await tempProjectsRoot(), kitStore);

      await expect(
        store.bindKit({ projectId: "no-such-project", kitId: "commerce-kit" }),
      ).rejects.toMatchObject({
        code: "ERR_PROJECT_NOT_FOUND",
        projectId: "no-such-project",
      });
    });

    it("AC5 — a projectId shaped as a path-traversal attempt raises ERR_PROJECT_NOT_FOUND without touching disk outside the projects root", async () => {
      // Mirrors `getProject`'s own defense-in-depth regex guard: `ProjectStore`
      // is a public export, so a direct/programmatic caller bypassing the MCP
      // schema's regex-typed input could otherwise pass something shaped like
      // a traversal attempt through to `join()`.
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      await kitStore.createKit("Commerce Kit", "commerce-kit");
      const store = new ProjectStore(await tempProjectsRoot(), kitStore);

      await expect(
        store.bindKit({ projectId: "../../etc", kitId: "commerce-kit" }),
      ).rejects.toMatchObject({
        code: "ERR_PROJECT_NOT_FOUND",
        projectId: "../../etc",
      });
    });

    it("AC6 — an invalid kitId raises ERR_KIT_NOT_FOUND", async () => {
      const { store, projectId } = await setup();

      await expect(store.bindKit({ projectId, kitId: "no-such-kit" })).rejects.toMatchObject({
        code: "ERR_KIT_NOT_FOUND",
        kitId: "no-such-kit",
      });
    });

    it("AC6 — a project-typed id passed as kitId raises ERR_KIT_NOT_FOUND (WrongProjectTypeError mapping)", async () => {
      // get_kit rejects an id that resolves to something other than GENIE_KIT
      // (WrongProjectTypeError) — bind_kit must map that the same way it maps
      // an outright-missing kit, since both are "not a bindable kit" to the
      // caller. LocalFsKitStore.getKit() always stamps its return with
      // KIT_TYPE regardless of what's on disk, so a real store can't produce
      // this branch — use a minimal mock KitStore whose getKit() returns a
      // non-GENIE_KIT type, matching the MockKitStore pattern in get_kit.test.ts.
      const root = await tempProjectsRoot();
      const notAKitStore: KitStore = {
        async listKits() {
          return [];
        },
        async getKit(kitId: string) {
          return {
            id: kitId,
            name: "Not A Kit",
            type: "SOMETHING_ELSE" as typeof KIT_TYPE,
            createdAt: new Date().toISOString(),
          };
        },
        async listFiles() {
          return [];
        },
        async listComponents() {
          // bindKit does not call listComponents; mirror the "not used" idiom
          // from list_kits.test.ts so a future accidental call is loud.
          throw new Error("not used");
        },
        async readFile() {
          return "";
        },
        async createKit() {
          throw new Error("not implemented");
        },
        async openPlan() {
          return "plan";
        },
        async commitPlan() {},
        async closePlan() {},
      };
      const store = new ProjectStore(root, notAKitStore);
      const { projectId } = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

      await expect(store.bindKit({ projectId, kitId: "not-a-kit" })).rejects.toMatchObject({
        code: "ERR_KIT_NOT_FOUND",
        kitId: "not-a-kit",
      });
    });

    it("AC7 — a blueprint project accepts a binding, and it copies into a derived workspace", async () => {
      const root = await tempProjectsRoot();
      const kitStore = new LocalFsKitStore(await tempKitsRoot());
      const store = new ProjectStore(root, kitStore);
      await kitStore.createKit("Core Kit", "core-kit");
      const blueprint = await store.createProject({ name: "Admin Starter", kind: "blueprint" });

      const boundBlueprint = await store.bindKit({
        projectId: blueprint.projectId,
        kitId: "core-kit",
        default: true,
      });
      expect(boundBlueprint.kitBindings).toEqual([{ kitId: "core-kit", default: true }]);

      const workspace = await store.createProject({
        name: "Merchant Dashboard",
        kind: "workspace",
        fromBlueprintId: blueprint.projectId,
      });

      await expect(store.getProject(workspace.projectId)).resolves.toMatchObject({
        kitBindings: [{ kitId: "core-kit", default: true }],
        defaultKitId: "core-kit",
      });
    });

    it("AC8 — binding the same kit twice is idempotent (updates in place, no duplicate entry)", async () => {
      const { store, projectId } = await setup();

      await store.bindKit({ projectId, kitId: "commerce-kit" });
      const result = await store.bindKit({ projectId, kitId: "commerce-kit" });

      expect(result.kitBindings).toEqual([{ kitId: "commerce-kit" }]);
    });

    it("re-binding the same kit with default: true stays a single entry, now marked default", async () => {
      const { store, projectId } = await setup();

      await store.bindKit({ projectId, kitId: "commerce-kit" });
      const result = await store.bindKit({ projectId, kitId: "commerce-kit", default: true });

      expect(result.kitBindings).toEqual([{ kitId: "commerce-kit", default: true }]);
      expect(result.defaultKitId).toBe("commerce-kit");
    });

    it("raises ERR_PROJECT_READONLY for a read-only project", async () => {
      const { store, projectId } = await setup();
      await writeFile(join(store.root, projectId, ".genie", ".readonly"), "", "utf8");

      await expect(store.bindKit({ projectId, kitId: "commerce-kit" })).rejects.toMatchObject({
        code: "ERR_PROJECT_READONLY",
        projectId,
      });
    });

    it("throws a plain Error if constructed without a KitStore", async () => {
      const root = await tempProjectsRoot();
      const store = new ProjectStore(root);
      const { projectId } = await store.createProject({ name: "No Kit Store", kind: "workspace" });

      await expect(store.bindKit({ projectId, kitId: "commerce-kit" })).rejects.toThrow(
        /requires a KitStore/,
      );
    });
  });
});
