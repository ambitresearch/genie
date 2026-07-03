/**
 * AC5 Gitea reference-host conformance — DRO-532 (blocker #2 of DRO-523).
 *
 * Runs genie's real `GitHostKitStore` / `GitHostProjectStore` adapters against a
 * live `gitea/gitea` container (booted by ./support/gitea-fixture) over real
 * HTTP. This is the end-to-end counterpart to the in-memory-fetch contract in
 * `packages/server/test/store-conformance.test.ts`: that suite proves the
 * adapter shapes requests correctly; THIS suite proves a real Gitea accepts
 * them — auth header form, org-repo creation, base64 content round-trips,
 * plan-branch isolation, and 409/404 status mapping.
 *
 * ── Relationship to AC5 (DRO-523) ────────────────────────────────────────────
 * DRO-523's AC5 is the *MCP-tool-surface* walk against GitHostStore, which is
 * blocked on the `createServer` store-injection seam (sibling blocker). This
 * file deliberately stays at the *store* layer — the seam-independent half — so
 * the testcontainers/CI harness (DRO-532's charter) lands and is exercised now,
 * ahead of the seam. When the seam merges, DRO-523 reuses this exact fixture to
 * point the in-process MCP client at Gitea.
 *
 * ── Docker-absent skip ───────────────────────────────────────────────────────
 * The whole suite is `describe.skipIf(!dockerAvailable)`. With no container
 * runtime (the common local case) it is skipped, keeping `pnpm test` green
 * without Docker. It runs for real only on the CI Docker leg (ci.yml `gitea`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitHostKitStore, GitHostProjectStore } from "../../server/src/store/git-host.js";
import { KitAlreadyExistsError, NotFoundError } from "../../server/src/store/interface.js";

import { isDockerAvailable, startGitea, type GiteaFixture } from "./support/gitea-fixture.js";

// Resolve runtime availability once, before suite collection, so the whole
// block is statically skipped when Docker is absent (top-level await is
// supported in vitest ESM test modules).
const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  // Visible breadcrumb in local runs so a green "skipped" isn't mistaken for
  // "ran and passed". CI's Docker leg sets GENIE_REQUIRE_DOCKER=1 (see below).
  console.info(
    "[gitea-conformance] no container runtime detected — skipping the Gitea walk " +
      "(set up Docker to run it; CI's Docker leg runs it for real).",
  );
}

// Guard against a silent skip on the CI Docker leg: if the leg forgot to make a
// daemon reachable, we must fail loudly rather than pass by skipping — otherwise
// the leg is green-but-vacuous. Local runs leave GENIE_REQUIRE_DOCKER unset.
if (!dockerAvailable && process.env.GENIE_REQUIRE_DOCKER === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but no container runtime is reachable — the CI Docker " +
      "leg must run the Gitea conformance walk, not skip it.",
  );
}

describe.skipIf(!dockerAvailable)("AC5 — GitHostStore conformance against live Gitea", () => {
  let gitea: GiteaFixture;
  let kitStore: GitHostKitStore;
  let projectStore: GitHostProjectStore;

  beforeAll(async () => {
    gitea = await startGitea();
    const config = { baseUrl: gitea.baseUrl, owner: gitea.owner, token: gitea.token };
    kitStore = new GitHostKitStore(config);
    projectStore = new GitHostProjectStore(config);
  }, 240_000); // cold-image pull + DB migration budget.

  afterAll(async () => {
    await gitea?.stop();
  });

  // ── KitStore walk ───────────────────────────────────────────────────────────

  it("createKit + getKit round-trips through a real repo + .kit.json", async () => {
    const kit = await kitStore.createKit("Warm Instrument Kit", "warm-instrument-kit");
    expect(kit.id).toBe("warm-instrument-kit");
    expect(kit.name).toBe("Warm Instrument Kit");
    expect(kit.type).toBe("GENIE_KIT");
    expect(kit.createdAt).toBeTruthy();

    const fetched = await kitStore.getKit("warm-instrument-kit");
    expect(fetched.id).toBe("warm-instrument-kit");
    // Human-readable name comes from .kit.json, not the repo name — proves the
    // base64 metadata file round-tripped through Gitea's contents API.
    expect(fetched.name).toBe("Warm Instrument Kit");
  });

  it("listKits surfaces a created kit", async () => {
    await kitStore.createKit("Listed Kit", "listed-kit");
    const kits = await kitStore.listKits();
    expect(kits.some((k) => k.id === "listed-kit")).toBe(true);
  });

  it("createKit maps a real 409 repo collision to KitAlreadyExistsError", async () => {
    await kitStore.createKit("Collision Kit", "collision-kit");
    const dup = kitStore.createKit("Collision Kit Again", "collision-kit");
    await expect(dup).rejects.toBeInstanceOf(KitAlreadyExistsError);
    await expect(dup).rejects.toMatchObject({ kitId: "collision-kit" });
  });

  it("getKit maps a real 404 to NotFoundError", async () => {
    await expect(kitStore.getKit("no-such-kit-xyz")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("plan lifecycle isolates staged files on the plan branch (real branches)", async () => {
    const kit = await kitStore.createKit("Plan Kit", "plan-kit");

    const planId = await kitStore.openPlan(kit.id, [
      { kind: "write", path: "components/Button.ts", content: "export const Button = 1;" },
    ]);
    expect(planId).toBeTruthy();

    // A second commit onto the same plan branch must succeed.
    await kitStore.commitPlan(kit.id, planId, [
      { kind: "write", path: "components/Card.ts", content: "export const Card = 2;" },
    ]);

    // Files live on `plan/<id>`, NOT the default branch — readFile (default
    // branch) must not see them. This is the plan-isolation invariant the mock
    // contract asserts; here it rides real Gitea branch semantics.
    await expect(kitStore.readFile(kit.id, "components/Button.ts")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await kitStore.closePlan(kit.id, planId);
    // closePlan (branch delete) is idempotent even against a real host.
    await kitStore.closePlan(kit.id, planId);
  });

  it("commitPlan against a missing plan branch maps to NotFoundError", async () => {
    const kit = await kitStore.createKit("Commit Miss Kit", "commit-miss-kit");
    await expect(
      kitStore.commitPlan(kit.id, "00000000-0000-0000-0000-000000000000", []),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── ProjectStore walk ────────────────────────────────────────────────────────

  it("project CRUD + bindKit round-trips through the _genie-projects repo", async () => {
    const project = await projectStore.createProject("Dashboard Project");
    expect(project.id).toBeTruthy();
    expect(project.name).toBe("Dashboard Project");
    expect(project.kitId).toBeUndefined();

    const fetched = await projectStore.getProject(project.id);
    expect(fetched.id).toBe(project.id);
    expect(fetched.name).toBe("Dashboard Project");

    await projectStore.bindKit(project.id, "warm-instrument-kit");
    const bound = await projectStore.getProject(project.id);
    expect(bound.kitId).toBe("warm-instrument-kit");

    const listed = await projectStore.listProjects();
    expect(listed.some((p) => p.id === project.id)).toBe(true);

    await projectStore.deleteProject(project.id);
    await expect(projectStore.getProject(project.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deleteProject on a missing project maps to NotFoundError", async () => {
    await expect(projectStore.deleteProject("no-such-project-xyz")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
