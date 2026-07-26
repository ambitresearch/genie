import { describe, expect, it } from "vitest";
import { isSafeKitId, sriSha256 } from "./kit-files.js";

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

  it("🔒 rejects the Win32 trailing-space/dot aliases of the names above", () => {
    // Win32 strips trailing spaces AND trailing dots from a path component at
    // the syscall boundary, so on Windows each of these is a live alias for a
    // name this rule already refuses:
    //
    //   `join(root, " ")`   → `root\ `   → Win32 → `root`        (alias for "")
    //   `join(root, ". ")`  → `root\. `  → Win32 → `root`        (alias for ".")
    //   `join(root, ".. ")` → `root\.. ` → Win32 → PARENT of root (alias for "..")
    //
    // Node's `path` module does NOT perform this trimming (verified: it returns
    // `C:\kits\.. ` verbatim), so a `join`-based containment check sees a
    // contained path while the OS resolves it outside the kits root. The old
    // per-tool slug gate `/^[a-z0-9-]{3,64}$/` refused these incidentally by
    // banning spaces and dots; once the tool layer moved onto this predicate,
    // that incidental cover disappeared and the hole became reachable.
    for (const id of [" ", "  ", ". ", " .", ".. ", "...", ". .", ".. .", " . "]) {
      expect(isSafeKitId(id), `expected ${JSON.stringify(id)} to be refused`).toBe(false);
    }
  });

  it("🔒 still accepts ids whose trailing dots/spaces are merely cosmetic", () => {
    // The alias rule must close the escape WITHOUT re-tightening the shape.
    // `kit..` and `my..kit` are named in `isSafeKitId`'s docblock as
    // deliberately allowed; they trim to a non-empty literal child of the root
    // and cannot escape it.
    for (const id of ["kit..", "my..kit", "..kit", "My_Kit.2", "a.", "a ", "kit. "]) {
      expect(isSafeKitId(id), `expected ${JSON.stringify(id)} to be allowed`).toBe(true);
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
