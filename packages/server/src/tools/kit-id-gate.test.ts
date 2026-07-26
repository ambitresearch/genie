/**
 * Cross-cutting regression lock for the kitId gate asymmetry.
 *
 * genie has two kitId rules and they disagreed about which kits are usable:
 *
 *   - `isSafeKitId` (store/kit-files.ts) — the CONTAINMENT rule. Rejects `""`,
 *     `.`, `..`, and anything carrying a `/` or `\`. Everything else names a
 *     literal child of the kits root, so it cannot escape. This is the rule both
 *     store adapters (`store/local.ts`, `store/git-host.ts`) enforce.
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
import { isSafeKitId, KIT_ID_SAFETY_MESSAGE } from "../store/kit-files.js";
import { MANIFEST_PATH } from "../store/manifest.js";
import { resolveKitDir as resolveGridKitDir } from "../ui/grid-resource.js";
import { seedKit } from "../../test/helpers/seed-kit.js";
import { registerPlan } from "./plan.js";
import type { BootRequest, BootedViewer, ViewerBooter } from "./preview.js";
import { InvalidKitIdError, resolveKitDir as resolvePreviewKitDir } from "./preview.js";

/**
 * Ids a `create_kit`-minted slug would never produce but an imported or
 * git-host kit legitimately can. Every one of these is containment-safe: it
 * resolves to a literal child of the kits root, never above it.
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

    for (const bad of ["", "..", ".", "../escape", "a/b", "a\\b"]) {
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
      for (const bad of ["", "..", ".", "../escape", "a/b", "a\\b"]) {
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
    for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
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
    for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
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
