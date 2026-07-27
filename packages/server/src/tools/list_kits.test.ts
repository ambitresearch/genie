import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer } from "../server.js";
import { KIT_TYPE, type KitStore } from "../store/interface.js";
import { LocalFsKitStore } from "../store/local.js";
import { LIST_KITS_DESCRIPTION, LIST_KITS_TOOL_NAME, listWritableKits } from "./list_kits.js";

describe("listWritableKits", () => {
  it("maps editable GENIE_KIT store records to the public list_kits result", async () => {
    const store: KitStore = {
      async listKits() {
        return [
          {
            id: "commerce-kit",
            name: "Commerce Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ];
      },
      async getKit() {
        throw new Error("not used");
      },
      async listFiles() {
        throw new Error("not used");
      },
      async listComponents() {
        throw new Error("not used");
      },
      async readFile() {
        throw new Error("not used");
      },
      async createKit() {
        throw new Error("not used");
      },
      async openPlan() {
        throw new Error("not used");
      },
      async commitPlan() {
        throw new Error("not used");
      },
      async closePlan() {
        throw new Error("not used");
      },
    };

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "commerce-kit",
        name: "Commerce Kit",
        owner: "local",
        updatedAt: "2026-06-01T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("returns [] when the store has no kits", async () => {
    const store = {
      async listKits() {
        return [];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([]);
  });

  it("filters out non-GENIE_KIT records returned by a store adapter", async () => {
    const store = {
      async listKits() {
        return [
          {
            id: "legacy-design-sync",
            name: "Legacy",
            type: "PROJECT_TYPE_DESIGN_SYSTEM",
            createdAt: "2026-06-01T10:00:00.000Z",
          },
          {
            id: "native-kit",
            name: "Native Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-02T10:00:00.000Z",
          },
        ];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    await expect(listWritableKits(store)).resolves.toEqual([
      {
        id: "native-kit",
        name: "Native Kit",
        owner: "local",
        updatedAt: "2026-06-02T10:00:00.000Z",
        canEdit: true,
      },
    ]);
  });

  it("keeps the MCP tool description under Claude's 2 KB truncation limit", () => {
    expect(Buffer.byteLength(LIST_KITS_DESCRIPTION, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("🔒 discloses BOTH listing filters, because MCP clients read this as the contract", () => {
    // The description is shipped verbatim to the model as this tool's contract, so a
    // filter the implementation applies but the description omits is a lie the caller
    // cannot detect. `listWritableKits` drops records for two independent reasons and
    // the prose has to account for both:
    //
    //   - stored type is not GENIE_KIT (interop records sharing the store)
    //   - the id would be refused by the kit verbs that apply the shared gate
    //
    // Guard the exact word too: "every ... kit visible to the current store" claimed a
    // completeness this function has never had since the safety filter landed.
    expect(LIST_KITS_DESCRIPTION).not.toMatch(/every genie-native kit visible/iu);
    expect(LIST_KITS_DESCRIPTION).toMatch(/GENIE_KIT/u);
    expect(LIST_KITS_DESCRIPTION).toMatch(/unusable|not (?:a )?valid|cannot be used|refuse/iu);
  });

  it("🔒 does not promise round-trip acceptance this store cannot deliver", () => {
    // The filter enforces exactly one thing: no id is returned that a verb would
    // refuse as UNSAFE. It says nothing about EXISTENCE, and safety is the only
    // property `listWritableKits` can establish — it takes any `KitStore`, and
    // even against a shipped adapter a kit deleted between `list_kits` and
    // `get_kit` is a 404. So "guarantees every id it returns is accepted by the
    // other kit verbs" over-claims in a way no filter here could make true.
    //
    // (Before #282 there was a second, sharper reason: `LocalFsKitStore` routed
    // `listKits` and `getKit` on different values, so the two could disagree
    // about a kit that plainly existed. #282 aligned them — the over-claim did
    // not become safe, it just lost its most vivid counter-example. Part G of
    // `kit-id-gate.test.ts` now locks that alignment instead of pinning it.)
    expect(LIST_KITS_DESCRIPTION).not.toMatch(/guarantees? +every +id/iu);
    expect(LIST_KITS_DESCRIPTION).not.toMatch(/accepted by the other kit verbs/iu);
    expect(LIST_KITS_DESCRIPTION).toMatch(/safety gate|shared safety|safety rule/iu);
    // …and pin the caveat POSITIVELY, not just the two over-claims negatively.
    // Without this the description could re-acquire the promise in wording these
    // `not.toMatch`es do not cover ("every id returned is safe AND resolves"),
    // and the only thing standing between a caller and that misreading — the
    // sentence telling them to still handle a later not-found — could be
    // deleted silently. Safety is decided at list time; existence is not
    // decidable at list time by anything this function can see.
    expect(LIST_KITS_DESCRIPTION).toMatch(/not a promise|no longer fetches/iu);
    expect(LIST_KITS_DESCRIPTION).toMatch(/not-found from a later verb/iu);
  });

  it("🔒 the disclosed filter is the one listWritableKits actually applies", async () => {
    // Pins prose to behaviour: an id the description says is omitted must really be
    // omitted. Without this the two can drift back apart silently.
    const store = {
      async listKits() {
        return [
          {
            id: "native-kit",
            name: "Native Kit",
            type: KIT_TYPE,
            createdAt: "2026-06-02T10:00:00.000Z",
          },
          // Creatable and listable on POSIX; opens the sibling `native-kit` on Win32.
          {
            id: "native-kit.",
            name: "Trailing Dot",
            type: KIT_TYPE,
            createdAt: "2026-06-02T10:00:00.000Z",
          },
        ];
      },
    } as Pick<KitStore, "listKits"> as KitStore;

    const ids = (await listWritableKits(store)).map((kit) => kit.id);
    expect(ids).toEqual(["native-kit"]);
  });
});

describe("LocalFsKitStore.listKits", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("filters metadata files whose stored type is not GENIE_KIT", async () => {
    const store = new LocalFsKitStore(join(tempDir, "kits"));
    await store.createKit("Native Kit", "native-kit");

    await mkdir(join(tempDir, "kits", "foreign-kit"), { recursive: true });
    await writeFile(
      join(tempDir, "kits", "foreign-kit", ".kit.json"),
      JSON.stringify(
        {
          id: "foreign-kit",
          name: "Foreign Kit",
          type: "PROJECT_TYPE_DESIGN_SYSTEM",
          createdAt: "2026-06-01T10:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(store.listKits()).resolves.toHaveLength(1);
    await expect(store.listKits()).resolves.toEqual([
      expect.objectContaining({ id: "native-kit", type: KIT_TYPE }),
    ]);
  });
});

describe("mcp__genie__list_kits tool", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "genie-list-kits-mcp-"));
    const server = createServer({ kitsRoot: join(tempDir, "kits") });
    client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is listed in tools/list with an object-only input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === LIST_KITS_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(tool?.description).toBe(LIST_KITS_DESCRIPTION);
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["kits"],
      additionalProperties: false,
    });
  });

  it("returns [] through MCP when the user has no kits", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ kits: [] });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });

  it("lists editable LocalFsStore kits through MCP", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;
    const kitJson = JSON.parse(
      await readFile(join(tempDir, "kits", kitId, ".kit.json"), "utf8"),
    ) as { createdAt: string };

    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      kits: [
        {
          id: kitId,
          name: "Commerce Kit",
          owner: "local",
          updatedAt: kitJson.createdAt,
          canEdit: true,
        },
      ],
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      {
        id: kitId,
        name: "Commerce Kit",
        owner: "local",
        updatedAt: kitJson.createdAt,
        canEdit: true,
      },
    ]);
  });

  /**
   * 🔒 REGRESSION LOCK — one malformed neighbour must not take out the whole listing.
   *
   * `readMetaIfReadable`'s docblock in `store/local.ts` promises exactly this:
   * "one bad entry must not fail the whole listing". It keeps that promise ONLY
   * for bytes that fail to PARSE. A `.kit.json` that is valid JSON but omits a
   * field `KitMeta` declares REQUIRED sails straight through it — and `KitMeta`
   * is enforced by a cast (`JSON.parse(raw) as T`), not a schema, so nothing
   * downstream catches it either. The promise was kept for the rarer fault and
   * broken for the commoner one.
   *
   * The blast radius is why this is pinned at the PROTOCOL layer and not only in
   * the store contract. `listWritableKits` maps `updatedAt: kit.updatedAt ??
   * kit.createdAt`, so an absent `createdAt` yields `undefined`; the MCP SDK then
   * validates the result against `outputSchema`, where `updatedAt` is a required
   * string, and rejects the ENTIRE response with -32602. Every healthy kit
   * disappears with it, and the error names `kits[N].updatedAt` rather than the
   * offending kit's id — so the user cannot tell which directory to repair.
   *
   * Both assertions are load-bearing and neither implies the other:
   *   - `isError` falsy proves the response survived output validation at all
   *   - the healthy kit being PRESENT proves that survival was not achieved by
   *     returning an empty list
   */
  it("🔒 lists healthy kits when a neighbour's .kit.json omits a required field", async () => {
    const createResult = await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Commerce Kit" },
    });
    const kitId = (
      JSON.parse((createResult.content as { text: string }[])[0]?.text ?? "{}") as {
        kitId: string;
      }
    ).kitId;

    // Hand-written rather than seeded: the shared `test/helpers/seed-kit.ts`
    // always writes a complete `createdAt`, so a malformed-meta fixture has to
    // bypass it by construction. This is the same seeding shape as "filters
    // metadata files whose stored type is not GENIE_KIT" above — the only
    // difference is WHICH part of the declared shape is violated: a wrong `type`
    // there, an absent `createdAt` here. That filter proves the kits root was
    // always known to hold foreign `.kit.json` files; this is the sibling class
    // it did not cover.
    await mkdir(join(tempDir, "kits", "legacy-kit"), { recursive: true });
    await writeFile(
      join(tempDir, "kits", "legacy-kit", ".kit.json"),
      JSON.stringify({ id: "legacy-kit", name: "Legacy Kit", type: KIT_TYPE }, null, 2),
      "utf8",
    );

    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: {},
    });

    expect(result.isError).toBeFalsy();

    const { kits } = result.structuredContent as { kits: { id: string }[] };
    expect(kits.map((kit) => kit.id)).toEqual([kitId]);
  });

  it("rejects unexpected arguments because the schema has no inputs", async () => {
    const result = await client.callTool({
      name: LIST_KITS_TOOL_NAME,
      arguments: { owner: "someone" },
    });

    expect(result.isError).toBe(true);
  });
});

/**
 * A drift lock for one specific stale claim, because it has now recurred THREE
 * times in this change alone.
 *
 * Before #282, `LocalFsKitStore.listKits` really did report the `id` embedded in
 * each `<dir>/.kit.json` while `getKit` routed on the DIRECTORY name — the two
 * could diverge, and prose written against that behaviour was accurate. #282
 * made both sides report the routing key AND made the adapter skip ids
 * `isSafeKitId` refuses, which silently falsified every sentence naming LocalFs
 * as a source of `.kit.json`-derived or unsafe ids.
 *
 * Each recurrence was caught by a reviewer rather than by the suite, and each
 * fix was a hand-edit of the instances someone happened to grep for — the third
 * was missed by the review that found the second. A one-time edit does not stop
 * instance four, so the set is DERIVED: every `.ts` file under `src` is scanned,
 * including this one.
 *
 * The pattern is assembled from fragments so this file's own source does not
 * contain the phrase it searches for. That is not decoration: a lock written the
 * obvious way matches itself, and the only ways out are to exclude the scanning
 * file (which would blind the scan to a real offender that lived in this very
 * file) or to weaken the pattern.
 */
describe("stale-adapter-claim drift lock", () => {
  // Matches a present-tense claim that an adapter hands back the id embedded in
  // a kit's marker file. Deliberately NOT matched: `local.ts`'s "discards" form
  // (the correct post-#282 description) and `kit-id-gate.test.ts`'s past-tense
  // "`listKits` returned `id: meta.id`", which is immediately followed by "#282
  // closed that". History is allowed to describe history.
  //
  // The phrase itself is never written out here — spelling it would make this
  // comment the very offender the lock reports, which is exactly how it failed
  // on its first run.
  const STALE_LOCALFS_ID_CLAIM = new RegExp(
    ["(?:returns|reports)\\s+`?\\.", "kit\\.json`?'s\\s+`?id`?"].join(""),
    "iu",
  );

  async function collectSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await collectSourceFiles(full)));
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
  }

  it("🔒 no source file still credits a shipped adapter with the marker-file id", async () => {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const files = await collectSourceFiles(srcDir);

    // Non-vacuity: prove the scan actually reaches the two files this claim has
    // drifted into, rather than passing over an empty or mis-rooted set.
    const relative = files.map((file) => file.slice(srcDir.length));
    expect(relative).toContain(join("tools", "list_kits.ts"));
    expect(relative).toContain(join("tools", "list_kits.test.ts"));
    expect(relative).toContain(join("store", "local.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      // Collapse wrapped comment lines so a claim split across two ` * ` lines
      // is still seen as one sentence.
      const text = (await readFile(file, "utf8")).replace(/\n\s*\*?\s*/gu, " ");
      if (STALE_LOCALFS_ID_CLAIM.test(text)) offenders.push(file.slice(srcDir.length));
    }

    expect(offenders).toEqual([]);
  });
});
