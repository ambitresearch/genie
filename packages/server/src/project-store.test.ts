import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectStore, ProjectStoreError } from "./project-store.js";

async function createTempStore(): Promise<{ rootDir: string; store: ProjectStore }> {
  const rootDir = await mkdtemp(join(tmpdir(), "genie-project-store-"));
  return { rootDir, store: new ProjectStore({ rootDir }) };
}

async function readManifest(rootDir: string, projectId: string): Promise<Record<string, unknown>> {
  const json = await readFile(join(rootDir, projectId, ".genie", "project.json"), "utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("ProjectStore.createProject", () => {
  it("creates a blank workspace with a workspace manifest", async () => {
    const { rootDir, store } = await createTempStore();

    const result = await store.createProject({ name: "Checkout Flow", kind: "workspace" });

    expect(result.projectId).toBe("checkout-flow");
    await expect(readManifest(rootDir, result.projectId)).resolves.toMatchObject({
      id: "checkout-flow",
      name: "Checkout Flow",
      kind: "workspace",
      kitBindings: [],
    });
  });

  it("creates a blank blueprint with a blueprint manifest", async () => {
    const { rootDir, store } = await createTempStore();

    const result = await store.createProject({
      name: "Marketing Starter",
      kind: "blueprint",
      kitBindings: [{ kitId: "brand-kit", default: true }],
    });

    await expect(readManifest(rootDir, result.projectId)).resolves.toMatchObject({
      id: "marketing-starter",
      name: "Marketing Starter",
      kind: "blueprint",
      kitBindings: [{ kitId: "brand-kit", default: true }],
    });
  });

  it("creates a workspace from a blueprint by copying starter files and kit bindings", async () => {
    const { rootDir, store } = await createTempStore();
    const blueprint = await store.createProject({
      name: "Dashboard Blueprint",
      kind: "blueprint",
      kitBindings: [{ kitId: "analytics-kit", default: true }],
    });
    await mkdir(join(rootDir, blueprint.projectId, "screens"), { recursive: true });
    await writeFile(
      join(rootDir, blueprint.projectId, "screens", "home.tsx"),
      "export const Home = () => 'blueprint';\n",
      "utf8",
    );

    const workspace = await store.createProject({
      name: "Customer Dashboard",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });

    await expect(
      readFile(join(rootDir, workspace.projectId, "screens", "home.tsx"), "utf8"),
    ).resolves.toBe("export const Home = () => 'blueprint';\n");
    await expect(readManifest(rootDir, workspace.projectId)).resolves.toMatchObject({
      id: "customer-dashboard",
      kind: "workspace",
      sourceBlueprintId: blueprint.projectId,
      kitBindings: [{ kitId: "analytics-kit", default: true }],
    });
  });

  it("does not mutate derived workspaces when the source blueprint changes later", async () => {
    const { rootDir, store } = await createTempStore();
    const blueprint = await store.createProject({ name: "Card Blueprint", kind: "blueprint" });
    await writeFile(join(rootDir, blueprint.projectId, "card.tsx"), "original\n", "utf8");
    const workspace = await store.createProject({
      name: "Card Workspace",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });

    await writeFile(join(rootDir, blueprint.projectId, "card.tsx"), "changed\n", "utf8");

    await expect(readFile(join(rootDir, workspace.projectId, "card.tsx"), "utf8")).resolves.toBe(
      "original\n",
    );
  });

  it("copies blueprint symlink targets instead of linking derived workspaces back to the blueprint", async () => {
    const { rootDir, store } = await createTempStore();
    const blueprint = await store.createProject({ name: "Linked Blueprint", kind: "blueprint" });
    await writeFile(join(rootDir, blueprint.projectId, "shared.tsx"), "original\n", "utf8");
    await symlink("shared.tsx", join(rootDir, blueprint.projectId, "linked.tsx"));

    const workspace = await store.createProject({
      name: "Linked Workspace",
      kind: "workspace",
      fromBlueprintId: blueprint.projectId,
    });
    await writeFile(join(rootDir, blueprint.projectId, "shared.tsx"), "changed\n", "utf8");

    await expect(readFile(join(rootDir, workspace.projectId, "linked.tsx"), "utf8")).resolves.toBe(
      "original\n",
    );
  });

  it("rejects blueprint directory symlinks without leaving a partial workspace", async () => {
    const { rootDir, store } = await createTempStore();
    const blueprint = await store.createProject({ name: "Loop Blueprint", kind: "blueprint" });
    await symlink(".", join(rootDir, blueprint.projectId, "loop"), "dir");

    await expect(
      store.createProject({
        name: "Loop Workspace",
        kind: "workspace",
        fromBlueprintId: blueprint.projectId,
      }),
    ).rejects.toThrow("directory symlinks are not supported");
    await expect(access(join(rootDir, "loop-workspace"))).rejects.toThrow();
  });

  it("rejects blueprint symlinks to metadata without leaving a partial workspace", async () => {
    const { rootDir, store } = await createTempStore();
    const blueprint = await store.createProject({ name: "Metadata Blueprint", kind: "blueprint" });
    await symlink(".genie/project.json", join(rootDir, blueprint.projectId, "manifest-copy.json"));

    await expect(
      store.createProject({
        name: "Metadata Workspace",
        kind: "workspace",
        fromBlueprintId: blueprint.projectId,
      }),
    ).rejects.toThrow("symlink targets ignored metadata");
    await expect(access(join(rootDir, "metadata-workspace"))).rejects.toThrow();
  });

  it("raises ERR_PROJECT_EXISTS with a suggested slug for duplicate names", async () => {
    const { store } = await createTempStore();
    await store.createProject({ name: "Duplicate Project", kind: "workspace" });

    await expect(
      store.createProject({ name: "Duplicate Project", kind: "blueprint" }),
    ).rejects.toMatchObject({
      code: "ERR_PROJECT_EXISTS",
      details: { suggestedSlug: "duplicate-project-2" },
    });
  });

  it("raises ERR_BLUEPRINT_NOT_FOUND for an invalid fromBlueprintId", async () => {
    const { store } = await createTempStore();

    await expect(
      store.createProject({
        name: "Missing Blueprint Workspace",
        kind: "workspace",
        fromBlueprintId: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(
      store.createProject({
        name: "Missing Blueprint Workspace",
        kind: "workspace",
        fromBlueprintId: "does-not-exist",
      }),
    ).rejects.toMatchObject({ code: "ERR_BLUEPRINT_NOT_FOUND" });
  });

  it("raises ERR_BLUEPRINT_NOT_FOUND for path-like blueprint ids", async () => {
    const { store } = await createTempStore();

    await expect(
      store.createProject({
        name: "Traversal Workspace",
        kind: "workspace",
        fromBlueprintId: "../external-blueprint",
      }),
    ).rejects.toMatchObject({
      code: "ERR_BLUEPRINT_NOT_FOUND",
      details: { blueprintId: "../external-blueprint" },
    });
  });
});
