import { describe, expect, it } from "vitest";
import { hasRequiredKitMetaFields, isSafeKitId, sriSha256 } from "./kit-files.js";

/**
 * The ONE kitId-safety rule shared by `list_files`, `read_file`, and both
 * `KitStore` adapters (DRO-581 unification, AC1). These cases pin the canonical
 * rule so any future edit that loosens it — re-opening the cross-kit read hole
 * (AC-SEC) or letting the two tools drift — fails here first.
 */
describe("isSafeKitId", () => {
  it("accepts ordinary single-segment kit ids", () => {
    for (const id of ["acme-kit", "kit1", "My_Kit.2", "a", "..kit", "kit..", "my..kit"]) {
      expect(isSafeKitId(id)).toBe(true);
    }
  });

  it("rejects the empty string (it resolves to the kits root → cross-kit read)", () => {
    // AC-SEC: an empty kitId names no kit; `join(kitsRoot, "")` is the kits root
    // itself, so a crafted `path` would read a sibling kit. Must be rejected.
    expect(isSafeKitId("")).toBe(false);
  });

  it("rejects the traversal dot-names exactly", () => {
    expect(isSafeKitId(".")).toBe(false);
    expect(isSafeKitId("..")).toBe(false);
  });

  it("rejects any kit id containing a path separator", () => {
    for (const id of ["a/b", "safe-kit/src", "../etc", "..\\etc", "a\\b", "/abs", "\\abs"]) {
      expect(isSafeKitId(id)).toBe(false);
    }
  });
});

/**
 * `KitMeta` declares `name` and `createdAt` REQUIRED, but `.kit.json` is parsed
 * with `JSON.parse(raw) as T` — an erased cast that checks nothing. So a file
 * missing a field produced a `KitMeta` violating its own declared type, and the
 * damage landed at the MCP boundary: `list_kits` validates its output against
 * `listKitsEntryShape`, so ONE malformed kit failed the WHOLE response and every
 * other kit vanished with it.
 *
 * This predicate is the shared shape check both adapters apply before they
 * publish or serve a meta. It deliberately checks ONLY `name` and `createdAt`:
 * `id` is discarded by both adapters in favour of the routing key (#282), and
 * `type` is gated by LocalFs but not by GitHost, so folding it in here would
 * silently change which git-host repos resolve.
 */
describe("hasRequiredKitMetaFields", () => {
  it("accepts a meta carrying both required fields", () => {
    expect(
      hasRequiredKitMetaFields({
        id: "acme-kit",
        name: "Acme Kit",
        type: "GENIE_KIT",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("rejects a meta missing either required field", () => {
    // The real-world seeds: a hand-made kit dir, a kit adopted from a git host,
    // or an older-format `.kit.json` written before the field existed.
    expect(hasRequiredKitMetaFields({ id: "k", name: "K", type: "GENIE_KIT" })).toBe(false);
    expect(hasRequiredKitMetaFields({ id: "k", type: "GENIE_KIT", createdAt: "2026-01-01" })).toBe(
      false,
    );
    expect(hasRequiredKitMetaFields({})).toBe(false);
  });

  it("rejects a present-but-wrong-typed field", () => {
    // `JSON.parse` happily yields numbers, nulls and objects here. The MCP
    // output schema requires strings, so a non-string is exactly as fatal as
    // an absent field — the predicate must not accept it merely for existing.
    expect(hasRequiredKitMetaFields({ name: "K", createdAt: 1735689600000 })).toBe(false);
    expect(hasRequiredKitMetaFields({ name: null, createdAt: "2026-01-01" })).toBe(false);
    expect(hasRequiredKitMetaFields({ name: "K", createdAt: { iso: "2026-01-01" } })).toBe(false);
  });

  it("rejects non-objects without throwing", () => {
    // `readMetaIfReadable` tolerates unreadable bytes but NOT shape, so these
    // reach the predicate as-is. A throw here would defeat the very tolerance
    // the listing walk depends on: one bad entry must not fail the listing.
    for (const notAnObject of [null, undefined, "meta", 42, true, []]) {
      expect(hasRequiredKitMetaFields(notAnObject)).toBe(false);
    }
  });
});

/**
 * `sriSha256` is the full-buffer reference the streamed LocalFs walk
 * (`hashFileStream`) must match byte-for-byte (AC3). This pins its exact output
 * shape so the two forms can be compared in the store/tool suites.
 */
describe("sriSha256", () => {
  it("produces a stable sha256-<base64> SRI string", () => {
    expect(sriSha256("hello")).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    // Known-answer: sha256("") base64 digest is the canonical empty-input hash.
    expect(sriSha256(Buffer.alloc(0))).toBe("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });
});
