import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectStore, ProjectStoreError } from "./create_project.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-projects-"));
}

async function readProjectManifest(
  root: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, projectId, ".genie", "project.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("ProjectStore.createProject", () => {
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
});
