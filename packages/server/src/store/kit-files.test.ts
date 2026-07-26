import { readFileSync } from "node:fs";
import path from "node:path";

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
    for (const id of ["acme-kit", "kit1", "My_Kit.2", "a", "..kit", "my..kit"]) {
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

  it("🔒 rejects the Win32 trailing-space/dot aliases of a SIBLING kit", () => {
    // The rule above closes the aliases that trim away to nothing (they name the
    // kits ROOT or its parent). This closes the rest of the same class: an id
    // that trims to a DIFFERENT, NON-EMPTY name is an alias for a sibling kit.
    //
    //   `join(root, "victim..")` → `root\victim..` → Win32 → `root\victim`
    //
    // Containment is not the whole contract: `isSafeKitId` promises an accepted
    // id SPELLS THE DIRECTORY IT OPENS. (Not that it names one kit — the test
    // below deliberately accepts `Victim` and `VICTIM~1`, which are alternate
    // spellings of one real directory.) A plan for `victim..` stays under the
    // kits root and still
    // mutates or deletes `victim`, because `LocalFsKitStore.deleteFile` and
    // `writeFiles` resolve through the unsafe `kitDir`, with this predicate as
    // the only guard.
    //
    // Rejecting costs nothing on the platform where the alias is live: Windows
    // strips trailing dots/spaces in `mkdir` too, so a directory named
    // `victim..` CANNOT EXIST there. The id can only ever alias — it can never
    // name a real kit. (Contrast case-insensitivity: `Victim` and `victim` also
    // collide on Windows/macOS, but each CAN name the single real directory, so
    // that is a filesystem property, not a gate hole — and refusing uppercase is
    // the very over-rejection this PR exists to remove.)
    for (const id of ["victim..", "victim.", "victim ", "kit..", "a.", "a ", "kit. "]) {
      expect(isSafeKitId(id), `expected ${JSON.stringify(id)} to be refused`).toBe(false);
    }
  });

  it("🔒 still accepts ids whose dots/spaces are interior or leading", () => {
    // The alias rule must close the escape WITHOUT re-tightening the shape —
    // these are the ids the pre-unification slug gate wrongly refused. Win32
    // only trims the TRAILING run, so none of these normalize to another name.
    for (const id of ["my..kit", "..kit", "My_Kit.2", "a b", ". kit", "UPPER", "ui", "a"]) {
      expect(isSafeKitId(id), `expected ${JSON.stringify(id)} to be allowed`).toBe(true);
    }
  });
});

// Filesystem name-EQUIVALENCE is deliberately out of scope, and that decision
// needs a lock rather than only a comment: every review round so far has
// proposed widening the denylist by one more character class, and each of
// these would break `list_kits`' promise the moment it did.
//
// The dividing line the predicate documents: `victim.` CANNOT name a real
// directory (Windows applies the same trim in `mkdir`), so it can only ever
// alias. Each id below CAN name a real directory on some platform, so it has
// a legitimate referent and refusing it is the over-rejection this rule was
// unified to remove.
it("🔒 accepts ids that are only ALIASES via filesystem name-equivalence", () => {
  for (const id of [
    // NTFS DOS 8.3 short names. `mkdir "VICTIM~1"` succeeds everywhere, and
    // where one exists NTFS gives the long-named kit `VICTIM~2`, so the two
    // never collide. `~` is legal on POSIX too, so refusing it would make a
    // real `my~kit` listable-but-unusable.
    "VICTIM~1",
    "PROGRA~1",
    "my~kit",
    "kit~",
    // Case folding on Windows/macOS. Refusing these IS the original defect —
    // `Design-System` is a legitimate git-host repo name.
    "Victim",
    "Design-System",
    // Win32 reserved device names resolve to a device, not to another kit.
    "CON",
    "NUL",
  ]) {
    expect(isSafeKitId(id), `${id} must stay accepted`).toBe(true);
  }
});

// CVE-2025-27210: on Windows, `path.join`/`path.normalize` could be walked out
// of a base directory using a reserved DEVICE NAME segment, and the fix only
// landed in 22.17.1 / 20.19.4 / 24.4.1. Review round 11 asked whether accepting
// `CON`/`NUL` above therefore leaves the gate exploitable on an older Node 22.
//
// It does not, and the reason is structural rather than a version check: the
// published exploit needs a device-name segment FOLLOWED BY traversal segments
// in one string (`..\\CON\\..\\..\\etc\\passwd`). `isSafeKitId` refuses every
// separator, so an accepted id is always a SINGLE path component, and the
// trailing-dot/space rule removes the only separator-free way to end an id in a
// traversal segment. There is no accepted id left that has the shape the CVE
// needs. This pins that argument so a future loosening of either rule fails
// here, next to the rationale it protects, instead of in a Windows-only report.
it("🔒 no accepted kitId can carry the CVE-2025-27210 device-name shape", () => {
  const ROOT = "C:\\kits";
  const accepted = ["CON", "NUL", "COM1", "AUX", "PRN", "LPT1", "..CON", "CON.txt", "CONx"];
  for (const id of accepted) {
    expect(isSafeKitId(id), `${id} is expected to remain accepted`).toBe(true);
    // A single component: no separator to start a second segment from.
    expect(id).not.toMatch(/[/\\]/u);
    // And it still resolves strictly inside the kits root on Win32 semantics.
    for (const resolved of [path.win32.join(ROOT, id), path.win32.resolve(ROOT, id)]) {
      expect(resolved.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\`), `${id} escaped`).toBe(
        true,
      );
    }
  }
  // Every spelling that WOULD carry the CVE shape is already refused.
  for (const id of [
    "..\\CON\\..\\..\\etc\\passwd",
    "CON\\..\\..",
    "..\\CON\\..",
    "CON..",
    "CON.",
    "CON ",
  ]) {
    expect(isSafeKitId(id), `${JSON.stringify(id)} must be refused`).toBe(false);
  }
});

// The rationale above argues the kitId GATE is unaffected by CVE-2025-27210.
// The other half of that answer is packaging: `writeFiles`/`readFile` take a
// `path` that legitimately DOES contain separators, so a consumer installing
// this server on an unpatched Node 22 is exposed on that surface no matter what
// the kitId rule does. The workspace already tests on a patched floor; this
// pins the PUBLISHED floor to a patched release too, so the two cannot drift.
it.each([
  ["@ambitresearch/genie", "../../package.json"],
  ["@ambitresearch/genie-viewer", "../../../viewer/package.json"],
])("🔒 %s declares a Node floor that patches CVE-2025-27210", (_name, rel) => {
  // Both published packages call `node:path` on caller-supplied strings, so both
  // need a patched floor. Checking them together is deliberate: a floor raised on
  // one package and not the other is the same two-contracts drift this PR fixes.
  const manifest = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")) as {
    engines?: { node?: string };
  };
  const range = manifest.engines?.node ?? "";
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/u.exec(range);
  expect(m, `engines.node must pin an explicit patch floor, got ${JSON.stringify(range)}`).not.toBe(
    null,
  );
  const [major, minor, patch] = m!.slice(1).map(Number) as [number, number, number];
  // Patched releases: 20.19.4, 22.17.1, 24.4.1. Both packages require Node 22+.
  expect(major).toBeGreaterThanOrEqual(22);
  const atLeast22_17_1 = major > 22 || minor > 17 || (major === 22 && minor === 17 && patch >= 1);
  expect(atLeast22_17_1, `${range} predates the CVE-2025-27210 fix (22.17.1)`).toBe(true);
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
