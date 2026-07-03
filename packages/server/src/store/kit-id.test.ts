import { describe, expect, it } from "vitest";
import { isSafeKitId } from "./kit-id.js";

describe("isSafeKitId", () => {
  it("accepts ordinary single-segment kit ids, including embedded dots", () => {
    // A real kit name can carry dots (`v1.2.3`) — only the EXACT `.`/`..`
    // traversal aliases and separators are unsafe, not any string with a dot.
    for (const id of ["acme-kit", "kit1", "My_Kit.2", "a", "..kit", "kit..", "my..kit", "v1.2.3"]) {
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
