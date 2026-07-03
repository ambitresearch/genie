/**
 * M1 integration / conformance suite — M1-14 (DRO-318 / source DRO-240).
 *
 * End-to-end conformance walk of genie's MCP tool surface, driven through an
 * in-process MCP client over the SDK's `InMemoryTransport` (AC2). The suite is
 * the deliverable: it exercises the kit read→plan→write/delete protocol and the
 * project/blueprint workflow, plus the required negative paths.
 *
 * ── Status of the M1 tool surface at scaffold time ──────────────────────────
 * This file is scaffolded against the tools already **merged** to `main`, and
 * grows to full AC coverage as the remaining upstream tools land. Every walk
 * that depends on an unmerged tool is an `it.todo(...)` naming its blocking
 * issue, so this file is both a green baseline *and* the live checklist for the
 * rest of M1 — nothing is silently skipped.
 *
 *   Merged & driven live here:
 *     create_kit, list_files, list_components, read_file, validate, plan,
 *     write_files, delete_files, create_project, list_projects, get_project,
 *     delete_project, get_kit, list_kits, bind_kit, conjure_screen
 *
 *   AC5 (GitHostStore/Gitea) is now a live, Docker-gated walk: the kit-metadata
 *   MCP verbs run against a `gitea/gitea` testcontainer via the createServer
 *   store-injection seam (DRO-523 AC1). It auto-skips when no Docker daemon is
 *   present, so the LocalFs path stays green without Docker.
 *
 * ── Acceptance criteria map ─────────────────────────────────────────────────
 *   AC1  file path (this file)                              ✓ satisfied
 *   AC2  in-process SDK test transport                      ✓ live
 *   AC3  kit protocol walk                                  ✓ read+plan+write_files+delete_files live
 *   AC4  project/blueprint walk                             ✓ CRUD+blueprint+bind_kit tool+conjure_screen all live
 *   AC5  GitHostStore/Gitea parity                          ● live (Docker-gated: kit-metadata verbs via store-injection seam; auto-skips w/o Docker)
 *   AC6  negative: write without/outside planId → -32602    ✓ live (DRO-236)
 *   AC7  negative: conjure_screen no kit → ERR_PROJECT_KIT_REQUIRED  ✓ live (M1-21)
 *   AC8  test report uploaded as CI artefact                ✓ junit reporter (vitest.config) + upload step (ci.yml)
 *   AC9  suite < 60 s wall-clock                            ✓ live walk is ~ms; explicit budget guard below
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server/src/server.js";
import { GitHostKitStore } from "../../server/src/store/git-host.js";
import { isDockerAvailable, startGitea, type GiteaFixture } from "./support/gitea-fixture.js";

// AC5 gate — resolve container-runtime availability ONCE, before suite
// collection, so the whole AC5 `describe` is statically skipped when Docker is
// absent (the common local case). Top-level await is supported in vitest ESM
// test modules.
const ac5DockerAvailable = await isDockerAvailable();
if (!ac5DockerAvailable) {
  // Visible breadcrumb so a green "skipped" isn't mistaken for "ran and passed".
  console.info(
    "[m1-conformance AC5] no container runtime detected — skipping the Gitea MCP-surface walk " +
      "(set up Docker to run it; CI's Docker leg runs it for real).",
  );
}
// Fail loudly on the CI Docker leg if it lost its daemon, rather than passing by
// skipping (a green-but-vacuous leg). Local runs leave GENIE_REQUIRE_DOCKER unset.
if (!ac5DockerAvailable && process.env.GENIE_REQUIRE_DOCKER === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but no container runtime is reachable — the CI Docker leg must run " +
      "the AC5 Gitea MCP-surface walk, not skip it.",
  );
}

// ── Harness ──────────────────────────────────────────────────────────────────

/** MCP tool call result, narrowed to the fields the walks assert on. */
interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

interface Harness {
  client: Client;
  roots: { projectsRoot: string; kitsRoot: string; reportsDir: string };
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

/** First text content part, parsed as JSON (tools that don't set structuredContent). */
function parseText(result: ToolResult): unknown {
  const text = result.content?.[0]?.text ?? "";
  return text ? JSON.parse(text) : undefined;
}

/** structuredContent when present, else the parsed text payload. */
function payload(result: ToolResult): unknown {
  return result.structuredContent ?? parseText(result);
}

async function newHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "genie-m1-conformance-"));
  const roots = {
    projectsRoot: join(base, "projects"),
    kitsRoot: join(base, "kits"),
    reportsDir: join(base, "reports"),
  };
  const server = createServer(roots);
  const client = new Client({ name: "m1-conformance", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    roots,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(async () => {
  harness = await newHarness();
});
afterEach(async () => {
  await harness.close();
});

// ── AC2 — in-process transport + surface ──────────────────────────────────────

describe("AC2 — MCP server boots in-process over the SDK test transport", () => {
  it("advertises every merged M1 tool via tools/list", async () => {
    const { tools } = await harness.client.listTools();
    const names = new Set(tools.map((t) => t.name));

    // ping + the merged M1 kit and project verbs.
    for (const merged of [
      "ping",
      "mcp__genie__list_kits",
      "mcp__genie__create_kit",
      "mcp__genie__get_kit",
      "mcp__genie__read_file",
      "mcp__genie__list_files",
      "mcp__genie__list_components",
      "mcp__genie__validate",
      "mcp__genie__plan",
      "mcp__genie__delete_files",
      "mcp__genie__create_project",
      "mcp__genie__list_projects",
      "mcp__genie__get_project",
      "mcp__genie__delete_project",
      "mcp__genie__bind_kit",
      "mcp__genie__conjure_screen",
    ]) {
      expect(names, `expected ${merged} to be registered`).toContain(merged);
    }
  });
});

// ── AC3 — kit protocol walk ───────────────────────────────────────────────────
//
// Full target sequence (AC3):
//   create_kit → list_files(empty) → plan → write_files(5) →
//   list_files(5) → read_file round-trip → delete_files → validate
//
// Live prefix below covers create_kit, list_files(empty), read_file(negative),
// and validate. The plan→write_files→delete_files middle is now fully live —
// both M1-08 (write_files) and M1-09 (delete_files) are merged.

describe("AC3 — kit protocol walk (read → plan → write/delete)", () => {
  /** Create a kit through the tool surface and return its kitId. */
  async function createKit(name: string): Promise<string> {
    const result = await harness.call("mcp__genie__create_kit", { name });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const { kitId } = payload(result) as { kitId: string };
    return kitId;
  }

  it("create_kit returns a slug-shaped kitId", async () => {
    const kitId = await createKit("Conformance Kit");
    // <slug>-<6 hex> per create_kit (M1-06).
    expect(kitId).toMatch(/^conformance-kit-[0-9a-f]{6}$/);
  });

  it("list_files on a freshly created kit is empty (the .kit.json marker is hidden)", async () => {
    const kitId = await createKit("Empty Walk Kit");
    const result = await harness.call("mcp__genie__list_files", { kitId });
    expect(result.isError).toBeFalsy();
    expect((payload(result) as { files: unknown[] }).files).toEqual([]);
  });

  it("read_file on a path that does not exist is rejected (-32602)", async () => {
    const kitId = await createKit("Read Negative Kit");
    const result = await harness.call("mcp__genie__read_file", {
      kitId,
      path: "components/DoesNotExist.tsx",
    });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toMatch(/not found/i);
  });

  it("validate accepts aggregate counts for a kit and returns {} (telemetry facet)", async () => {
    const kitId = await createKit("Telemetry Kit");
    const result = await harness.call("mcp__genie__validate", {
      kitId,
      counts: { total: 5, bad: 0, thin: 1, variantsIdentical: 0, iterations: 1 },
    });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toEqual({});
  });

  // Write-half of AC3: plan → write_files(5) → list_files(5) → read_file
  // round-trip.
  it("plan → write_files(5) → list_files(5) → read_file round-trip", async () => {
    const kitId = await createKit("Write Walk Kit");
    // Kit content lives at `<kitsRoot>/<kitId>/` (the same root create_kit,
    // read_file, and list_files all share) — that's write_files' localDir.
    const kitDir = join(harness.roots.kitsRoot, kitId);

    const planResult = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["components/**/*.html"],
      localDir: kitDir,
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const { planId } = payload(planResult) as { planId: string };

    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `components/Widget${i}.html`,
      data: `<div>Widget ${i}</div>`,
    }));
    const writeResult = await harness.call("mcp__genie__write_files", { planId, files });
    expect(writeResult.isError, JSON.stringify(writeResult)).toBeFalsy();
    expect(payload(writeResult)).toMatchObject({
      writtenPaths: files.map((f) => f.path),
    });

    const listed = await harness.call("mcp__genie__list_files", { kitId });
    expect(listed.isError).toBeFalsy();
    const listedPaths = (payload(listed) as { files: { path: string }[] }).files.map(
      (f) => f.path,
    );
    for (const f of files) {
      expect(listedPaths).toContain(f.path);
    }

    const read = await harness.call("mcp__genie__read_file", {
      kitId,
      path: "components/Widget2.html",
    });
    expect(read.isError).toBeFalsy();
    expect(payload(read)).toMatchObject({ content: "<div>Widget 2</div>" });
  });

  // Delete-half of AC3: plan → delete_files with an in-plan present path, an
  // in-plan absent path (silent-retry → notFoundPaths), and an out-of-plan
  // path (whole-call rejection). Both write_files (M1-08) and delete_files
  // (M1-09) are now merged, so the full read→plan→write/delete walk is live.
  it("plan → delete_files removes an in-plan file and silently retries past a missing one", async () => {
    const kitId = await createKit("Delete Walk Kit");

    // Seed two files directly under the kit root, then author a plan whose
    // `deletes` authorize both a present and an absent path. delete_files must
    // remove the present one and report the absent one in notFoundPaths (the
    // known-good silent-retry case), while leaving out-of-plan files untouched.
    await writeFile(join(harness.roots.kitsRoot, kitId, "stale.txt"), "stale", "utf8");
    await writeFile(join(harness.roots.kitsRoot, kitId, "keep.txt"), "keep", "utf8");

    const planResult = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["**/*"],
      deletes: ["stale.txt", "gone.txt"],
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const { planId } = payload(planResult) as { planId: string };

    const delResult = await harness.call("mcp__genie__delete_files", {
      planId,
      paths: ["stale.txt", "gone.txt"],
    });
    expect(delResult.isError, JSON.stringify(delResult)).toBeFalsy();
    expect(payload(delResult)).toEqual({
      deletedPaths: ["stale.txt"],
      notFoundPaths: ["gone.txt"],
    });

    // An out-of-plan path rejects the whole call and touches nothing.
    const rejected = await harness.call("mcp__genie__delete_files", {
      planId,
      paths: ["keep.txt"],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content?.[0]?.text ?? "").toContain("PathOutsidePlanError");

    // keep.txt survived; the deleted file is gone from list_files.
    const listed = await harness.call("mcp__genie__list_files", { kitId });
    const files = (payload(listed) as { files: { path: string }[] }).files.map((f) => f.path);
    expect(files).toContain("keep.txt");
    expect(files).not.toContain("stale.txt");
  });
});

// ── AC4 — project / blueprint walk ────────────────────────────────────────────
//
// Full target sequence (AC4):
//   create_project(blueprint) → create_project(from blueprint) → bind_kit →
//   list_projects → get_project → conjure_screen(stub) → delete_project
//
// Live coverage below: blueprint authoring + instantiation, kit-binding *state*
// (via create_project kitBindings — the same state bind_kit produces), listing,
// detail, and deletion. The dedicated bind_kit tool and conjure_screen are todo.

describe("AC4 — project / blueprint workflow", () => {
  async function createProject(args: Record<string, unknown>): Promise<string> {
    const result = await harness.call("mcp__genie__create_project", args);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return (payload(result) as { projectId: string }).projectId;
  }

  it("authors a blueprint, instantiates a workspace from it, and records provenance", async () => {
    const blueprintId = await createProject({
      name: "Conformance Blueprint",
      kind: "blueprint",
    });
    expect(blueprintId).toBe("conformance-blueprint");

    const workspaceId = await createProject({
      name: "Conformance From Blueprint",
      kind: "workspace",
      fromBlueprintId: blueprintId,
    });

    const detail = await harness.call("mcp__genie__get_project", { projectId: workspaceId });
    expect(detail.isError).toBeFalsy();
    expect(payload(detail)).toMatchObject({
      id: "conformance-from-blueprint",
      kind: "workspace",
      sourceBlueprintId: "conformance-blueprint",
      screens: [],
      canEdit: true,
    });
  });

  it("get_project reflects kit bindings established at creation (the bind_kit end-state)", async () => {
    const kitResult = await harness.call("mcp__genie__create_kit", { name: "Bound Kit" });
    expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
    const { kitId } = payload(kitResult) as { kitId: string };

    const projectId = await createProject({
      name: "Bound Workspace",
      kind: "workspace",
      kitBindings: [{ kitId, default: true }],
    });

    const detail = await harness.call("mcp__genie__get_project", { projectId });
    expect(detail.isError).toBeFalsy();
    const body = payload(detail) as {
      kitBindings: { kitId: string; default?: boolean }[];
      defaultKitId?: string;
    };
    expect(body.kitBindings).toContainEqual({ kitId, default: true });
    expect(body.defaultKitId).toBe(kitId);
  });

  it("list_projects returns authored projects in (kind, name, id) order, and delete_project removes one end-to-end", async () => {
    // Fixture chosen so a naive id-sort disagrees with the server's contract:
    // "aaa-workspace" sorts before "walk-blueprint" by id, but the server orders
    // by kind first (blueprint < workspace), so the blueprint must come first.
    await createProject({ name: "Walk Blueprint", kind: "blueprint" });
    const workspaceId = await createProject({ name: "Aaa Workspace", kind: "workspace" });

    const listed = await harness.call("mcp__genie__list_projects", {});
    const projects = (payload(listed) as { projects: { id: string; name: string; kind: string }[] })
      .projects;
    const ids = projects.map((p) => p.id);

    // Assert the *real* ordering contract: (kind, name, id) lexicographic — not a
    // bare id-sort, which would pass accidentally and mask an ordering regression.
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const expectedOrder = [...projects].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.id, b.id),
    );
    expect(projects).toEqual(expectedOrder);
    // And the discriminating case: blueprint precedes the id-earlier workspace.
    expect(ids.indexOf("walk-blueprint")).toBeLessThan(ids.indexOf("aaa-workspace"));
    expect(ids).toContain("walk-blueprint");
    expect(ids).toContain("aaa-workspace");

    const del = await harness.call("mcp__genie__delete_project", { projectId: workspaceId });
    expect(del.isError).toBeFalsy();
    expect(payload(del)).toMatchObject({ deletedProjectId: "aaa-workspace" });

    const gone = await harness.call("mcp__genie__get_project", { projectId: workspaceId });
    expect(gone.isError).toBe(true);
    expect(gone.content?.[0]?.text ?? "").toContain("ERR_PROJECT_NOT_FOUND");
  });

  // Dedicated bind_kit tool round-trip. The `mcp__genie__bind_kit` verb is now
  // merged and registered (M1-20 / PR #100), so the literal AC4 `bind_kit` step
  // runs live here — no longer the create_project.kitBindings stand-in used by
  // the "end-state" test above. This drives the tool the AC actually names:
  // create the kit, create a *kitless* workspace, then bind through the tool and
  // confirm both the tool's own response and a subsequent get_project reflect it.
  it("bind_kit(project, kit) attaches the kit and get_project reflects the binding", async () => {
    const kitResult = await harness.call("mcp__genie__create_kit", { name: "Bindable Kit" });
    expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
    const { kitId } = payload(kitResult) as { kitId: string };

    // A workspace with NO bindings at creation — the binding must come entirely
    // from the bind_kit call, so this can't accidentally pass on create-time state.
    const projectId = await createProject({ name: "Bindable Workspace", kind: "workspace" });

    const preBind = await harness.call("mcp__genie__get_project", { projectId });
    expect(preBind.isError, JSON.stringify(preBind)).toBeFalsy();
    expect((payload(preBind) as { kitBindings: unknown[] }).kitBindings).toEqual([]);

    // bind_kit returns the updated ProjectSummary directly (its own contract).
    const bound = await harness.call("mcp__genie__bind_kit", {
      projectId,
      kitId,
      default: true,
    });
    expect(bound.isError, JSON.stringify(bound)).toBeFalsy();
    expect(payload(bound)).toMatchObject({
      id: projectId,
      kitBindings: [{ kitId, default: true }],
      defaultKitId: kitId,
    });

    // ...and the binding is durable: a fresh get_project sees the same state.
    const detail = await harness.call("mcp__genie__get_project", { projectId });
    expect(detail.isError).toBeFalsy();
    const body = payload(detail) as {
      kitBindings: { kitId: string; default?: boolean }[];
      defaultKitId?: string;
    };
    expect(body.kitBindings).toContainEqual({ kitId, default: true });
    expect(body.defaultKitId).toBe(kitId);
  });

  // conjure_screen with the offline scaffold generator (M1-21): binding a kit,
  // conjuring a screen against it, and confirming the screen is appended to the
  // project manifest that get_project returns. No model call — the M1 generator
  // is the deterministic LocalScaffoldScreenGenerator (AC8).
  it("conjure_screen against a bound kit appends a recorded screen to the project", async () => {
    const kitResult = await harness.call("mcp__genie__create_kit", { name: "Screen Kit" });
    expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
    const { kitId } = payload(kitResult) as { kitId: string };

    const projectId = await createProject({
      name: "Screen Workspace",
      kind: "workspace",
      kitBindings: [{ kitId, default: true }],
    });

    const conjured = await harness.call("mcp__genie__conjure_screen", {
      projectId,
      prompt: "A dashboard overview page with cards",
    });
    expect(conjured.isError, JSON.stringify(conjured)).toBeFalsy();
    const body = payload(conjured) as {
      screenId: string;
      files: { path: string; content: string; encoding: string }[];
      usage: { totalTokens: number };
    };
    expect(body.screenId).toMatch(/^[a-z0-9-]{3,64}$/);
    expect(body.files[0]?.path).toBe(`screens/${body.screenId}/index.tsx`);
    // Offline M1 generator → zero usage (AC8).
    expect(body.usage.totalTokens).toBe(0);

    // The screen is now recorded in the project manifest get_project returns (AC7).
    const detail = await harness.call("mcp__genie__get_project", { projectId });
    const screens = (payload(detail) as { screens: { id: string; path: string }[] }).screens;
    expect(screens.map((s) => s.id)).toContain(body.screenId);
  });
});

// ── AC6 — negative: planId enforcement ────────────────────────────────────────
describe("AC6 — write path enforces a valid planId", () => {
  it("write_files without a planId is rejected at the protocol layer (-32602)", async () => {
    // `planId` is a required, non-empty field in write_files' Zod input schema,
    // so an omitted planId never reaches the handler — the MCP SDK itself
    // rejects it at the protocol layer (InvalidParams, -32602) before
    // write_files' own handler runs. Unlike a thrown JS-level McpError, the
    // SDK server surfaces a *schema* validation failure as an isError:true
    // CallToolResult with the -32602 code embedded in the text, not a
    // rejected callTool() promise — the harness.call() helper models exactly
    // that (ToolResult, not a throw).
    const result = await harness.call("mcp__genie__write_files", {
      files: [{ path: "a.html", data: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("-32602");
  });

  it("write_files with a path outside the plan's writes returns a structured PathOutsidePlanError", async () => {
    // Distinct from the previous case: here planId IS present and valid, so
    // the call reaches the handler, which rejects the specific offending
    // path with its own structured (isError: true) payload — not a thrown
    // protocol error. (The issue's own AC4 - see DRO-236 - specs this exact
    // shape; the pre-existing scaffold's "-32602" placeholder predates the
    // tool's actual implementation.)
    // Local helper — `createKit` from the AC3 describe block above is scoped
    // to that block, not visible here.
    const kitResult = await harness.call("mcp__genie__create_kit", {
      name: "AC6 Outside-Plan Kit",
    });
    expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
    const { kitId } = payload(kitResult) as { kitId: string };

    const planResult = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["components/**"],
      localDir: join(harness.roots.kitsRoot, kitId),
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const { planId } = payload(planResult) as { planId: string };

    const result = await harness.call("mcp__genie__write_files", {
      planId,
      files: [{ path: "outside/evil.html", data: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      code: "PathOutsidePlanError",
      path: "outside/evil.html",
    });
  });
});

// ── AC7 — negative: conjure requires a bound kit ──────────────────────────────
describe("AC7 — conjure_screen requires a bound kit", () => {
  it("conjure_screen with a kit-specific prompt and no bound kit returns ERR_PROJECT_KIT_REQUIRED", async () => {
    // A kitless workspace + a prompt that names kit-level components must stop
    // rather than invent a kit (D-F ladder step 4; DS-026).
    const create = await harness.call("mcp__genie__create_project", {
      name: "Kitless Workspace",
      kind: "workspace",
    });
    expect(create.isError, JSON.stringify(create)).toBeFalsy();
    const { projectId } = payload(create) as { projectId: string };

    const result = await harness.call("mcp__genie__conjure_screen", {
      projectId,
      prompt: "A checkout page with a primary Button and a Card",
    });

    expect(result.isError).toBe(true);
    const err = parseText(result) as { code: string; projectId?: string };
    expect(err.code).toBe("ERR_PROJECT_KIT_REQUIRED");
    expect(err.projectId).toBe(projectId);
  });

  it("conjure_screen with a basic-structure prompt and no kit still succeeds (AC5)", async () => {
    // The permissive half of the same gate: a purely structural prompt may
    // generate a framework-neutral scaffold without a kit.
    const create = await harness.call("mcp__genie__create_project", {
      name: "Kitless Structure Workspace",
      kind: "workspace",
    });
    expect(create.isError, JSON.stringify(create)).toBeFalsy();
    const { projectId } = payload(create) as { projectId: string };

    const result = await harness.call("mcp__genie__conjure_screen", {
      projectId,
      prompt: "A landing page with a header, a hero section, and a footer",
    });

    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const body = payload(result) as { screenId: string };
    expect(body.screenId).toMatch(/^[a-z0-9-]{3,64}$/);
  });
});

// ── AC9 — wall-clock budget guard ─────────────────────────────────────────────
//
// The AC bounds the *whole* suite at < 60 s. Vitest's own run summary is the
// primary evidence for that (and the CI report artefact, AC8, captures it), but
// a silent 60 s ceiling is a tripwire nobody trips until CI is already slow. So
// we also assert an in-band budget on the single heaviest end-to-end walk: the
// full kit protocol (create → plan → write 5 → list → read → delete → validate)
// immediately followed by the full project protocol (create → bind → conjure →
// get → delete). Today that walk is single-digit milliseconds; we bound it at a
// deliberately generous 20 s so the guard fires only on a genuine order-of-
// magnitude regression (a real network call sneaking in, an O(n²) blow-up),
// never on ordinary CI jitter — while still leaving 40 s of headroom under the
// hard 60 s ceiling for the rest of the suite.
describe("AC9 — the end-to-end walk stays well within the 60 s suite budget", () => {
  const WALK_BUDGET_MS = 20_000;

  it(`a full kit + project walk completes in well under ${WALK_BUDGET_MS} ms`, async () => {
    const started = performance.now();

    // ── Kit protocol ──
    const kitResult = await harness.call("mcp__genie__create_kit", { name: "Budget Kit" });
    expect(kitResult.isError, JSON.stringify(kitResult)).toBeFalsy();
    const { kitId } = payload(kitResult) as { kitId: string };
    const kitDir = join(harness.roots.kitsRoot, kitId);

    const planResult = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["components/**/*.html"],
      localDir: kitDir,
    });
    expect(planResult.isError, JSON.stringify(planResult)).toBeFalsy();
    const { planId } = payload(planResult) as { planId: string };

    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `components/Budget${i}.html`,
      data: `<div>Budget ${i}</div>`,
    }));
    const writeResult = await harness.call("mcp__genie__write_files", { planId, files });
    expect(writeResult.isError, JSON.stringify(writeResult)).toBeFalsy();

    const listed = await harness.call("mcp__genie__list_files", { kitId });
    expect(listed.isError).toBeFalsy();
    const read = await harness.call("mcp__genie__read_file", {
      kitId,
      path: "components/Budget0.html",
    });
    expect(read.isError).toBeFalsy();

    const delPlan = await harness.call("mcp__genie__plan", {
      kitId,
      writes: ["**/*"],
      deletes: ["components/Budget0.html"],
    });
    expect(delPlan.isError, JSON.stringify(delPlan)).toBeFalsy();
    const { planId: delPlanId } = payload(delPlan) as { planId: string };
    const del = await harness.call("mcp__genie__delete_files", {
      planId: delPlanId,
      paths: ["components/Budget0.html"],
    });
    expect(del.isError).toBeFalsy();

    const validated = await harness.call("mcp__genie__validate", {
      kitId,
      counts: { total: 5, bad: 0, thin: 0, variantsIdentical: 0, iterations: 1 },
    });
    expect(validated.isError).toBeFalsy();

    // ── Project protocol ──
    const projResult = await harness.call("mcp__genie__create_project", {
      name: "Budget Workspace",
      kind: "workspace",
    });
    expect(projResult.isError, JSON.stringify(projResult)).toBeFalsy();
    const { projectId } = payload(projResult) as { projectId: string };

    const bound = await harness.call("mcp__genie__bind_kit", { projectId, kitId, default: true });
    expect(bound.isError, JSON.stringify(bound)).toBeFalsy();

    const conjured = await harness.call("mcp__genie__conjure_screen", {
      projectId,
      prompt: "A dashboard overview page with cards",
    });
    expect(conjured.isError, JSON.stringify(conjured)).toBeFalsy();

    const detail = await harness.call("mcp__genie__get_project", { projectId });
    expect(detail.isError).toBeFalsy();

    const deleted = await harness.call("mcp__genie__delete_project", { projectId });
    expect(deleted.isError).toBeFalsy();

    const elapsedMs = performance.now() - started;
    expect(
      elapsedMs,
      `end-to-end walk took ${elapsedMs.toFixed(0)} ms, over the ${WALK_BUDGET_MS} ms budget`,
    ).toBeLessThan(WALK_BUDGET_MS);
  });
});

// ── AC5 — GitHostStore / Gitea parity ─────────────────────────────────────────
//
// AC5 repeats the *MCP-tool* kit-metadata walk above against a `GitHostStore`
// backend, with a `gitea/gitea` container as the reference git host
// (testcontainers). It is driven through the SAME in-process MCP client the
// LocalFs walks use — the only difference is `createServer({ kitStore })` is
// handed a `GitHostKitStore` pointed at the live container (the DRO-523 AC1
// store-injection seam).
//
// ── Scope of this live walk (deliberate, and load-bearing) ────────────────────
// Only the `KitStore`-interface verbs run against Gitea here: create_kit,
// list_kits, get_kit, list_components. The file-content verbs
// (read_file/list_files/write_files/delete_files) and the rich project family
// remain filesystem-bound — they were never written against the
// KitStore/ProjectStore interfaces, so the seam does not (yet) carry them onto
// the git host. Re-plumbing those verbs + building a rich GitHostProjectStore is
// the tracked remainder (see the follow-up issues referenced in the PR). The
// store *contract* itself (incl. plan-branch isolation, project CRUD, bindKit)
// is separately proven end-to-end against this same Gitea container at the store
// layer in `packages/e2e/test/gitea-conformance.test.ts`. Together they cover
// AC5's "same outcomes as the LocalFs walks" for every surface that is
// git-host-ready today, and name exactly what is not.
//
// ── Docker-absent skip ───────────────────────────────────────────────────────
// The whole block is `describe.skipIf(!dockerAvailable)`, so a local `pnpm test`
// with no container runtime stays green (AC: "skipped automatically when no
// Docker daemon is present"). CI's Docker leg runs it for real and sets
// GENIE_REQUIRE_DOCKER=1 so a leg that lost its daemon fails loudly instead of
// passing vacuously.
describe.skipIf(!ac5DockerAvailable)(
  "AC5 — the suite repeats against GitHostStore (Gitea reference host)",
  () => {
    let gitea: GiteaFixture;
    let ac5Client: Client;
    let ac5Server: ReturnType<typeof createServer>;

    const call = (name: string, args: Record<string, unknown>) =>
      ac5Client.callTool({ name, arguments: args }) as Promise<ToolResult>;

    beforeAll(async () => {
      gitea = await startGitea();
      // The seam (AC1): point the kit-metadata verbs at the live Gitea via a
      // GitHostKitStore. Everything else (projects/files) keeps its default
      // LocalFs wiring — see the scope note above.
      const kitStore = new GitHostKitStore({
        baseUrl: gitea.baseUrl,
        owner: gitea.owner,
        token: gitea.token,
      });
      ac5Server = createServer({ kitStore });
      ac5Client = new Client({ name: "m1-conformance-ac5", version: "0" });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await Promise.all([ac5Server.connect(serverT), ac5Client.connect(clientT)]);
    }, 240_000); // cold-image pull + DB migration budget.

    afterAll(async () => {
      await ac5Client?.close();
      await gitea?.stop();
    });

    it("create_kit through the MCP surface persists into Gitea and round-trips via get_kit", async () => {
      const created = await call("mcp__genie__create_kit", { name: "Gitea Walk Kit" });
      expect(created.isError, JSON.stringify(created)).toBeFalsy();
      const { kitId } = payload(created) as { kitId: string };
      // Same slug contract as the LocalFs walk (AC3's create_kit assertion).
      expect(kitId).toMatch(/^gitea-walk-kit-[0-9a-f]{6}$/);

      // get_kit reads the record back — from Gitea, through the same tool the
      // LocalFs walk uses. The human name comes from the base64 .kit.json that
      // round-tripped through Gitea's contents API.
      const got = await call("mcp__genie__get_kit", { kitId });
      expect(got.isError, JSON.stringify(got)).toBeFalsy();
      expect(payload(got)).toMatchObject({
        id: kitId,
        name: "Gitea Walk Kit",
        type: "GENIE_KIT",
      });
    });

    it("list_kits surfaces a kit created through the MCP surface", async () => {
      const created = await call("mcp__genie__create_kit", { name: "Gitea Listed Kit" });
      expect(created.isError, JSON.stringify(created)).toBeFalsy();
      const { kitId } = payload(created) as { kitId: string };

      const listed = await call("mcp__genie__list_kits", {});
      expect(listed.isError, JSON.stringify(listed)).toBeFalsy();
      const ids = (payload(listed) as { kits: { id: string }[] }).kits.map((k) => k.id);
      expect(ids).toContain(kitId);
    });

    it("list_components validates the kit through Gitea and returns the (pre-M3) empty set", async () => {
      const created = await call("mcp__genie__create_kit", { name: "Gitea Components Kit" });
      expect(created.isError, JSON.stringify(created)).toBeFalsy();
      const { kitId } = payload(created) as { kitId: string };

      const components = await call("mcp__genie__list_components", { kitId });
      expect(components.isError, JSON.stringify(components)).toBeFalsy();
      // Same outcome as the LocalFs walk: empty until the M3-03 manifest compiler.
      expect((payload(components) as { components: unknown[] }).components).toEqual([]);
    });

    it("get_kit on a kit that never existed in Gitea is rejected (parity with the LocalFs negative)", async () => {
      const got = await call("mcp__genie__get_kit", { kitId: "ghost-kit-000000" });
      expect(got.isError).toBe(true);
    });
  },
);
