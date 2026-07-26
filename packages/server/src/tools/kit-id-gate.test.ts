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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../server.js";
import { KIT_TYPE } from "../store/interface.js";
import type { KitStore } from "../store/interface.js";
import { isSafeKitId, KIT_ID_SAFETY_MESSAGE } from "../store/kit-files.js";
import { LocalFsKitStore } from "../store/local.js";
import { MANIFEST_PATH } from "../store/manifest.js";
import { resolveKitDir as resolveGridKitDir } from "../ui/grid-resource.js";
import { seedKit } from "../../test/helpers/seed-kit.js";
import { ProjectNotFoundError, getKit } from "./get_kit.js";
import { listWritableKits } from "./list_kits.js";
import { registerPlan } from "./plan.js";
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

  it("🔒 every containment-gated kit-taking verb refuses an unsafe kitId at its own gate", async () => {
    // Relaxing the SHAPE rule must not relax the CONTAINMENT rule. `""`, `.`,
    // `..` and any separator still escape the single-kit namespace and are
    // still refused.
    //
    // Asserting only "it was refused" would lock nothing. Drop a verb's
    // `.refine(isSafeKitId, KIT_ID_SAFETY_MESSAGE)` and SOME later layer will
    // usually still refuse the id — so a bare `ok === false` can stay green
    // with the gate gone. Deliberately vague, because WHICH layer and WHICH
    // envelope varies per verb, and for `plan`'s dedicated test below the
    // mutated call does not get refused at all, it SUCCEEDS. That is the
    // "passes for a different reason than its name claims" failure this file
    // exists to prevent, so each verb is pinned to the LAYER meant to stop it:
    //
    //   schema — the verb's own `.refine(isSafeKitId, KIT_ID_SAFETY_MESSAGE)`
    //            is the gate under test. This row pins the PROTOCOL boundary:
    //            drop the refine and the refusal changes LAYER, which is what
    //            fails the assertion.
    //            It deliberately says NOTHING about what each verb does further
    //            downstream, because that genuinely varies: `preview` repeats
    //            `isSafeKitId` in its own `resolveKitDir`; `refine` reaches the
    //            store's GUARDED `listFiles` (`safeKitDir`); `conjure` never
    //            resolves a kit path at all; the rest reach
    //            `LocalFsKitStore.getKit`, which builds its path with the
    //            UNGUARDED `kitDir`. Two earlier revisions of this comment
    //            tried to state that uniformly and were wrong both times.
    //            An over-broad comment asserting a symmetry the code does not
    //            have is the exact mechanism that let the original gate drift
    //            survive review — `ui/grid-resource.ts` once claimed its guard
    //            was "the same guard `preview`/`read_file` apply" when the
    //            three applied two different rules. So this file states only
    //            the invariant it actually asserts.
    //   tool   — `list_files` and `read_file` apply `isSafeKitId` in their
    //            handlers, raising `ERR_INVALID_KIT_ID` and `InvalidPathError:
    //            invalid kit identifier` respectively; for both, `""` is
    //            stopped one step earlier by that schema's `.min(1)`.
    //            `read_file` belongs in this loop because this same file
    //            asserts above that it ACCEPTS `My_Kit.2`. Pinning a verb in
    //            the positive direction only is precisely the asymmetry this
    //            file exists to close.
    //   plan   — `plan` refuses in its OWN handler, BEFORE it consults the
    //            store: `plan.ts` runs `isSafeKitId` and returns
    //            `kitNotFoundResult` one statement ABOVE its `store.getKit`
    //            call. This row was labelled `store` in an earlier revision,
    //            which made its own failure message claim the refusal happened
    //            "at its store gate" — flatly contradicting the dedicated test
    //            below, which proves `getKit` is never reached. A label that
    //            misdescribes the thing it pins is the same false-yes defect
    //            this file exists to close, so the row is named for the verb
    //            whose handler owns the gate.
    //            `plan` funnels BOTH of its refusals into ONE envelope so a
    //            client branches on a single reason (#252/#263; see plan.ts).
    //            That single envelope is why `plan` ALSO needs the dedicated
    //            test below: this row cannot tell the two branches apart.
    //
    // `conjure` and `refine` are in here despite calling a live model endpoint.
    // They are safe to exercise because the MCP SDK validates `inputSchema`
    // BEFORE dispatching to the handler, so a containment-unsafe kitId is
    // refused at the protocol boundary and no generation is ever attempted —
    // the same reason their handlers' `catch` blocks never see a schema
    // failure. Omitting them would leave both gates deletable in silence,
    // since the advertised-schema lock below cannot see a `.refine()` at all.
    //
    // ⚠️ EXHAUSTIVE OVER CONTAINMENT-GATED VERBS, NOT OVER kitId-TAKING VERBS.
    // TWO kitId-taking input surfaces apply no containment rule and are
    // deliberately NOT here. Both are real asymmetries with the shared rule in
    // `store/kit-files.ts`, both are PRE-EXISTING, and neither is a gate this
    // file can pin. Reasons verified rather than assumed.
    //
    // (1) `validate` — takes a top-level `kitId`:
    //   · it was never gated. At `de353bcd` (pre-#276) its input was already
    //     `kitId: z.string().min(1)`, so the widening neither opened nor closed
    //     it. `validate.ts` contains no `isSafeKitId`, no `KIT_ID_PATTERN` and
    //     no `KIT_ID_SAFETY_MESSAGE` — it predates the split this file closes.
    //   · its counts facet never builds a kit path, so there is no containment
    //     boundary here to escape. The only two `join()`s in `validate.ts` are
    //     `join(reportsDir, "<timestamp>-<rand>.json")` and the reportsDir
    //     default `join(cwd, ".genie", "reports")`; NEITHER interpolates
    //     `kitId`. The id reaches the report's JSON body and Prometheus metric
    //     LABELS only. So the residual concern is label cardinality and
    //     contract consistency, NOT path traversal.
    //   · its full-scan facet does reach the store, whose adapters already
    //     apply `isSafeKitId` — so that half is covered where the rule lives.
    //
    // (2) `create_project` — takes `kitBindings[].kitId`, a SECOND kitId input
    //     surface that is not a top-level `kitId` parameter and so is invisible
    //     to any sweep keyed on the parameter name:
    //   · `kitBindingShape.kitId` is a bare `z.string().min(1)`
    //     (`create_project.ts`), and `createProject` persists the bindings
    //     straight into the project manifest. It never calls `assertKitExists`
    //     — the sole call site is in `bindKit`, NOT on the create path.
    //   · also never gated: at `de353bcd` `kitBindingShape` was byte-identical
    //     and the whole file contained ZERO `isSafeKitId`/`KIT_ID_PATTERN`
    //     references, so again the widening neither opened nor closed it.
    //   · not a traversal: `conjure_screen.ts` imports no `node:path` at all —
    //     every `join(` in it is `Array.prototype.join` building a string.
    //   · ⚠️ but NOT harmless either, and an earlier revision of this comment
    //     said the id "reaches only prompt text and JSON". That was WRONG.
    //     `resolveKit` returns `project.defaultKitId` / `sole.kitId` RAW from
    //     the manifest, `provenanceNote` interpolates it unescaped, and
    //     `renderScaffold` emits it into GENERATED ARTIFACT BYTES at three
    //     sinks with two different break-out mechanisms:
    //       - `conjure_screen.ts:501` (html) + `:518` (vue) — inside
    //         `<!-- ... -->`, broken out of by `-->`;
    //       - `conjure_screen.ts:531` (react) — inside a `//` line comment,
    //         broken out of by a bare NEWLINE, which `isSafeKitId` permits.
    //     Both `--><img src=x onerror=alert(1)><!--` and `"kit\nalert(1)"`
    //     satisfy `isSafeKitId` and are refused by `KIT_ID_PATTERN` — i.e.
    //     squarely in the band this PR's subject widens into.
    //     The tell that it is an oversight rather than a trust decision:
    //     that file carries TWO escape helpers and applies the
    //     framework-appropriate one to `title` on the line ADJACENT to
    //     every sink, while skipping `note` at all three —
    //       - html  `:501` note RAW │ `escapeHtml` `:506`, `:509`
    //       - vue   `:518` note RAW │ `escapeHtml` `:521`
    //       - react `:531` note RAW │ `escapeJsx`  `:535`
    //     (`escapeHtml` defined `:545`, `escapeJsx` `:555`.) So `title` is
    //     escaped at 4 of 4 interpolations and `note` at 0 of 3. The author
    //     demonstrably reasoned about per-framework escaping — JSX needs
    //     `{`/`}` handling that HTML does not — and still missed `note`,
    //     which is a sharper tell than mere proximity would be.
    //     An earlier revision of this comment cited only `:506`/`:509`/`:521`
    //     and claimed an escape adjacent to "each sink". Those are the three
    //     `escapeHtml` calls, i.e. html+vue only: keying the sweep on one
    //     helper name silently dropped the react sink — the very one whose
    //     break-out is the bare NEWLINE. Same defeat mode as this cycle's
    //     literal censuses, in the evidence for a security finding.
    //   · attribution, stated against my own interest: for `default`/`sole`
    //     this is PRE-EXISTING — those ids come from bindings that were never
    //     gated on either rule. For the `explicit` branch it is NOT: at
    //     `de353bcd` that path was `.regex(KIT_ID_PATTERN)`, which bans `<`,
    //     `>`, space and newline, so it refused these payloads BY ACCIDENT.
    //     Widening to `isSafeKitId` was right but removed that incidental
    //     cover without replacing it — the same shape as the Win32 trailing
    //     `.`/space alias, and it needs the same remedy: escape at the sink,
    //     not a narrower id rule. Source fix, tracked separately (below).
    //   · ⚠️ but note `conjure_screen`'s `kitStore` docblock asserts that
    //     "default/sole kits came from bindings already validated at bind
    //     time". That is TRUE for bindings created via `bind_kit` (which does
    //     call `assertKitExists`) and FALSE for bindings created via
    //     `create_project`, which validates nothing. `resolveKit` validates
    //     only its `explicit` branch; `default` and `sole` are returned
    //     untouched. A comment asserting a symmetry that does not exist is the
    //     precise mechanism by which the original eight-site drift survived
    //     review — worth fixing at the source, in its own change.
    // Gating EITHER is a wire-contract change (an id accepted today starts
    // being refused) and belongs in its own change with its own reasoning,
    // exactly as the deferred items in #276/#279/#281 were argued rather than
    // smuggled. Documented here so the NEXT kitId input surface is placed in
    // one bucket or the other CONSCIOUSLY — an unexplained absence from this
    // table is how the original eight-site drift survived review in the first
    // place. Note both exceptions were missed by every symbol-grep census this
    // cycle: `validate` advertises a schema byte-identical to broad-gated
    // siblings that gate in the HANDLER, and `create_project` carries its id on
    // a nested `kitBindings[]` field rather than a `kitId` parameter.
    const REFUSES_AT = {
      mcp__genie__get_kit: "schema",
      mcp__genie__preview: "schema",
      mcp__genie__bind_kit: "schema",
      mcp__genie__list_components: "schema",
      mcp__genie__conjure_screen: "schema",
      mcp__genie__conjure: "schema",
      mcp__genie__refine: "schema",
      mcp__genie__list_files: "tool",
      mcp__genie__read_file: "tool",
      mcp__genie__plan: "plan",
    } as const;

    const refusedAt = (layer: (typeof REFUSES_AT)[keyof typeof REFUSES_AT], text: string) =>
      layer === "schema"
        ? text.includes(KIT_ID_SAFETY_MESSAGE)
        : layer === "tool"
          ? // `read_file` phrases its kitId refusal as `InvalidPathError`, so
            // match its kitId-specific wording rather than the bare error name
            // — `assertSafeRelativePath` raises the same error type for a bad
            // `path`, and every call below passes a VALID one.
            text.includes("ERR_INVALID_KIT_ID") ||
            text.includes("invalid kit identifier") ||
            text.includes("too_small")
          : text.includes("kitNotFound");

    const proj = await client.callTool({
      name: "mcp__genie__create_project",
      arguments: { name: "Gate Probe", kind: "workspace" },
    });
    const projectId = payload(proj).projectId as string;

    // The trailing-space/dot entries are Win32 aliases: Windows trims a trailing
    // run of spaces and dots from a path component at the syscall boundary. Two
    // sub-cases, and missing the second cost a review round — `".. "` reaches
    // the filesystem as `".."` (escapes the root), while `"My_Kit.2."` reaches
    // it as `"My_Kit.2"` (stays inside the root but names a DIFFERENT, LIVE
    // kit). The old per-tool slug gate banned spaces and dots and so refused
    // both by accident; widening to `isSafeKitId` had to make that refusal
    // deliberate. They are in THIS loop, not only in the two `resolveKitDir`
    // tests below, because the sibling-alias case is a wrong-kit hazard rather
    // than an escape: the harm is a verb succeeding against the wrong kit, and
    // only a per-verb loop can pin that.
    //
    // The NUL entry is a third kind again — not an escape and not an alias but
    // an UNREPRESENTABLE path. See the disclosure test below for why it needs a
    // discriminating lock of its own that this loop cannot provide.
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
      "a\u0000b",
      `${IMPORTED_KIT_ID}.`,
    ]) {
      for (const [name, layer] of Object.entries(REFUSES_AT)) {
        // Every verb's OTHER required fields are valid, so the only thing that
        // can be refused is the kitId.
        const extraArgs: Record<string, Record<string, unknown>> = {
          mcp__genie__plan: { writes: ["*.html"] },
          mcp__genie__bind_kit: { projectId },
          mcp__genie__conjure_screen: { projectId, prompt: "A settings screen." },
          mcp__genie__conjure: { kit: "A small kit.", prompt: "A primary button." },
          mcp__genie__refine: { componentName: "Button", instruction: "Make it wider." },
          mcp__genie__read_file: { path: "components/actions/Button/preview.html" },
        };
        const args: Record<string, unknown> = { kitId: bad, ...(extraArgs[name] ?? {}) };

        // A schema failure can surface either as a thrown `McpError` or as an
        // `isError` result depending on the path, so both are captured.
        const result = await client
          .callTool({ name, arguments: args })
          .then((r) => ({ ok: !r.isError, text: JSON.stringify(r.content ?? r) }))
          .catch((e: unknown) => ({ ok: false, text: String((e as Error)?.message ?? e) }));

        expect(result.ok, `${name} must refuse kitId ${JSON.stringify(bad)}`).toBe(false);
        expect(
          refusedAt(layer, result.text),
          `${name} must refuse kitId ${JSON.stringify(bad)} at its ${layer} gate, ` +
            `got: ${result.text.slice(0, 240)}`,
        ).toBe(true);
      }
    }
  });

  it("🔒 refuses a NUL-bearing kitId without echoing the server's filesystem", async () => {
    // Discriminating counterpart to the loop above, and the reason the NUL rule
    // is worth a branch of its own.
    //
    // A NUL is the one character no path may contain on any supported platform.
    // Node enforces that in ARGUMENT VALIDATION, before any syscall — so it
    // reports `ERR_INVALID_ARG_VALUE` rather than `ENOENT`, and its message
    // quotes the offending path back in full. Measured on this suite with the
    // guard removed, `get_kit` returned to the client:
    //
    //   The argument 'path' must be a string, Uint8Array, or URL without null
    //   bytes. Received '/var/folders/…/kits/a\x00b/.kit.json'
    //
    // That is an absolute server path — the kits root — handed to any caller who
    // sends one byte. So this is not merely "the wrong error code": the id
    // cleared the gate, reached the store (`LocalFsKitStore.getKit` builds its
    // path with the UNGUARDED `kitDir`), and turned a rejected argument into an
    // information disclosure. `list_files` was luckier only because its
    // catch-all remapped the throw to a not-found.
    //
    // The loop above cannot catch this: it asserts WHICH LAYER refused, and a
    // leak is not a refusal at the wrong layer — it is a refusal that says too
    // much. So assert the ABSENCE of the leak rather than an exact message,
    // which also means a future rewording of the gate's own error cannot
    // silently re-open it.
    const result = await client
      .callTool({ name: "mcp__genie__get_kit", arguments: { kitId: "a\u0000b" } })
      .then((r) => JSON.stringify(r.content))
      .catch((e: unknown) => String(e));

    expect(result).not.toContain(tempDir);
    expect(result).not.toMatch(/without null bytes/iu);
    expect(result).not.toMatch(/\.kit\.json/u);
  });

  it("🔒 plan refuses a containment-unsafe kitId BEFORE it consults the store", async () => {
    // The row above cannot lock `plan`'s own gate, and the reason is worth
    // stating: `plan` returns a byte-identical `kitNotFound` envelope from BOTH
    // of its refusal branches — the `isSafeKitId` check (plan.ts) and the
    // `NotFoundError` it catches from `getKit`. Against the real store, `".."`
    // is refused by the gate; delete that gate and `getKit("..")` reads an
    // absent parent `.kit.json`, throws `NotFoundError`, and `plan` emits the
    // SAME text. The assertion stays green with the gate gone — precisely the
    // "passes for a different reason than its name claims" defect this file
    // exists to prevent, reproduced one layer down.
    //
    // The single envelope is deliberate (#252/#263) and must not change, so the
    // fix is to remove the ambiguity from the FIXTURE instead: inject a store
    // whose `getKit` RESOLVES for every id. Now only the containment gate can
    // produce a refusal, and the decisive assertion is that `getKit` is never
    // reached — which pins the ORDER plan.ts claims ("Containment first"),
    // not merely the outcome. Drop the gate and this test fails twice over:
    // the call succeeds, and `getKit` is called.
    const resolvingStore = { getKit: vi.fn(async () => ({ id: "anything", type: "kit" })) };

    const server = new McpServer({ name: "genie-gate-test", version: "0" });
    registerPlan(server, resolvingStore);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const stubClient = new Client({ name: "gate-stub", version: "1.0.0" }, { capabilities: {} });
    await stubClient.connect(clientTransport);

    try {
      for (const bad of ["", "..", ".", "../escape", "a/b", "a\\b", "a\u0000b"]) {
        resolvingStore.getKit.mockClear();

        const result = await stubClient
          .callTool({
            name: "mcp__genie__plan",
            arguments: { kitId: bad, writes: ["*.html"], localDir: tempDir },
          })
          .then((r) => ({ ok: !r.isError, text: JSON.stringify(r.content ?? r) }))
          .catch((e: unknown) => ({ ok: false, text: String((e as Error)?.message ?? e) }));

        expect(result.ok, `plan must refuse kitId ${JSON.stringify(bad)}`).toBe(false);
        expect(result.text).toContain("kitNotFound");
        expect(
          resolvingStore.getKit,
          `plan must reject kitId ${JSON.stringify(bad)} at its own containment ` +
            `gate, without consulting the store`,
        ).not.toHaveBeenCalled();
      }
    } finally {
      await stubClient.close();
      await server.close();
    }
  });

  it("🔒 refuses a NUL-bearing kitId without echoing the server's filesystem", async () => {
    // Discriminating counterpart to the non-discriminating loop above, and the
    // reason the NUL rule is worth a branch of its own.
    //
    // A NUL is the one character no path may contain on any supported platform.
    // Node enforces that in ARGUMENT VALIDATION, before any syscall — so it
    // reports `ERR_INVALID_ARG_VALUE` rather than `ENOENT`, and its message
    // quotes the offending path back in full. Measured on this suite with the
    // guard removed, `get_kit` returned to the client:
    //
    //   The argument 'path' must be a string, Uint8Array, or URL without null
    //   bytes. Received '/var/folders/…/kits/a\x00b/.kit.json'
    //
    // That is an absolute server path — the kits root — handed to any caller who
    // sends one byte. So this is not merely "the wrong error code": the id
    // cleared the gate, reached the store, and turned a rejected argument into
    // an information disclosure. `list_files` was luckier only because its
    // catch-all remapped the throw to a not-found.
    //
    // Assert the ABSENCE of the leak rather than an exact message, so a future
    // rewording of the gate's own error cannot silently re-open it.
    const result = await client
      .callTool({ name: "mcp__genie__get_kit", arguments: { kitId: "a\u0000b" } })
      .then((r) => JSON.stringify(r.content))
      .catch((e: unknown) => String(e));

    expect(result).not.toContain(tempDir);
    expect(result).not.toMatch(/without null bytes/iu);
    expect(result).not.toMatch(/\.kit\.json/u);
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
    //
    // ⚠️ This lock is DIRECTIONAL, and deliberately so. `.refine()` emits no
    // JSON Schema keyword, so a verb that gates correctly advertises no
    // `pattern` at all — indistinguishable here from one that dropped its gate
    // entirely. This test catches a verb RE-TIGHTENING onto the slug regex;
    // only its behavioural counterpart above ("🔒 every containment-gated
    // kit-taking verb refuses an unsafe kitId at its own gate") catches one
    // dropping it. Neither is sufficient alone; both are required.
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
      // A NUL byte is not a traversal — it is UNREPRESENTABLE. See
      // `🔒 refuses a NUL-bearing kitId without echoing the server's filesystem`
      // for the disclosure this prevents.
      "a\u0000b",
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
      // A NUL byte is not a traversal — it is UNREPRESENTABLE. See
      // `🔒 refuses a NUL-bearing kitId without echoing the server's filesystem`
      // for the disclosure this prevents.
      "a\u0000b",
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
