/**
 * Cross-cutting regression lock for the kitId gate asymmetry.
 *
 * genie has two kitId rules and they disagreed about which kits are usable:
 *
 *   - `isSafeKitId` (store/kit-files.ts) — the SAFETY rule, and the authority for
 *     its own rejection set: read the predicate, do not re-derive it here. It is
 *     the rule both store adapters (`store/local.ts`, `store/git-host.ts`) apply
 *     on their path-taking operations — but not in `getKit`, where each reaches
 *     the backing store unguarded, so the tool schema is the only check there.
 *     It guarantees an accepted id NEVER RESOLVES TO A DIFFERENT KIT than it
 *     spells — strictly stronger than "stays under the kits root", and the
 *     distinction is load-bearing: `victim.` never leaves the root, yet Windows
 *     trims the trailing dot at the syscall boundary and opens the sibling kit
 *     `victim`. Framing this as pure containment ("everything else is a literal
 *     child, so it cannot escape") is what let three separate alias classes
 *     through review. It does NOT promise an accepted id opens a kit directory
 *     at all: case folding and NTFS 8.3 short names are alternate spellings of
 *     ONE kit, and Win32 device names spell no kit, so both stay deliberately
 *     out of scope; the predicate names them.
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
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { commentTexts, stripComments } from "../../test/helpers/source-text.js";
import { trackedFiles, trackedPath } from "../../test/helpers/tracked-files.js";
import { ProjectNotFoundError, getKit } from "./get_kit.js";
import { listWritableKits } from "./list_kits.js";
import { registerPlan } from "./plan.js";
import type { BootRequest, BootedViewer, ViewerBooter } from "./preview.js";
import { InvalidKitIdError, resolveKitDir as resolvePreviewKitDir } from "./preview.js";

/**
 * Ids a `create_kit`-minted slug would never produce but an imported or
 * git-host kit legitimately can. Every one of these is safe on BOTH counts
 * `isSafeKitId` guarantees: each resolves to a literal child of the kits root
 * (never above it) AND survives a Win32 trailing-[ .] trim unchanged, so on
 * every platform each names the same kit it spells.
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
    // BEFORE dispatching to the handler, so an id rejected by the shared gate is
    // refused at the protocol boundary and no generation is ever attempted —
    // the same reason their handlers' `catch` blocks never see a schema
    // failure. Omitting them would leave both gates deletable in silence,
    // since the advertised-schema lock below cannot see a `.refine()` at all.
    //
    // Exhaustive over shared-gated input surfaces. `validate` remains the
    // only kitId-taking tool without this gate; it does not use the id as a path.
    // `create_project` is special-cased below because its input is nested under
    // `kitBindings[]` rather than exposed as a top-level `kitId`.
    const REFUSES_AT = {
      mcp__genie__create_project: "schema",
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

    // `read_file` phrases its kitId refusal as `InvalidPathError`, so the "tool"
    // layer below matches its kitId-specific wording rather than the bare error
    // name — `assertSafeRelativePath` raises the same error type for a bad
    // `path`, and every call below passes a VALID one.
    const refusedAt = (layer: (typeof REFUSES_AT)[keyof typeof REFUSES_AT], text: string) =>
      layer === "schema"
        ? text.includes(KIT_ID_SAFETY_MESSAGE)
        : layer === "tool"
          ? text.includes("ERR_INVALID_KIT_ID") ||
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
    //
    // The lone-surrogate entry is a FOURTH kind: ill-formed UTF-16. It is an
    // alias like `victim.`, but on POSIX rather than Win32 — Node encodes an
    // unpaired surrogate as U+FFFD's bytes, so it opens the sibling kit named
    // `"\uFFFD"`. See the destructive suite below for the proof.
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
      "\uD800",
      `a\uDFFFb`,
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
        const args: Record<string, unknown> =
          name === "mcp__genie__create_project"
            ? {
                name: "Unsafe Binding",
                kind: "workspace",
                kitBindings: [{ kitId: bad }],
              }
            : { kitId: bad, ...(extraArgs[name] ?? {}) };

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
// ─── Unit: what list_kits is entitled to promise ─────────────────────────────

/**
 * How a tool source says "this verb TAKES a kitId".
 *
 * Matches a `kitId` property whose VALUE is a schema, which is the fact being
 * looked for, rather than one way of writing it. The first cut required the
 * literal `kitId: z.` and so missed every established alternative already in
 * the tree — `kitId: kitIdSchema` (`bind_kit`), `kitId: kitIdSchema.optional()`
 * (`conjure_screen`) and a `z` / `.string()` split across lines
 * (`list_components`).
 *
 * Keying on schema-ness is also what keeps `create_kit` out. It MINTS an id, so
 * its only `kitId:` occurrences are the outgoing `{ kitId: kit.id }` payload and
 * an error field; a bare `kitId:` scan reports it as an ungated kit verb, which
 * is false — it never accepts one.
 *
 * This is the source-text derivation. The registry-derived inventory below is
 * the authority, and the two are asserted equal, so neither a new declaration
 * style nor an unregistered verb can slip past unnoticed.
 */
const KIT_ID_INPUT_DECL = /\bkitId\s*:\s*(?:z\s*\.|[A-Za-z_$][\w$]*[Ss]chema\b)/u;

/**
 * Every tool source file this repository publishes, by basename.
 *
 * Both audits below ask which tool files exist, and the answer has to be the
 * REPOSITORY's rather than this checkout's. The two differ by exactly the
 * untracked files a working tree accumulates, and one scratch file declaring a
 * `kitId` schema enrols itself as an unregistered, ungated kit verb — failing
 * the audits on the machine that has it while a clean CI checkout passes.
 */
function publishedToolSources(): string[] {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const serverRoot = dirname(dirname(toolsDir));
  const prefix = `${trackedPath(serverRoot, toolsDir)}/`;
  return (
    trackedFiles(serverRoot)
      .filter((relative) => relative.startsWith(prefix))
      .map((relative) => relative.slice(prefix.length))
      // `!includes("/")` reproduces the non-recursive reach of the disk walk this
      // replaced. `src/tools` has no subdirectories today, so it guards rather
      // than changes anything.
      .filter((file) => !file.includes("/") && file.endsWith(".ts") && !file.endsWith(".test.ts"))
  );
}

describe("kitId gate — what list_kits may promise about other verbs", () => {
  it("🔒 does not promise a refusal from verbs that never apply the gate", async () => {
    // `list_kits` omits ids the shared gate refuses, and justified that by
    // claiming every kit verb would refuse them anyway. That is a statement
    // about OTHER tools, so it can only be as true as they are — and it is
    // false for any verb reaching the store through its own looser schema.
    // Derive the two sets rather than reasoning about them in prose, because
    // reasoning about a rule at a distance is the defect this PR exists to fix.
    const toolsDir = dirname(fileURLToPath(import.meta.url));
    const files = publishedToolSources();

    const kitVerbs: string[] = [];
    const ungated: string[] = [];
    for (const file of files) {
      const source = await readFile(join(toolsDir, file), "utf8");
      // Comments are stripped for BOTH questions asked of a file — does it take
      // a kitId, and does it gate one — so a declaration quoted in prose cannot
      // enrol a file that has none, just as a sentence naming the gate cannot
      // excuse a file that never calls it.
      const code = stripComments(source);
      if (!KIT_ID_INPUT_DECL.test(code)) continue;
      kitVerbs.push(file);
      // Read the file for the gate itself. Delegation is not credited: every
      // gated input surface names `isSafeKitId` or `assertKitLive` directly.
      //
      // Comments are stripped first, and that is not cosmetic. The most natural
      // sentence anyone would ever write in an UNGATED verb is why it is
      // ungated — "validate deliberately applies no isSafeKitId gate" — which
      // on a raw-text scan marks it gated and silently empties this list.
      // Documenting the exception would disable its detection. Stripping errs
      // toward reporting a gated file as ungated, which fails loudly here
      // rather than passing quietly.
      const gated = /\b(?:isSafeKitId|assertKitLive)\b/u.test(code);
      if (!gated) ungated.push(file);
    }

    // Anti-vacuity: the gate spans most of the kit-taking surface, so an empty
    // or near-empty derivation means the scan broke, not that the claim holds.
    expect(kitVerbs.length).toBeGreaterThan(4);

    // Only the refusal direction is policed here. "every kit verb would refuse
    // X" needs every verb to gate, which is what `ungated` measures. The
    // description's other universal — "no kit verb will refuse" a SAFE id —
    // rests on a different premise (no verb is NARROWER than the shared rule)
    // and is locked by its own two tests above: the advertised-schema check and
    // the behavioural refusal check.
    //
    // Scope is every tool SOURCE, not just the exported description string. The
    // first cut read only `LIST_KITS_DESCRIPTION`, so when the claim was
    // corrected there it survived eleven lines below in the docblock of the
    // function that string documents — a lock cannot police a restatement it
    // never reads. The pattern likewise matches the claim's SHAPE rather than
    // one spelling of it: a universality word beside a refusal word, in either
    // order, since "no kit-taking verb would accept" and "universally refused"
    // assert exactly the same thing.
    //
    // A claim explicitly QUALIFIED by the gate is honest and must not fire —
    // `LIST_KITS_DESCRIPTION` says "no kit verb THAT APPLIES THAT GATE will
    // refuse", which is exactly the narrowing this lock exists to force. So the
    // span between the two words may not contain a qualifier; without that
    // guard the lock reports the corrected wording as the defect and the only
    // way to satisfy it is to delete a true sentence. For the same reason a
    // universality word carrying "not" is a DENIAL of the claim — "not every
    // kit verb does" is the disclaimer, and it necessarily sits beside a
    // refusal word, so without the guard every correction reads as a relapse.
    const QUALIFIER = String.raw`(?:that appl\w+|which appl\w+|applying|gated|used to)`;
    const GAP = String.raw`(?:(?!${QUALIFIER})[^.]){0,60}?`;
    // "tool" as well as "verb". The two words name the same thing throughout
    // this codebase, and the claim this lock exists to police was restated in
    // `store/local.ts` and `test/store-conformance.test.ts` as "every kit-taking
    // TOOL", one synonym away from a pattern that only knew "verb". A lock keyed
    // to one word for a thing with two names is not a lock.
    const SCOPE = String.raw`(?<!\bnot\s)(?:every|any|no)\s+kit(?:[- ]taking)?\s+(?:verb|tool)\b`;
    const UNIVERSAL_REFUSAL = new RegExp(
      [
        String.raw`univers\w*\s+\w*\s*refus\w*`,
        String.raw`refus\w*\s+univers\w*`,
        String.raw`\b${SCOPE}${GAP}\b(?:refus\w*|accept\w*)`,
        String.raw`\b(?:refus\w*|accept\w*)${GAP}\b${SCOPE}`,
        // Universality asserted of the GATING itself ("every kit-taking tool
        // gates on X"), not of a refusal. Same false claim, different verb, and
        // the refusal arms above cannot see it. The gating word must follow the
        // scope IMMEDIATELY: `gate` is also the ordinary NOUN for the rule and
        // appears in almost every honest sentence about it, so allowing a gap
        // makes `LIST_KITS_DESCRIPTION`'s correctly qualified "...safety gate,
        // so no kit verb THAT APPLIES THAT GATE will refuse" match on its own
        // preceding noun.
        String.raw`\b${SCOPE}\s+(?:gates?|appl(?:y|ies))\b`,
        // The same universality asserted of the ENFORCEMENT, but with the verb
        // BEFORE the scope: "shared by every kit-taking tool". The refusal arms
        // above already read both orders; the gating arm read only one, and the
        // canonical docblock in `store/kit-files.ts` stated the claim in the
        // order the lock could not see. A rule whose vocabulary is symmetric but
        // whose word ORDER is not is a lock with a documented seam in it.
        //
        // The qualifier guard has to trail the scope here rather than sit in the
        // gap. In the scope-first arms the narrowing ("every kit verb THAT
        // APPLIES IT") falls inside `GAP` and suppresses the match there; in this
        // order it lands after the scope instead, where `GAP` cannot reach it, so
        // the honest wording would otherwise be reported as the defect.
        String.raw`\b(?:shar\w*|appl\w*|enforc\w*|honou?r\w*|observ\w*)\s+(?:by|across|throughout)\s+${GAP}\b${SCOPE}(?!\s+${QUALIFIER})`,
      ].join("|"),
      "giu",
    );

    // Scope is every tracked file in the package, not the tool sources alone.
    // The claim is a statement ABOUT the tools, so it is at its most misleading
    // exactly where it is furthest from them — the two restatements this widening
    // caught sit in `store/local.ts` and `test/store-conformance.test.ts`, and a
    // scan of `src/tools/*.ts` could never have seen either. Tracked files, not a
    // disk walk, for the reason `test/helpers/tracked-files.ts` documents.
    const serverRoot = dirname(dirname(toolsDir));
    const SELF = trackedPath(serverRoot, fileURLToPath(import.meta.url));
    const universal: string[] = [];
    for (const relative of trackedFiles(serverRoot)) {
      // This file is the lock, and it QUOTES the claim shapes it forbids in
      // order to explain them. Excluding it would normally be a blind spot, so
      // the exclusion is paid for below: the same quotations are asserted to
      // MATCH, which is a stronger check than the negative scan it opts out of —
      // weakening the pattern fails there instead of passing silently here.
      if (!relative.endsWith(".ts") || relative === SELF) continue;
      const source = await readFile(join(serverRoot, relative), "utf8");
      for (const match of source.matchAll(UNIVERSAL_REFUSAL)) {
        universal.push(`${relative}: ${match[0].replace(/\s+/gu, " ")}`);
      }
    }
    // Pay for excluding this file above. Each string below is a claim shape the
    // scan must catch, and the last is the qualified wording it must NOT — the
    // narrowing the whole lock exists to force. Asserting on them here keeps the
    // pattern honest without letting this file's explanatory quotations read as
    // live claims, and means a future edit that loosens the regex fails loudly
    // rather than emptying `universal` in silence.
    for (const shape of [
      "an id every kit-taking verb refuses",
      "the containment rule every kit-taking tool gates on",
      "every kit-taking tool would refuse",
      // Enforcement asserted BEFORE the scope. The refusal arms already read
      // both orders, but the gating arm read only scope-then-verb, so the same
      // false claim written the other way round ("shared by every kit-taking
      // tool") walked past a lock built to catch exactly it.
      "the ONE kitId-safety rule shared by every kit-taking tool",
      "the rule applied by every kit-taking verb",
    ]) {
      expect(
        new RegExp(UNIVERSAL_REFUSAL.source, "iu").test(shape),
        `the universality pattern no longer recognises "${shape}"`,
      ).toBe(true);
    }
    expect(
      new RegExp(UNIVERSAL_REFUSAL.source, "iu").test(
        "no kit verb that applies that gate will refuse it",
      ),
      "the universality pattern now fires on the QUALIFIED wording, so the only way " +
        "to satisfy this lock would be to delete a true sentence",
    ).toBe(false);

    if (universal.length > 0) {
      expect(
        ungated,
        `these sources claim a refusal or a gate every kit verb makes — "${universal.join('", "')}" ` +
          `— but these verbs declare a kitId input and never apply the shared gate, so an id ` +
          `withheld as unusable is one they would in fact accept`,
      ).toEqual([]);
    }

    // Pin the derivation itself, not just its use above. Prose in `list_kits`
    // and `store/interface` names the exceptions to uniform gating by hand, and
    // a hand-written exception list is only correct until the next verb lands —
    // so the list has to be checkable against the code it describes.
    //
    // `validate.ts` is deliberate: it never joins the id into a path. Several
    // gated tools enforce the rule in their handler, so this inventory reads
    // the full source rather than requiring a refined schema.
    expect(
      ungated.sort(),
      "the kitId verbs that apply no shared gate — update the prose in " +
        "`list_kits.ts` and `store/interface.ts` that enumerates them whenever " +
        "this changes, since that prose cannot be derived from the code it describes",
    ).toEqual(["validate.ts"]);
  });

  /**
   * The inventory both audits rest on is the repository's, not this checkout's.
   *
   * Asked of the disk, the question "which tool files exist?" answers with
   * whatever is lying in the working tree — including a scratch file an agent
   * left behind. One such file declaring a `kitId` schema enrols itself as an
   * unregistered, ungated kit verb: the audit above fails on that machine, and
   * a clean CI checkout passes, so the disagreement is unreproducible where it
   * is reported. `test/helpers/tracked-files.ts` documents why a contract test
   * asks git; this is that reasoning applied to the one directory these audits
   * read.
   */
  it("🔒 derives the audited inventory from the repository, not from this checkout", async () => {
    const toolsDir = dirname(fileURLToPath(import.meta.url));
    const scratch = join(toolsDir, "zz_untracked_scratch.ts");
    await writeFile(scratch, "export const schema = { kitId: z.string() };\n", "utf8");
    try {
      const files = publishedToolSources();
      // Anti-vacuity: an inventory that had simply broken would satisfy the
      // exclusion below while proving nothing about it.
      expect(files, "the tool inventory has gone empty").toContain("get_kit.ts");
      expect(files).not.toContain("zz_untracked_scratch.ts");
    } finally {
      await rm(scratch, { force: true });
    }
  });

  it("🔒 discovers kit-taking verbs from the registry, not from one schema spelling", async () => {
    // The audit above is only as good as the set it audits. Its discovery used
    // to be a source-text match for `kitId: z.` — one SPELLING of the
    // declaration, not the fact of it. Three verbs already registered a kitId
    // input in a different but equally established style and were invisible to
    // it: `bind_kit` and `conjure_screen` reference a shared `kitIdSchema`, and
    // `list_components` breaks `z` and `.string()` across lines. A newly added
    // verb copying any of those styles would land in neither `kitVerbs` nor
    // `ungated`, so the audit's final assertion would still pass while no
    // longer covering it — a lock that silently stops locking.
    //
    // So the inventory is derived from what the server actually REGISTERS. A
    // tool advertising a kitId anywhere in its input schema takes a kitId, no
    // matter how the source spells it, which makes this discovery independent
    // of layout by construction rather than by keeping a regex up to date.
    // `create_project` is included on purpose: it declares `kitBindings[].kitId`
    // nested rather than at the top level, and nesting is not exemption.
    const tempDir = await mkdtemp(join(tmpdir(), "genie-kitid-registry-"));
    process.env.GENIE_HOME = tempDir;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      kitsRoot: join(tempDir, "kits"),
      projectsRoot: join(tempDir, "projects"),
      previewBooter: stubBooter(),
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    let registryFiles: string[];
    try {
      const { tools } = await client.listTools();
      registryFiles = tools
        .filter((tool) => JSON.stringify(tool.inputSchema ?? {}).includes('"kitId"'))
        .map((tool) => `${tool.name.replace(/^mcp__genie__/u, "")}.ts`)
        .sort();
    } finally {
      await client.close();
      await rm(tempDir, { recursive: true, force: true });
      delete process.env.GENIE_HOME;
    }

    const toolsDir = dirname(fileURLToPath(import.meta.url));
    const files = publishedToolSources();

    // Anti-vacuity, both halves. An empty or tiny inventory would satisfy every
    // comparison below while checking nothing, and the tool-name-to-filename
    // convention is the only thing making a registered tool answerable to a
    // source file — if a rename breaks it the verb drops out of the audit
    // silently, which is the exact failure mode this test exists to prevent.
    expect(registryFiles.length).toBeGreaterThan(4);
    expect(
      registryFiles.filter((file) => !files.includes(file)),
      "a registered kit-taking tool has no source file of the same name, so the " +
        "gate audit cannot see it — keep tool names and filenames in step",
    ).toEqual([]);

    // Comments are stripped here for PARITY with the audit's own discovery, not
    // because anything in the tree currently hides a declaration in prose —
    // reverting this line alone changes no result today. That is the point: the
    // two derivations compared below have to normalise their input identically,
    // or the first comment to quote a `kitId:` schema would make them disagree
    // for a reason that has nothing to do with what this test is checking.
    const declared: string[] = [];
    for (const file of files) {
      const source = await readFile(join(toolsDir, file), "utf8");
      const code = stripComments(source);
      if (KIT_ID_INPUT_DECL.test(code)) declared.push(file);
    }

    expect(
      declared.sort(),
      "the source-text view of which verbs take a kitId disagrees with the " +
        "registered tool inventory — either `KIT_ID_INPUT_DECL` no longer " +
        "recognises a declaration style in use, or a verb declares a kitId and " +
        "is never registered",
    ).toEqual(registryFiles);
  });
});

// ─── Unit: what the tool layer may promise about the store layer ─────────────
// ─── Unit: what the tool layer may promise about the store layer ─────────────

describe("kitId gate — what a tool may promise about the store adapters", () => {
  it("🔒 does not credit the adapters with a gate their getKit never applies", async () => {
    // `get_kit`'s docblock told readers to gate input on `isSafeKitId` because it
    // is "the rule both store adapters enforce". Both adapters DO enforce it — on
    // the operations that route through `safeKitDir` (local) or the per-method
    // guards (git-host). `getKit` is not one of them. It reaches the backing
    // store directly: `LocalFsKitStore.getKit` joins through `kitMetaPath` →
    // `kitDir`, and `GitHostKitStore.getKit` builds a repo path with
    // `encodeURIComponent` and no predicate at all.
    //
    // The sentence is not merely imprecise, it inverts the risk. The tool schema
    // is the ONLY check standing in front of those two lookups, and the docblock
    // explaining that schema described the layer behind it as enforcing the same
    // rule — which reads as defence-in-depth where there is none, and invites
    // exactly the "the store will catch it anyway" reasoning that makes deleting
    // the schema refinement look safe.
    //
    // Derive it rather than restate it: read each adapter's `getKit` for the gate.
    const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const serverRoot = dirname(srcDir);

    /** The `{...}` block introduced by `header`, by brace matching. */
    const blockBody = (source: string, header: string): string => {
      const start = source.indexOf(header);
      expect(
        start,
        `"${header}" not found — this derivation is reading a stale shape`,
      ).toBeGreaterThan(-1);
      const open = source.indexOf("{", start);
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(open, i + 1);
        }
      }
      throw new Error(`unbalanced braces reading "${header}"`);
    };

    const adapters = ["local.ts", "git-host.ts"];
    const gatingGetKit: string[] = [];
    for (const adapter of adapters) {
      const source = await readFile(join(srcDir, "store", adapter), "utf8");
      const body = stripComments(blockBody(source, "async getKit("));
      if (/\b(?:isSafeKitId|safeKitDir)\b/u.test(body)) gatingGetKit.push(adapter);
    }

    // Anti-vacuity: both adapters DO apply the gate elsewhere, so a derivation
    // that cannot find it anywhere in these files is broken, not informative.
    // Strip comments first, for the same reason the getKit body above does —
    // both files discuss `isSafeKitId` at length, so an unstripped check passes
    // on the prose alone and would stay green if the adapter stopped calling it.
    for (const adapter of adapters) {
      const source = await readFile(join(srcDir, "store", adapter), "utf8");
      expect(
        /\bisSafeKitId\b/u.test(stripComments(source)),
        `${adapter} no longer CALLS the gate anywhere — this derivation is stale`,
      ).toBe(true);
    }

    // A credit is honest when it says WHICH operations it covers — "both adapters
    // apply the predicate BEFORE creating anything" is true and bounded, while
    // "the rule both store adapters enforce" is not. So the test is: does the
    // sentence restrict itself?
    //
    // A first attempt derived the operation names from the `KitStore` interface
    // and looked for one in the span. That reads as the more principled choice
    // and is not: the stems collide with ordinary English, so `get_kit`'s own
    // false sentence went undetected on the word "open" in "the kit they open".
    // Deriving from the repo is right when the thing being derived IS a repo
    // fact; here it is a property of the English. This list is closed for the
    // same reason the universality lock's QUALIFIER is — restricting words are a
    // feature of the language, so unlike a list of files or methods it does not
    // drift as the codebase changes, and the fixtures below fail loudly if it
    // ever stops discriminating.
    const RESTRICTED =
      /\b(?:before|after|when|unless|except|only|other than|apart from|path-taking|not in)\b/iu;
    const GATING_VERB = /\b(?:enforce\w*|appl(?:y|ies|ied)|gates?)\b/iu;
    const CREDIT_SPAN = /both (?:store )?adapters[^.]{0,160}/giu;

    /** Every span in `text` that credits the adapters without restricting itself. */
    const unqualifiedCredits = (text: string): string[] =>
      [...text.matchAll(new RegExp(CREDIT_SPAN.source, "giu"))]
        .map((match) => match[0].replace(/\s+/gu, " "))
        .filter((span) => GATING_VERB.test(span) && !RESTRICTED.test(span));

    const SELF = trackedPath(serverRoot, fileURLToPath(import.meta.url));
    const credits: string[] = [];
    for (const relative of trackedFiles(serverRoot)) {
      // Same bargain as the universality lock above: this file quotes the claim
      // in order to forbid it — including inside the failure message below — so
      // it is excluded from the negative scan and paid for by the positive
      // fixtures that follow.
      if (!relative.endsWith(".ts") || relative === SELF) continue;
      const source = await readFile(join(serverRoot, relative), "utf8");
      credits.push(...unqualifiedCredits(source).map((span) => `${relative}: ${span}`));
    }

    // Pay for that exclusion: the forbidden shape must still be recognised, and
    // the scoped wording must still be permitted.
    expect(
      unqualifiedCredits("isSafeKitId, the rule both store adapters enforce"),
      "the adapter-credit judgement no longer recognises the unqualified claim",
    ).toHaveLength(1);
    expect(
      unqualifiedCredits("Both adapters apply the predicate before creating anything"),
      "the adapter-credit judgement now fires on a credit that restricts itself, so " +
        "satisfying this lock would mean deleting a true sentence",
    ).toHaveLength(0);

    expect(
      credits,
      `these sources credit both store adapters with enforcing the kitId gate without ` +
        `saying which operations it covers — but neither adapter applies it in getKit, so the ` +
        `tool schema is the only check in front of that lookup`,
    ).toEqual([]);

    // Pin the fact this lock encodes. If an adapter ever does gate `getKit`, this
    // fails and the qualified wording may legitimately be widened again.
    expect(
      gatingGetKit,
      "no adapter gates getKit today; if one now does, revisit the qualified wording in " +
        "get_kit.ts, store/local.ts, preview.test.ts and this file's header",
    ).toEqual([]);
  });
});

/**
 * Ill-formed UTF-16 is a third alias spelling, and the only one that is
 * destructive on POSIX.
 *
 * `isSafeKitId` is a rule about which BYTES reach the filesystem, but a
 * JavaScript string is UTF-16 and may be ILL-FORMED — an unpaired surrogate is
 * a perfectly ordinary `string` that no Unicode scalar corresponds to. Node has
 * to put something on the wire, and its POSIX path conversion substitutes
 * U+FFFD REPLACEMENT CHARACTER. So `"\uD800"` and `"\uFFFD"` are DIFFERENT
 * JavaScript strings that name the SAME directory.
 *
 * That is the `victim.` hazard again — an accepted id resolving to a kit it does
 * not spell — but it needs no Windows: it reproduces on APFS and ext4. And a
 * lone surrogate is input-reachable, because MCP's JSON transport carries
 * `"\ud800"` verbatim; `JSON.parse` does not reject it.
 *
 * The harm is a WRITE, not an escape. `"\uD800"` never leaves the kits root, so
 * every containment framing accepts it; what it does is open a live sibling kit
 * under another name, which is exactly the distinction the file header calls
 * load-bearing.
 */
describe("kitId gate — an ill-formed kitId cannot open a well-formed kit", () => {
  let kitsRoot: string;

  /** Well-formed, gate-safe, and the kit that gets hit. */
  const VICTIM_ID = "\uFFFD";
  /** Ill-formed: a lone high surrogate. Encodes to U+FFFD's bytes. */
  const ALIAS_ID = "\uD800";

  beforeEach(async () => {
    kitsRoot = await mkdtemp(join(tmpdir(), "genie-kitid-surrogate-"));
    await seedKit(kitsRoot, VICTIM_ID, "Victim");
  });

  afterEach(async () => {
    await rm(kitsRoot, { recursive: true, force: true });
  });

  it("🔒 a lone surrogate is refused even though it never leaves the kits root", async () => {
    // The two strings are genuinely different, so this is not a tautology.
    expect(ALIAS_ID).not.toBe(VICTIM_ID);
    // The victim is an ordinary, usable kit — the alias must not borrow its
    // safety.
    expect(isSafeKitId(VICTIM_ID)).toBe(true);

    expect(isSafeKitId(ALIAS_ID)).toBe(false);
  });

  it("🔒 the gate is what stops the alias, not containment", async () => {
    // Containment alone accepts it: it resolves to a literal child of the root.
    const resolved = join(kitsRoot, ALIAS_ID);
    expect(resolved.startsWith(`${kitsRoot}/`) || resolved.startsWith(`${kitsRoot}\\`)).toBe(true);

    // …and that child is the VICTIM's directory, which is the whole defect.
    // Asserted by reading through the alias: if the two encoded differently this
    // would be ENOENT.
    const meta = await readFile(join(kitsRoot, ALIAS_ID, ".kit.json"), "utf-8");
    expect(JSON.parse(meta).id).toBe(VICTIM_ID);
  });

  it("🔒 refuses before the store, so no write lands in the wrong kit", async () => {
    const store = new LocalFsKitStore(kitsRoot);

    // `getKit` is the shape the whole tool surface funnels through, and neither
    // adapter gates it — so a schema that accepted the alias would resolve the
    // victim under the attacker's spelling.
    await expect(getKit(store, { kitId: ALIAS_ID })).rejects.toBeDefined();

    // Anti-vacuity: the victim itself still resolves, so the refusal above is
    // about the SPELLING and not about the kit being unreadable.
    await expect(getKit(store, { kitId: VICTIM_ID })).resolves.toMatchObject({ id: VICTIM_ID });

    // Nothing was planted. The alias write path is the destructive half: with
    // the gate open, `writeFiles`/`deleteFile` resolve through the unsafe
    // `kitDir`, so this file would appear INSIDE the victim.
    expect(await readdir(join(kitsRoot, VICTIM_ID))).toEqual([".kit.json"]);
  });

  it("🔒 list_kits cannot advertise an ill-formed id", async () => {
    // The Part H invariant, for this alias class: whatever survives the listing
    // filter must clear the gate. A seeded victim keeps this from passing on an
    // empty list.
    const listed = await listWritableKits(new LocalFsKitStore(kitsRoot));

    expect(listed.length).toBeGreaterThan(0);
    for (const kit of listed) {
      expect(isSafeKitId(kit.id), `advertised but gate-refused: ${JSON.stringify(kit.id)}`).toBe(
        true,
      );
    }
  });
});

/**
 * Widening the gate deleted an incidental guarantee.
 *
 * `KIT_ID_PATTERN`'s `{3,64}` was the only LENGTH bound anywhere in the system.
 * `isSafeKitId` deliberately has none — length is not a containment property —
 * so relaxing the gate made an arbitrarily long id reachable at the store, where
 * `open()` answers `ENAMETOOLONG` and Node's `uvException` puts the ABSOLUTE
 * path of the kits root into `.message` and `.path`. `local.ts` re-throws
 * anything that is not `ENOENT`/`ENOTDIR`, and `get_kit` re-throws anything that
 * is not `NotFoundError`, so it reaches the MCP client verbatim.
 *
 * That is server-filesystem layout disclosed from PURE INPUT — no permissions,
 * no seeded kit, no race — on every POSIX platform.
 *
 * Two different faults, two different answers, and the distinction is the whole
 * point of #252's narrowing:
 *
 *   - a name the filesystem CANNOT represent (`ENAMETOOLONG`, and `EINVAL` for
 *     Win32's reserved characters) names no kit and never can, so it is ABSENT
 *     — indistinguishable, semantically, from a kit that was never created;
 *   - a name it CAN represent but failed to read (`EACCES`, `EIO`, `ELOOP`)
 *     is a real operational fault and must stay distinguishable from absence,
 *     or `plan` reports `kitNotFound` for a kit that exists (#252). It keeps its
 *     `code` — `plan.test.ts` matches on it — and loses only the path.
 */
describe("kitId gate — a rejected id does not disclose the server's filesystem", () => {
  it("🔒 answers a filesystem-unrepresentable kitId as absent, not with its path", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-kit-id-longname-"));
    try {
      const store = new LocalFsKitStore(kitsRoot);
      // Longer than NAME_MAX (255) on every mainstream filesystem, and safe by
      // `isSafeKitId`: no separator, no traversal, no trailing `[ .]`.
      const overlong = "a".repeat(300);
      expect(isSafeKitId(overlong)).toBe(true);

      await expect(getKit(store, { kitId: overlong })).rejects.toBeInstanceOf(ProjectNotFoundError);

      // Anti-vacuity: the control has to reach the same answer by the ordinary
      // route, or "absent" could be coming from a gate rather than the store.
      await expect(getKit(store, { kitId: "no-such-kit" })).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    } finally {
      await rm(kitsRoot, { recursive: true, force: true });
    }
  });

  it("🔒 a deep kits root is an operational fault, not a missing kit", async () => {
    // `ENAMETOOLONG` has two causes and only one is the caller's.
    //
    //   - NAME_MAX: one component is too long. That is the id, and it names no
    //     kit on any filesystem, so absence is the honest answer.
    //   - PATH_MAX: the WHOLE pathname is too long. With a short id that is the
    //     configured root, and reporting it as absence hides a deployment fault
    //     behind `kitNotFound` — #252's fault-as-absence, in the predicate that
    //     was added to remove it.
    //
    // `readMeta` is shared by kits AND projects, so the misreading is not
    // confined to one lookup: a deep `GENIE_HOME` makes the whole store answer
    // "nothing is here".
    //
    // 24 x 200 chars clears PATH_MAX on both mainstream limits (1024 on macOS,
    // 4096 on Linux) while every component stays well inside NAME_MAX. The root
    // is deliberately not created: the classification is what is under test,
    // and an absent root reaches ENOENT, not ENAMETOOLONG.
    const deepRoot = `/${Array.from({ length: 24 }, () => "d".repeat(200)).join("/")}`;
    const store = new LocalFsKitStore(deepRoot);

    const error = await getKit(store, { kitId: "ui" }).then(
      () => undefined,
      (thrown: unknown) => thrown as NodeJS.ErrnoException,
    );

    expect(isSafeKitId("ui")).toBe(true);
    expect(error).toBeDefined();
    expect(
      error,
      "the id is 2 bytes — representable on every filesystem — so the overflow " +
        "came from the configured root, which is an operational fault",
    ).not.toBeInstanceOf(ProjectNotFoundError);
    expect(error?.code).toBe("ENAMETOOLONG");

    // Anti-vacuity, and the other half of the attribution: an id that really is
    // unrepresentable still answers absence, so this is not simply "stop
    // treating ENAMETOOLONG as absence".
    const shallowRoot = await mkdtemp(join(tmpdir(), "genie-kit-id-attrib-"));
    try {
      await expect(
        getKit(new LocalFsKitStore(shallowRoot), { kitId: "a".repeat(300) }),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
    } finally {
      await rm(shallowRoot, { recursive: true, force: true });
    }
  });

  it("🔒 attributes component overflow by code units, not UTF-8 bytes", async () => {
    // The attribution above needs a portable "this component is too long"
    // test, and UTF-8 BYTES are not one. Filesystems do not agree on the unit:
    //
    //   - ext4 / XFS / btrfs cap a component at 255 BYTES;
    //   - NTFS caps it at 255 UTF-16 CODE UNITS;
    //   - APFS is Unicode-oriented and accepts names well past 255 bytes.
    //
    // So a byte count over-reports on the two Unicode-oriented filesystems,
    // and over-reporting is the unsafe direction: it re-creates #252's
    // fault-as-absence for an id the filesystem can represent perfectly well.
    //
    // Code units are the sound conservative unit. Every code point costs at
    // least as many UTF-8 bytes as UTF-16 units (BMP 1-3 bytes / 1 unit,
    // astral 4 / 2), so "over 255 units" implies "over 255 bytes" and clears
    // EVERY cap above. The cases it gives up fail in the safe direction: an
    // operational fault stays a diagnosable fault instead of becoming a lie.
    const unicodeId = "\u{1F600}".repeat(100);
    expect(isSafeKitId(unicodeId)).toBe(true);
    // The discriminator: 200 units, 400 bytes. A byte rule calls this
    // unrepresentable; a code-unit rule does not — and the filesystem agrees
    // with the code-unit rule.
    expect(unicodeId.length).toBe(200);
    expect(Buffer.byteLength(unicodeId, "utf-8")).toBe(400);

    // Proof rather than assertion: the name really is creatable here, so
    // classifying it "unrepresentable" is factually wrong on this platform.
    const shallowRoot = await mkdtemp(join(tmpdir(), "genie-kit-id-units-"));
    try {
      let representable = true;
      try {
        await mkdir(join(shallowRoot, unicodeId));
      } catch {
        representable = false;
      }
      // Skip on a filesystem that genuinely refuses it (ext4 at 400 bytes)
      // rather than assert a platform this test cannot see.
      if (!representable) return;

      const deepRoot = `/${Array.from({ length: 24 }, () => "d".repeat(200)).join("/")}`;
      const error = await getKit(new LocalFsKitStore(deepRoot), { kitId: unicodeId }).then(
        () => undefined,
        (thrown: unknown) => thrown as NodeJS.ErrnoException,
      );

      expect(error).toBeDefined();
      expect(
        error,
        "200 code units is inside every component cap, so the overflow came " +
          "from the configured root — an operational fault, not a missing kit",
      ).not.toBeInstanceOf(ProjectNotFoundError);
      expect(error?.code).toBe("ENAMETOOLONG");
    } finally {
      await rm(shallowRoot, { recursive: true, force: true });
    }
  });

  it("🔒 keeps the code but not the path when a kit exists and cannot be read", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-kit-id-unreadable-"));
    const locked = join(kitsRoot, "locked");
    try {
      await mkdir(locked, { recursive: true });
      await chmod(locked, 0o000);

      // Skip where the mode does not actually deny (root, or a filesystem that
      // ignores POSIX modes) rather than assert a fault that never happened.
      let denied = true;
      try {
        await readFile(join(locked, ".kit.json"), "utf-8");
        denied = false;
      } catch (error) {
        denied = (error as NodeJS.ErrnoException).code === "EACCES";
      }
      if (!denied) return;

      const store = new LocalFsKitStore(kitsRoot);
      const error = await getKit(store, { kitId: "locked" }).then(
        () => undefined,
        (thrown: unknown) => thrown as NodeJS.ErrnoException,
      );

      // Still a fault, not absence — #252. The code is what `plan` surfaces.
      expect(error).toBeDefined();
      expect(error).not.toBeInstanceOf(ProjectNotFoundError);
      expect(error?.code).toBe("EACCES");
      expect(String(error?.message)).toContain("EACCES");

      // …but nothing that names where the server keeps its kits.
      expect(String(error?.message)).not.toContain(kitsRoot);
      expect(String(error?.path ?? "")).not.toContain(kitsRoot);
    } finally {
      await chmod(locked, 0o755).catch(() => undefined);
      await rm(kitsRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The store contract must not promise an identity `isSafeKitId` deliberately
 * withholds.
 *
 * Widening the gate to `isSafeKitId` admits ids the narrow shape rule excluded,
 * and `store/kit-files.ts` is explicit about the price: the accepted alias
 * classes "do NOT give ... canonical-id identity", so a verb "routed by such an
 * id acts on that kit under a name `list_kits` never handed out". That is the
 * authority, and it is stated once.
 *
 * `store/interface.ts` then promised the opposite for `getKit` — that its
 * `KitMeta.id` is "the same routing key `listKits` reports — so the two sides
 * of the store agree on identity". Both sentences shipped in this PR, so the
 * contradiction is self-inflicted, and it is not hypothetical on either
 * adapter:
 *
 *   - GitHost: `readKitMeta` returns `id: kitId` on success but falls back to
 *     `id: repo.name` when the marker is unreadable, while `listKits` always
 *     publishes `repo.name`.
 *   - LocalFs: on a case-insensitive filesystem — APFS and NTFS, i.e. most
 *     developer machines, verified on this checkout — `getKit("VICTIM")` opens
 *     the directory `victim` and echoes `"VICTIM"`, while `listKits` reports
 *     `"victim"`.
 *
 * A caller that trusts the interface sentence would treat those as the same
 * routing key and, for a destructive verb, act under a name the catalogue never
 * published. The residual is accepted (closing it needs `realpath` in both
 * adapters); publishing it as closed is not.
 *
 * So this locks the PROPERTY, not the wording: any docblock that names both
 * sides and asserts they agree must also carry the qualifier. The scan is
 * derived — it reads the tracked tree rather than a list of files — because the
 * claim is a sentence, and a sentence can be restated anywhere.
 */
describe("kitId gate — the store contract does not over-promise id identity", () => {
  // A sentence that mentions the single-kit lookup AND the catalogue.
  const NAMES_BOTH_SIDES = /\b(?:getKit|get_kit|KitMeta\.id)\b/u;
  const NAMES_CATALOGUE = /\b(?:listKits|list_kits)\b/u;
  // ...and claims they are the same thing. The sameness word alone is far too
  // weak a signal: `git-host.ts` says `undefined` "is the same signal this
  // method already returns", names both verbs as its callers, and asserts
  // nothing at all about ids. So the claim only counts when the sameness word
  // is ABOUT the identifier — which is the property being locked, not a
  // convenient way to silence one file.
  const CLAIMS_AGREEMENT = /\b(?:agree\w*|the same|identical|echo(?:es|ed)?|match(?:es|ing)?)\b/giu;
  const IDENTITY_SUBJECT = /\b(?:id|ids|identity|identifier|routing key)\b/iu;
  const SUBJECT_WINDOW = 48;
  // ...without acknowledging the alias residual that authority documents.
  const CARRIES_QUALIFIER =
    /\b(?:alias|spelling|canonical|residual|case-insensit|short name|never handed out|not give|do NOT|unless|except)\b/iu;

  /** Every docblock sentence in `source`, flattened to one line. */
  const sentences = (source: string): string[] =>
    commentTexts(source)
      .flatMap((comment) => comment.split(/(?<=\.)\s+/u))
      .map((sentence) =>
        sentence
          .replace(/^[ \t]*\*+ ?/gmu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .filter((sentence) => sentence !== "");

  /**
   * True when `sentence` claims sameness OF THE IDENTIFIER, rather than of some
   * other thing that happens to be shared.
   *
   * A fresh regex per call: `CLAIMS_AGREEMENT` is global, and a global regex
   * shared between calls carries `lastIndex` and silently skips matches.
   */
  const claimsIdentityAgreement = (sentence: string): boolean => {
    const scan = new RegExp(CLAIMS_AGREEMENT.source, CLAIMS_AGREEMENT.flags);
    for (const hit of sentence.matchAll(scan)) {
      const at = hit.index ?? 0;
      const window = sentence.slice(
        Math.max(0, at - SUBJECT_WINDOW),
        at + hit[0].length + SUBJECT_WINDOW,
      );
      if (IDENTITY_SUBJECT.test(window)) return true;
    }
    return false;
  };

  /** Sentences in `source` that promise identity agreement unconditionally. */
  const overPromises = (source: string): string[] =>
    sentences(source).filter(
      (sentence) =>
        NAMES_BOTH_SIDES.test(sentence) &&
        NAMES_CATALOGUE.test(sentence) &&
        claimsIdentityAgreement(sentence) &&
        !CARRIES_QUALIFIER.test(sentence),
    );

  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const serverRoot = dirname(dirname(toolsDir));
  const SELF = trackedPath(serverRoot, fileURLToPath(import.meta.url));

  it("🔒 no docblock claims getKit and listKits agree on identity unconditionally", async () => {
    const offenders: string[] = [];
    for (const relative of trackedFiles(serverRoot)) {
      // This file states the forbidden shape in order to forbid it. The
      // exclusion is paid for by the two-sided fixture below, which asserts the
      // same predicate still FIRES — so a weakened pattern fails there rather
      // than passing silently here.
      if (!relative.endsWith(".ts") || relative === SELF) continue;
      const source = await readFile(join(serverRoot, relative), "utf8");
      for (const sentence of overPromises(source)) {
        offenders.push(`${relative}: ${sentence}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("🔒 that scan can tell an unconditional claim from a qualified one", () => {
    const unconditional =
      "/**\n * `KitMeta.id` echoes the `kitId` looked up — the same routing key\n" +
      " * `listKits` reports — so the two sides agree on identity.\n */";
    const qualified =
      "/**\n * `KitMeta.id` echoes the `kitId` looked up, which `listKits` also reports\n" +
      " * unless the id is a non-canonical spelling of the kit it opens.\n */";
    // Sameness of something OTHER than the identifier, naming both verbs. This
    // is a real sentence from `store/git-host.ts`, kept here because it is the
    // exact shape a coarser "does it say 'the same'?" scan gets wrong.
    const sameOtherThing =
      "/**\n * Returning `undefined` is deliberate: it is the same signal this method\n" +
      " * already returns for a MISSING marker, and both callers (listKits, getKit)\n" +
      " * answer it by falling back to repo metadata.\n */";
    expect(overPromises(unconditional)).toHaveLength(1);
    expect(overPromises(qualified)).toEqual([]);
    expect(overPromises(sameOtherThing)).toEqual([]);
  });

  it("🔒 the alias residual is still stated by the rule that owns it", async () => {
    // If this ever fails, the premise above has been deleted rather than the
    // claim corrected, and the negative scan would start passing vacuously.
    const rule = await readFile(join(serverRoot, "src", "store", "kit-files.ts"), "utf8");
    const prose = commentTexts(rule).join(" ").replace(/\s+/gu, " ");
    expect(prose).toContain("canonical-id identity");
    expect(prose).toContain("`list_kits` never handed out");
  });
});
