import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeKitId, resolveSafeKitRoot } from "./kit-id.js";

describe("isSafeKitId", () => {
  it("accepts ordinary single-segment kit ids", () => {
    for (const id of ["acme-kit", "kit1", "My_Kit.2", "a", "..kit", "kit..", "my..kit"]) {
      expect(isSafeKitId(id)).toBe(true);
    }
  });

  it("rejects an empty kit id", () => {
    // An empty kitId resolves straight back to the kits root, which would let a
    // caller read across sibling kits via the `path` arg — so it must be unsafe.
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

describe("resolveSafeKitRoot", () => {
  const kitsRoot = resolve("/srv/.genie/kits");

  it("resolves a valid kit id to its directory under the kits root", () => {
    expect(resolveSafeKitRoot(kitsRoot, "acme-kit")).toBe(resolve(kitsRoot, "acme-kit"));
  });

  it("returns null for every unsafe kit id (empty, dot-names, separators)", () => {
    for (const id of ["", ".", "..", "a/b", "..\\etc", "../../etc", "/abs"]) {
      expect(resolveSafeKitRoot(kitsRoot, id)).toBeNull();
    }
  });

  it("never resolves outside the kits root", () => {
    // Even if isSafeKitId were loosened, the containment guard must hold: none
    // of these may resolve to a path outside kitsRoot.
    for (const id of ["", "..", "../sibling"]) {
      const result = resolveSafeKitRoot(kitsRoot, id);
      if (result !== null) {
        expect(result.startsWith(kitsRoot)).toBe(true);
      }
    }
  });
});

