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
 *     create_kit, list_files, list_components, read_file, validate,
 *     create_project, list_projects, get_project, delete_project, (get_kit, list_kits),
 *     plan (M1-07 / DRO-235), write_files (M1-08 / DRO-236), conjure_screen (M1-21)
 *
 *   In_review / not yet registered — stubbed as it.todo, wired to their issue:
 *     delete_files    M1-09 (write_files' sibling verb; DRO-236 covers write_files only)
 *     bind_kit        DRO-246 (M1-11) — dedicated tool; AC4 exercises the same
 *                     end-state today via create_project's kitBindings input
 *     GitHostStore/Gitea parity (AC5) — testcontainers infra, M1-01 git-host path
 *
 * ── Acceptance criteria map ─────────────────────────────────────────────────
 *   AC1  file path (this file)                              ✓ satisfied
 *   AC2  in-process SDK test transport                      ✓ live
 *   AC3  kit protocol walk                                  ◑ plan/write_files live; delete_files todo (M1-09)
 *   AC4  project/blueprint walk                             ◑ CRUD+blueprint+conjure_screen live; dedicated bind_kit tool todo (DRO-246)
 *   AC5  GitHostStore/Gitea parity                          ○ todo (infra)
 *   AC6  negative: write without/outside planId → -32602    ✓ live (DRO-236)
 *   AC7  negative: conjure_screen no kit → ERR_PROJECT_KIT_REQUIRED  ✓ live (M1-21)
 *   AC8  test report uploaded as CI artefact                — CI wiring (see .github/workflows)
 *   AC9  suite < 60 s wall-clock                            ✓ live walk is ~ms; guarded below
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server/src/server.js";

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
// and validate. The plan→write→delete middle is todo pending DRO-235/236.

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
  // round-trip. `delete_files` doesn't exist yet (M1-09), so the walk stops
  // short of the delete step — tracked as its own todo below.
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

  // delete_files doesn't exist yet — M1-09.
  it.todo("delete_files removes a written file and list_files no longer reports it [blocked by M1-09]");
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

  // Dedicated bind_kit tool round-trip — needs DRO-246 (M1-11).
  it.todo("bind_kit(project, kit) then get_project reflects the binding [blocked by DRO-246]");

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

// ── AC5 — GitHostStore / Gitea parity ─────────────────────────────────────────
describe("AC5 — the suite repeats against GitHostStore (Gitea reference host)", () => {
  it.todo(
    "run the kit + project walks against GitHostStore via a testcontainers gitea/gitea instance [blocked by git-host adapter + CI infra]",
  );
});
