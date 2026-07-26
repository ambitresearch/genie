/**
 * Cross-cutting regression lock for the kitId gate asymmetry.
 *
 * genie has two kitId rules and they disagreed about which kits are usable:
 *
 *   - `isSafeKitId` (store/kit-files.ts) — the SAFETY rule, and the authority for
 *     its own rejection set: read the predicate, do not re-derive it here. It is
 *     the rule both store adapters (`store/local.ts`, `store/git-host.ts`) enforce.
 *     It guarantees an accepted id SPELLS THE DIRECTORY IT OPENS — strictly
 *     stronger than "stays under the kits root", and the distinction is load-
 *     bearing: `victim.` never leaves the root, yet Windows trims the trailing
 *     dot at the syscall boundary and opens the sibling kit `victim`. Framing
 *     this as pure containment ("everything else is a literal child, so it
 *     cannot escape") is what let three separate alias classes through review.
 *     It does NOT promise the filesystem has only one spelling for that
 *     directory — case folding and NTFS 8.3 short names are alternate spellings
 *     of ONE kit, explicitly out of scope; the predicate names them.
 *   - `KIT_ID_PATTERN` `/^[a-z0-9-]{3,64}$/` (tools/get_kit.ts) — a SHAPE rule
 *     describing ids MINTED by `create_kit`.
 *
 * `KitId` is documented as an opaque, adapter-assigned string, and `list_kits`
 * promises the ids it returns are valid input to kit-taking verbs — `get_kit`'s
 * own description says so ("confirm a kitId (e.g. from list_kits) is valid").
 * A git-host kit maps a kitId to a REPO NAME, and GitHub repo names permit
 * uppercase, `_`, `.`, and single characters; a hand-imported kit directory is
 * listable under any containment-safe name. So an imported kit legitimately
 * named `My_Kit.2` was listable, browsable, readable and plannable through the
 * broad rule, but NOT gettable, bindable, conjurable, refinable or previewable
 * through the narrow one. Visible and unusable.
 *
 * Precedent: #252 gave `plan` an existence requirement, #263 moved `plan` off
 * `KIT_ID_PATTERN` onto `isSafeKitId` after a review finding. `plan.ts` carries
 * the canonical rationale. This file extends that same correction to the rest of
 * the kit-taking surface and locks it in one place, so a future tool cannot
 * reintroduce the split by copying the wrong predicate.
 *
 * The 🔒 tests are the regression locks.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../server.js";
import { KIT_TYPE } from "../store/interface.js";
import type { KitStore } from "../store/interface.js";
import { isSafeKitId } from "../store/kit-files.js";
import { LocalFsKitStore } from "../store/local.js";
import { MANIFEST_PATH } from "../store/manifest.js";
import { resolveKitDir as resolveGridKitDir } from "../ui/grid-resource.js";
import { seedKit } from "../../test/helpers/seed-kit.js";
import { ProjectNotFoundError, getKit } from "./get_kit.js";
import { listWritableKits } from "./list_kits.js";
import type { BootRequest, BootedViewer, ViewerBooter } from "./preview.js";
import { InvalidKitIdError, resolveKitDir as resolvePreviewKitDir } from "./preview.js";

/**
 * Ids a `create_kit`-minted slug would never produce but an imported or
 * git-host kit legitimately can. Every one of these is safe on BOTH counts
 * `isSafeKitId` guarantees: each resolves to a literal child of the kits root
 * (never above it) AND survives a Win32 trailing-[ .] trim unchanged, so each
 * spells the directory it opens on every platform.
 */
const IMPORTED_KIT_IDS = ["My_Kit.2", "a", "UPPER"] as const;

/** The id the end-to-end suite exercises through the whole verb surface. */
const IMPORTED_KIT_ID = "My_Kit.2";

/** A stub viewer booter so `preview` never starts a real Vite server. */
function stubBooter(url = "http://127.0.0.1:5173/"): ViewerBooter {
  return (_req: BootRequest): Promise<BootedViewer> =>
    Promise.resolve({
      url,
      port: 5173,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
}

/**
 * Scaffold a kit the way an import or a git-host clone would: a real
 * `.kit.json` marked `GENIE_KIT` plus one `@genie`-marked component, written
 * directly under the kits root with NO create_kit involvement. This is exactly
 * what `LocalFsKitStore.listKits` walks — it filters on the marker file, not on
 * the id's charset.
 */
async function seedImportedKit(kitsRoot: string, kitId: string): Promise<void> {
  // `.kit.json` — the store's only publication point — comes from the shared
  // helper. Hand-rolling it here duplicated `seedKit`'s body and hardcoded the
  // `"GENIE_KIT"` type literal where a `KIT_TYPE` constant already existed,
  // which is precisely the copy-instead-of-import drift this file exists to
  // stop (`list_components` carried its own copy of KIT_ID_PATTERN for the
  // same reason). The scaffold below is the genuine extra this suite needs.
  const kitDir = await seedKit(kitsRoot, kitId, `Imported ${kitId}`);

  const compDir = join(kitDir, "components", "actions", "Button");
  await mkdir(compDir, { recursive: true });
  await writeFile(
    join(compDir, "preview.html"),
    '<!-- @genie group="actions" viewport="480x240" name="Get Started" -->\n' +
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /></head>' +
      "<body><button>Get Started</button></body></html>\n",
    "utf-8",
  );

  // A compiled card index, as the M3-03 compiler would leave behind on a kit
  // imported from a git host. `list_components` reads this, not the preview
  // files, so without it the verb legitimately reports zero components and the
  // gate assertion below would prove nothing.
  await mkdir(join(kitDir, ".genie"), { recursive: true });
  await writeFile(
    join(kitDir, MANIFEST_PATH),
    JSON.stringify({
      version: 1,
      components: [
        {
          name: "Button",
          group: "actions",
          path: "components/actions/Button/preview.html",
          viewport: "480x240",
          hash: "0".repeat(8),
          lastModified: new Date().toISOString(),
        },
      ],
    }),
    "utf-8",
  );
}

// ─── End-to-end: the promise `list_kits` makes ───────────────────────────────

/** The text content of every verb here is JSON; this unwraps it. */
const payload = (result: unknown): Record<string, unknown> => {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
};

describe("kitId gate — an imported kit is usable end to end", () => {
  let tempDir: string;
  let kitsRoot: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-gate-"));
    process.env.GENIE_HOME = tempDir;
    kitsRoot = join(tempDir, "kits");
    await mkdir(kitsRoot, { recursive: true });
    await seedImportedKit(kitsRoot, IMPORTED_KIT_ID);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      kitsRoot,
      projectsRoot: join(tempDir, "projects"),
      previewBooter: stubBooter(),
    });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("list_kits returns the imported kit — this is the promise every verb below must honour", async () => {
    const result = await client.callTool({ name: "mcp__genie__list_kits", arguments: {} });

    expect(result.isError).toBeFalsy();
    // `list_kits` serialises the bare array as its text content.
    const kits = payload(result) as unknown as { id: string }[];
    expect(kits.map((k) => k.id)).toContain(IMPORTED_KIT_ID);
  });

  it("list_files and read_file already honour it (the broad rule)", async () => {
    const listed = await client.callTool({
      name: "mcp__genie__list_files",
      arguments: { kitId: IMPORTED_KIT_ID },
    });
    expect(listed.isError, JSON.stringify(listed)).toBeFalsy();

    const read = await client.callTool({
      name: "mcp__genie__read_file",
      arguments: { kitId: IMPORTED_KIT_ID, path: "components/actions/Button/preview.html" },
    });
    expect(read.isError, JSON.stringify(read)).toBeFalsy();
  });

  it("plan already honours it (#263)", async () => {
    const result = await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId: IMPORTED_KIT_ID, writes: ["*.html"], localDir: tempDir },
    });

    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(payload(result).planId).toBeTruthy();
  });

  it("🔒 get_kit resolves an imported kit", async () => {
    // The defect: `getKitArgsSchema` gated on the create_kit SHAPE, so a kit
    // `list_kits` had just returned failed its own validity check. Containment
    // still matters here — `LocalFsKitStore.getKit` resolves through `kitDir`,
    // not `safeKitDir` — so the guard is relaxed to `isSafeKitId`, not removed.
    for (const kitId of IMPORTED_KIT_IDS) {
      await seedImportedKit(kitsRoot, kitId);

      const result = await client.callTool({
        name: "mcp__genie__get_kit",
        arguments: { kitId },
      });

      expect(
        result.isError,
        `expected get_kit to resolve ${kitId}: ${JSON.stringify(result)}`,
      ).toBeFalsy();
      expect(payload(result)).toMatchObject({ id: kitId, type: "GENIE_KIT" });
    }
  });

  it("🔒 bind_kit binds an imported kit to a project", async () => {
    // Two gates had to move for this: `bind_kit`'s own `kitIdSchema`, AND
    // `get_kit`'s — `ProjectStore.assertKitExists` calls `getKit()` and maps its
    // ZodError to ERR_KIT_NOT_FOUND, so relaxing only `bind_kit` would have left
    // the same failure behind a misleading "kit not found".
    const created = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Gate Project", kind: "workspace" },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const projectId = payload(created).projectId as string;

    const result = await client.callTool({
      name: "mcp__genie__bind_kit",
      arguments: { projectId, kitId: IMPORTED_KIT_ID },
    });

    expect(
      result.isError,
      `expected bind_kit to accept the kit: ${JSON.stringify(result)}`,
    ).toBeFalsy();
    const bindings = (payload(result).kitBindings ?? []) as { kitId: string }[];
    expect(bindings.map((b) => b.kitId)).toContain(IMPORTED_KIT_ID);
  });

  it("🔒 list_components lists an imported kit's components", async () => {
    // Found while writing this lock: `list_components` carried its OWN inline
    // copy of the slug regex rather than importing `KIT_ID_PATTERN`, so a grep
    // for the constant missed it entirely. It is a pure read verb — the same
    // family as `list_files` and `read_file`, which both gate on containment.
    const result = await client.callTool({
      name: "mcp__genie__list_components",
      arguments: { kitId: IMPORTED_KIT_ID },
    });

    expect(
      result.isError,
      `expected list_components to accept the kit: ${JSON.stringify(result)}`,
    ).toBeFalsy();
    // Like `list_kits`, the text content is the bare array.
    const components = payload(result) as unknown as { name: string }[];
    expect(components.map((c) => c.name)).toContain("Button");
  });

  it("🔒 preview previews an imported kit", async () => {
    const result = await client.callTool({
      name: "mcp__genie__preview",
      arguments: { kitId: IMPORTED_KIT_ID },
    });

    expect(
      result.isError,
      `expected preview to accept the kit: ${JSON.stringify(result)}`,
    ).toBeFalsy();
  });

  it("🔒 conjure_screen accepts an imported kit as its explicit kitId", async () => {
    const created = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Screen Project", kind: "workspace" },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const projectId = payload(created).projectId as string;

    const result = await client.callTool({
      name: "mcp__genie__conjure_screen",
      arguments: {
        projectId,
        kitId: IMPORTED_KIT_ID,
        prompt: "A settings screen with a save button.",
      },
    });

    expect(
      result.isError,
      `expected conjure_screen to accept the kit: ${JSON.stringify(result)}`,
    ).toBeFalsy();
  });

  it("still refuses containment-unsafe kitIds everywhere", async () => {
    // Relaxing the SHAPE rule must not relax the SAFETY rule. `""`, `.`, `..`
    // and any separator still escape the single-kit namespace and are still
    // refused by every verb.
    //
    // The trailing-space/dot entries are Win32 aliases: Windows trims a trailing
    // run of spaces and dots from a path component at the syscall boundary. Two
    // sub-cases, and missing the second cost a review round — `".. "` reaches the
    // filesystem as `".."` (escapes the root), while `"My_Kit.2."` reaches it as
    // `"My_Kit.2"` (stays inside the root but names a DIFFERENT, live kit). The
    // old per-tool slug gate banned spaces and dots and so refused both by
    // accident; this list makes the refusal deliberate and cross-gate.
    //
    // NOTE this loop is deliberately NON-discriminating: `assertKitLive` maps a
    // gate rejection AND a genuine miss to the same `KitNotFoundError`, so that
    // the tool boundary never leaks whether a kit exists. It therefore proves
    // these ids are refused, not WHICH rule refused them — and it passed for
    // `" "` even before the Win32 aliases were closed. The discriminating locks
    // are `isSafeKitId`'s own unit tests (store/kit-files.test.ts) and the two
    // `resolveKitDir` tests below, which observe the containment decision itself.
    for (const bad of [
      "",
      "..",
      ".",
      "../escape",
      "a/b",
      "a\\b",
      " ",
      ". ",
      ".. ",
      "...",
      // Win32 alias of a kit that is LIVE in this suite — see the note above.
      `${IMPORTED_KIT_ID}.`,
    ]) {
      for (const name of [
        "mcp__genie__get_kit",
        "mcp__genie__preview",
        "mcp__genie__list_files",
        "mcp__genie__plan",
      ]) {
        const args =
          name === "mcp__genie__plan" ? { kitId: bad, writes: ["*.html"] } : { kitId: bad };
        const result = await client
          .callTool({ name, arguments: args })
          .then((r) => ({ ok: !r.isError }))
          .catch(() => ({ ok: false }));

        expect(result.ok, `${name} must refuse kitId ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });
});

// ─── The advertised contract ─────────────────────────────────────────────────

describe("kitId gate — the advertised input contract", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-schema-"));
    process.env.GENIE_HOME = tempDir;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      kitsRoot: join(tempDir, "kits"),
      projectsRoot: join(tempDir, "projects"),
      previewBooter: stubBooter(),
    });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("🔒 no kit-taking tool advertises the create_kit-minted slug shape on kitId", async () => {
    // The pattern surfaces in `tools/list`, so a harness reads it as "these are
    // the only ids this verb accepts" and can refuse to even attempt a call.
    // Locking the ADVERTISED schema covers `conjure` and `refine` too, whose
    // handlers need a live endpoint to reach.
    const { tools } = await client.listTools();
    const offenders: string[] = [];

    for (const tool of tools) {
      const schema = tool.inputSchema as
        | { properties?: Record<string, { pattern?: string }> }
        | undefined;
      const pattern = schema?.properties?.kitId?.pattern;
      if (pattern !== undefined && pattern.includes("a-z0-9-")) {
        offenders.push(`${tool.name} -> ${pattern}`);
      }
    }

    expect(
      offenders,
      "these verbs advertise the create_kit shape as their kitId contract, which " +
        "contradicts list_kits' promise for imported and git-host kits",
    ).toEqual([]);
  });
});

// ─── Unit: the two path resolvers ────────────────────────────────────────────

describe("kitId gate — resolveKitDir containment", () => {
  it("🔒 preview.resolveKitDir accepts containment-safe non-slug ids", () => {
    for (const kitId of IMPORTED_KIT_IDS) {
      expect(() => resolvePreviewKitDir("/kits", kitId)).not.toThrow();
      expect(resolvePreviewKitDir("/kits", kitId)).toBe(join("/kits", kitId));
    }
  });

  it("preview.resolveKitDir still rejects escapes", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "../escape",
      "a/b",
      "a\\b",
      " ",
      ". ",
      ".. ",
      "...",
      // DISCRIMINATING: `My_Kit.2` is seeded and resolvable, so without the
      // trailing-[ .] guard this resolver returns a live directory for an id
      // that is not that kit's name. Unlike the loop in Part D, both
      // resolvers observe the safety decision itself rather than a
      // KitNotFoundError that a genuine miss would also produce.
      `${IMPORTED_KIT_ID}.`,
    ]) {
      expect(
        () => resolvePreviewKitDir("/kits", bad),
        `expected ${JSON.stringify(bad)} to be refused`,
      ).toThrow(InvalidKitIdError);
    }
  });

  it("🔒 grid-resource.resolveKitDir accepts containment-safe non-slug ids", () => {
    for (const kitId of IMPORTED_KIT_IDS) {
      expect(resolveGridKitDir("/kits", kitId)).toBe(join("/kits", kitId));
    }
  });

  it("grid-resource.resolveKitDir still rejects escapes", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "../escape",
      "a/b",
      "a\\b",
      " ",
      ". ",
      ".. ",
      "...",
      // DISCRIMINATING: `My_Kit.2` is seeded and resolvable, so without the
      // trailing-[ .] guard this resolver returns a live directory for an id
      // that is not that kit's name. Unlike the loop in Part D, both
      // resolvers observe the safety decision itself rather than a
      // KitNotFoundError that a genuine miss would also produce.
      `${IMPORTED_KIT_ID}.`,
    ]) {
      expect(resolveGridKitDir("/kits", bad), `expected ${JSON.stringify(bad)} null`).toBeNull();
    }
  });

  it("the containment rule is the shared one", () => {
    // Both resolvers must agree with `isSafeKitId` exactly — that is the point
    // of the fix. If a future edit re-tightens one of them, this catches it.
    for (const id of [...IMPORTED_KIT_IDS, "..kit", "with space", "ab", "a".repeat(65)]) {
      expect(isSafeKitId(id), id).toBe(true);
      expect(resolveGridKitDir("/kits", id), id).toBe(join("/kits", id));
      expect(() => resolvePreviewKitDir("/kits", id)).not.toThrow();
    }
  });
});

// ─── Part F: relaxing shape must NOT weaken existence ────────────────────────
//
// Relaxing a shape gate is only safe if something else still refuses a kit that
// does not exist — otherwise this fix would trade one defect (#263 class) for
// another (#252 class). It was NOT obvious from `bind_kit.ts` that anything
// did: `bindKit()` is `bindKitArgsSchema.parse(args)` then `store.bindKit()`,
// with no tool-layer existence check at all.
//
// Verified in `create_project.ts`: `ProjectStore.bindKit` calls
// `assertKitExists(kitId)`, which calls `getKit(kitStore, { kitId })` and maps
// every failure — including `z.ZodError` — to `ERR_KIT_NOT_FOUND`. So the
// existence guarantee lives in the STORE, one layer below the schema, and is
// untouched by this change. That mapping is also exactly why relaxing
// `get_kit`'s schema was load-bearing for `bind_kit`.
//
// Nothing was changed for this; the test pins the behaviour so a future
// refactor cannot quietly delete it.
describe("kitId gate — shape is relaxed, existence is not", () => {
  let client: Client;
  let kitsRoot: string;
  let projectsRoot: string;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "genie-kit-gate-f-"));
    kitsRoot = join(root, "kits");
    projectsRoot = join(root, "projects");
    await mkdir(kitsRoot, { recursive: true });
    await mkdir(projectsRoot, { recursive: true });
    await seedImportedKit(kitsRoot, IMPORTED_KIT_ID);

    const server = createServer({ kitsRoot, projectsRoot, previewBooter: stubBooter() });
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanup = async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("🔒 bind_kit still refuses a containment-safe kitId that does not exist", async () => {
    const created = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Existence Project", kind: "workspace" },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const projectId = payload(created).projectId as string;

    // Passes `isSafeKitId` — so the schema lets it through — but no such kit
    // was seeded. The store must still reject it.
    const result = await client.callTool({
      name: "mcp__genie__bind_kit",
      arguments: { projectId, kitId: "No_Such_Kit.9" },
    });

    expect(
      result.isError,
      `expected bind_kit to reject a missing kit: ${JSON.stringify(result)}`,
    ).toBe(true);
    expect(JSON.stringify(result)).toContain("ERR_KIT_NOT_FOUND");
  });

  it("🔒 get_kit still refuses a containment-safe kitId that does not exist", async () => {
    const result = await client.callTool({
      name: "mcp__genie__get_kit",
      arguments: { kitId: "No_Such_Kit.9" },
    });

    expect(
      result.isError,
      `expected get_kit to reject a missing kit: ${JSON.stringify(result)}`,
    ).toBe(true);
  });
});

// ─── `list_kits`' promise survives a `.kit.json` that disagrees ──────────────

/**
 * This suite began as a PIN on a defect and is now a LOCK on its fix. The
 * history matters, because the assertions below are inverted from what they
 * originally asserted and a reader who assumes otherwise will misread them.
 *
 * The first suite in this file asserts a promise: "list_kits returns the
 * imported kit — this is the promise every verb below must honour". That
 * promise used to have a hole, and it was never a gate defect. The two
 * `KitStore` adapters disagreed about what a LocalFs kit's identity IS:
 *
 *   - `GitHostKitStore` — `listKits` returned `id: repo.name` and `readKitMeta`
 *     returned `id: kitId`, deliberately DISCARDING any `id` inside `.kit.json`
 *     ("the repository name is authoritative for the kit's identity"). List and
 *     get therefore routed through the same value and could not diverge.
 *   - `LocalFsKitStore` — `listKits` returned `id: meta.id`, read out of each
 *     `<dir>/.kit.json`, while `getKit` resolved `kitMetaPath(kitId)` =
 *     `join(baseDir, kitId, ".kit.json")`, i.e. it treated the id as a DIRECTORY
 *     NAME. A hand-imported or restored-from-backup kit whose `.kit.json`
 *     declared an id that was not its directory name therefore got advertised
 *     under an id `get_kit` could not resolve.
 *
 * #282 closed that: LocalFs now reports the DIRECTORY name from `listKits` and
 * the LOOKUP KEY from `getKit`, matching GitHost. The `.kit.json` `id` field is
 * no longer authoritative for routing on either adapter.
 *
 * What is left to test here is the part #282's own suite does not reach. That
 * suite (`test/store-conformance.test.ts`, "reports the routing key as the id
 * when .kit.json embeds a divergent one") drives the STORE objects directly.
 * These tests drive the MCP tools over a real client — `list_kits` then
 * `get_kit` — because the promise this file asserts is made by the TOOLS, and a
 * store-layer alignment only honours it if the tool layer passes the value
 * through unmodified. That is a separate claim about a separate layer.
 *
 * Every other fixture in this file (and `test/helpers/seed-kit.ts`) writes
 * `id: kitId` into `<kitsRoot>/<kitId>/`, forcing dirname === id, so no other
 * test in this file can reach the divergent case at all. The narrow
 * `KIT_ID_PATTERN` gate used to mask it for ids like `My_Kit.2` by refusing them
 * earlier, for the wrong reason.
 */
describe("kitId gate — list_kits' promise holds when .kit.json disagrees", () => {
  let tempDir: string;
  let kitsRoot: string;
  let client: Client;

  /**
   * The id `.kit.json` declares. Deliberately NOT the directory name, and
   * deliberately containment-safe: if the gate refused it, these tests could
   * pass for the wrong reason.
   */
  const DECLARED_ID = "My_Kit.2";
  /** The directory that actually holds the kit — the routing key. */
  const DIR_NAME = "physical-name";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-divergent-"));
    process.env.GENIE_HOME = tempDir;
    kitsRoot = join(tempDir, "kits");
    await mkdir(kitsRoot, { recursive: true });

    await seedImportedKit(kitsRoot, DIR_NAME);
    // Re-declare a DIFFERENT id than the directory name. This is the only
    // divergence; the kit is otherwise byte-identical to every other fixture.
    await writeFile(
      join(kitsRoot, DIR_NAME, ".kit.json"),
      JSON.stringify({
        id: DECLARED_ID,
        name: `Imported ${DECLARED_ID}`,
        type: "GENIE_KIT",
        createdAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      kitsRoot,
      projectsRoot: join(tempDir, "projects"),
      previewBooter: stubBooter(),
    });
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GENIE_HOME;
  });

  it("🔒 the routing key is the id on both sides of the store (#282)", async () => {
    const store = new LocalFsKitStore(kitsRoot);

    // The gate admits the declared id, so nothing below can be explained by the
    // containment rule refusing it. This line is what makes the test a store
    // identity test rather than a gate test.
    expect(isSafeKitId(DECLARED_ID)).toBe(true);

    // `listKits` reports the DIRECTORY, not `.kit.json`'s `id`...
    expect((await store.listKits()).map((kit) => kit.id)).toEqual([DIR_NAME]);

    // ...`getKit` echoes the LOOKUP KEY it was given, so a caller can round-trip
    // a listed id without it changing under them...
    expect((await getKit(store, { kitId: DIR_NAME })).id).toBe(DIR_NAME);

    // ...and the never-routable declared id resolves to nothing. Keeping this
    // assertion is what stops the test passing on a fixture that merely forgot
    // to diverge: `.kit.json` really does say something else.
    await expect(getKit(store, { kitId: DECLARED_ID })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it("🔒 the promise holds over MCP: every id list_kits offers, get_kit resolves", async () => {
    const listed = await client.callTool({ name: "mcp__genie__list_kits", arguments: {} });
    expect(listed.isError, JSON.stringify(listed)).toBeFalsy();
    const ids = (payload(listed) as unknown as { id: string }[]).map((k) => k.id);

    // Non-vacuity: the divergent fixture is the ONLY kit here, so an empty or
    // filtered listing cannot satisfy the loop below by having nothing to check.
    expect(ids).toEqual([DIR_NAME]);

    for (const kitId of ids) {
      const got = await client.callTool({ name: "mcp__genie__get_kit", arguments: { kitId } });
      // `isError` is OMITTED on success rather than set to `false`, so the
      // assertion has to be falsy-shaped (as the `list_kits` call above already
      // is). The `id` echo on the next line is what makes this discriminating:
      // an error result carries a text blob, not a kit, so it cannot pass.
      expect(
        got.isError,
        `advertised but unresolvable: ${kitId} — ${JSON.stringify(got)}`,
      ).toBeFalsy();
      expect((payload(got) as unknown as { id: string }).id).toBe(kitId);
    }

    // And the id `.kit.json` declares is NOT what the tools traffic in, so a
    // caller who reads the file by hand and passes that id gets a clean 404
    // rather than a silently different kit.
    const stale = await client.callTool({
      name: "mcp__genie__get_kit",
      arguments: { kitId: DECLARED_ID },
    });
    expect(stale.isError, `expected the non-routing id to 404: ${JSON.stringify(stale)}`).toBe(
      true,
    );
  });
});

// ─── Part H: a TIGHTENING must not re-break `list_kits`' promise either ──────
//
// Review round 7 on #277, and a defect this branch introduced itself.
//
// The trailing-[ .] guard is platform-INDEPENDENT by design: a plan authored on
// Linux may be executed on Windows, and a git-host kit is shared across both, so
// the set of usable ids cannot depend on where the server happens to run.
// Consequence: `victim.` and `victim ` are refused everywhere — including POSIX,
// where they are legitimate, DISTINCT directory names that `mkdir` accepts.
//
// At the time of that round `LocalFsKitStore.listKits` applied no predicate at
// all, so tightening the gate without touching the listing put `list_kits`
// straight back into the position this whole file exists to fix — advertising an
// id every kit-taking verb refuses. Part A asserts that promise; this part stops
// a safety fix from quietly falsifying it.
//
// The fix belongs at the LISTING, not the gate. Relaxing the gate per-platform
// would be strictly worse: it would make an id that is merely unusable on Linux
// actively DESTRUCTIVE on Windows, where `victim.` opens the sibling `victim`
// through the unsafe `kitDir` that `writeFiles`/`deleteFile` resolve through.
//
// `listWritableKits` is the single choke point the `list_kits` tool renders, so
// one filter there restores the promise for every store adapter at once.
//
// Distinct from Part G: that suite locks WHICH FIELD is authoritative for a
// LocalFs kit's identity (the routing key, not `.kit.json`'s `id`) — its
// `My_Kit.2` fixture clears `isSafeKitId`, so it is untouched by this filter.
//
// #282 subsequently added the same predicate to BOTH shipped adapters'
// `listKits`, which is why this suite drives a hand-written store instead of
// `LocalFsKitStore`. That is not a workaround for the test going green — it is
// the only honest way to test a defence-in-depth layer. With a real adapter the
// tool-layer filter is unreachable, so a passing test would prove the ADAPTER
// filters and say nothing about `listWritableKits`. `KitStore` is a public
// interface; an adapter that does not implement the invariant is exactly the
// case this layer exists for, and it is the case a real adapter cannot produce.
// The shipped adapters are covered separately in `test/store-conformance.test.ts`
// ("omits a directory whose name isSafeKitId rejects" / "omits a listed
// repository whose name isSafeKitId rejects").
describe("kitId gate — list_kits never advertises an id the gate refuses", () => {
  let tempDir: string;
  let kitsRoot: string;

  /** Refused by `isSafeKitId`: Win32 trims the trailing dot onto `victim`. */
  const ALIAS_ID = "victim.";
  /** An ordinary kit, so an empty listing cannot pass these tests by accident. */
  const SAFE_ID = "My_Kit.2";

  /**
   * A `KitStore` that does NOT honour the listing invariant. Only the two
   * methods this suite exercises are implemented; the rest of the surface
   * throws, so a future test that strays past `listKits`/`getKit` fails loudly
   * instead of silently reading `undefined`.
   *
   * `listKits` reports the alias, which is precisely what the shipped adapters
   * no longer do — that is the point. `getKit` resolves anything it was handed,
   * modelling an adapter with no containment logic of its own, so the ONLY
   * thing standing between the alias and a caller is `listWritableKits`.
   */
  function nonConformingStore(ids: string[]): KitStore {
    const meta = (id: string) => ({
      id,
      name: `Imported ${id}`,
      type: KIT_TYPE,
      createdAt: new Date().toISOString(),
    });
    return new Proxy(
      {
        listKits: async () => ids.map(meta),
        getKit: async (kitId: string) => meta(kitId),
      },
      {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          throw new Error(`nonConformingStore: unexpected KitStore call ${String(prop)}`);
        },
      },
    ) as unknown as KitStore;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-listing-"));
    kitsRoot = join(tempDir, "kits");
    await mkdir(kitsRoot, { recursive: true });
    await seedImportedKit(kitsRoot, SAFE_ID);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("🔒 an id the shared gate refuses is not advertised by list_kits", async () => {
    const store = nonConformingStore([SAFE_ID, ALIAS_ID]);

    // Precondition: the store really does surface it, so the filter below is
    // load-bearing rather than vacuous. Asserted against the injected store,
    // because no shipped adapter can be made to produce this input any more.
    expect((await store.listKits()).map((kit) => kit.id)).toContain(ALIAS_ID);
    expect(isSafeKitId(ALIAS_ID)).toBe(false);

    const ids = (await listWritableKits(store)).map((kit) => kit.id);

    expect(ids).not.toContain(ALIAS_ID);
    expect(ids).toContain(SAFE_ID);
  });

  it("🔒 every id list_kits advertises clears the gate", async () => {
    const store = nonConformingStore([SAFE_ID, ALIAS_ID, "..", "a/b", ""]);

    const listed = await listWritableKits(store);
    expect(listed.length).toBeGreaterThan(0);

    // The promise, stated as a property rather than a case list: anything
    // `list_kits` offers must clear the gate. A future tightening of
    // `isSafeKitId` that forgets the listing fails here without needing a new
    // case added alongside it.
    for (const kit of listed) {
      expect(isSafeKitId(kit.id), `advertised but gate-refused: ${kit.id}`).toBe(true);
    }
    expect(listed.map((kit) => kit.id)).toEqual([SAFE_ID]);
  });

  // The end-to-end half of the same promise, on a real adapter: what survives
  // the filter must also RESOLVE. Split from the property test above because
  // `nonConformingStore.getKit` resolves anything by construction, so pairing
  // the two against it would assert nothing about resolution.
  it("🔒 every id list_kits advertises round-trips through get_kit", async () => {
    const store = new LocalFsKitStore(kitsRoot);

    const listed = await listWritableKits(store);
    expect(listed.map((kit) => kit.id)).toEqual([SAFE_ID]);

    for (const kit of listed) {
      expect(isSafeKitId(kit.id), `advertised but gate-refused: ${kit.id}`).toBe(true);
      await expect(getKit(store, { kitId: kit.id })).resolves.toMatchObject({ id: kit.id });
    }
  });
});
