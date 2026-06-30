import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./create_project.js";
import { deleteProject, ERR_INVALID_PROJECT_ID, ERR_PROJECT_READONLY } from "./delete_project.js";

async function tempProjectsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-projects-"));
}

describe("deleteProject", () => {
  it("deletes an existing workspace project and returns deletedProjectId", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({ name: "Test Workspace", kind: "workspace" });

    const result = await deleteProject(root, { projectId });

    expect(result.deletedProjectId).toBe(projectId);
    expect(existsSync(join(root, projectId))).toBe(false);
  });

  it("deletes an existing blueprint project and returns deletedProjectId", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({ name: "Test Blueprint", kind: "blueprint" });

    const result = await deleteProject(root, { projectId });

    expect(result.deletedProjectId).toBe(projectId);
    expect(existsSync(join(root, projectId))).toBe(false);
  });

  it("succeeds idempotently for missing projects and reports warning", async () => {
    const root = await tempProjectsRoot();

    const result = await deleteProject(root, { projectId: "no-such-project" });

    expect(result.deletedProjectId).toBe("no-such-project");
    expect(result._meta?.warnings).toContain(
      'Project "no-such-project" does not exist or was already deleted.',
    );
  });

  it("deletes a blueprint without deleting derived workspaces", async () => {
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

    const result = await deleteProject(root, { projectId: blueprint.projectId });

    expect(result.deletedProjectId).toBe(blueprint.projectId);
    expect(existsSync(join(root, blueprint.projectId))).toBe(false);
    expect(existsSync(join(root, workspace.projectId))).toBe(true);
  });

  it("raises ERR_PROJECT_READONLY for read-only projects", async () => {
    const root = await tempProjectsRoot();
    const store = new ProjectStore(root);
    const { projectId } = await store.createProject({
      name: "Read Only Project",
      kind: "workspace",
    });

    // Simulate a read-only project by adding the readonly marker
    await writeFile(join(root, projectId, ".genie", ".readonly"), "", "utf8");

    await expect(deleteProject(root, { projectId })).rejects.toMatchObject({
      code: ERR_PROJECT_READONLY,
    });
  });

  it.each([
    ["parent traversal", "../escape"],
    ["nested traversal", "../../etc"],
    ["absolute path", "/etc"],
    ["windows-style absolute", "C:\\Windows"],
    ["path separator", "foo/bar"],
    ["backslash separator", "foo\\bar"],
    ["uppercase letters", "INVALID"],
    ["dot prefix", ".hidden"],
    ["too short", "ab"],
    ["empty string", ""],
  ])(
    "rejects path-traversal / invalid projectId (%s) without touching the filesystem",
    async (_label, projectId) => {
      const root = await tempProjectsRoot();
      // Create a sibling directory that a traversal attempt could potentially escape to.
      const sentinelDir = join(root, "..", `sentinel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      await mkdir(sentinelDir, { recursive: true });
      await writeFile(join(sentinelDir, "keep.txt"), "do-not-delete", "utf8");

      await expect(deleteProject(root, { projectId })).rejects.toMatchObject({
        code: ERR_INVALID_PROJECT_ID,
      });

      // Sentinel must still exist — the rejected projectId never reached `rm()`.
      expect(existsSync(sentinelDir)).toBe(true);
      expect(existsSync(join(sentinelDir, "keep.txt"))).toBe(true);
    },
  );
});
