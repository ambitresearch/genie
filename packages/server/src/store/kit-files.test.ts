import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertRangePatchesCve202527210 } from "../../test/helpers/node-cve.js";

import { isSafeKitId, KIT_ID_SAFETY_MESSAGE, sriSha256 } from "./kit-files.js";

/**
 * The ONE kitId-safety rule shared by `list_files`, `read_file`, and both
 * `KitStore` adapters (DRO-581 unification, AC1). These cases pin the canonical
 * rule so any future edit that loosens it — re-opening the cross-kit read hole
 * (AC-SEC) or letting the two tools drift — fails here first.
 */
describe("KIT_ID_SAFETY_MESSAGE", () => {
  it("🔒 names every rule isSafeKitId actually applies", () => {
    // The message is the ONLY thing a caller sees when the gate refuses. Each
    // clause below corresponds to a branch of the predicate; a branch added
    // without a clause leaves the user staring at a rejection the message does
    // not explain.
    expect(KIT_ID_SAFETY_MESSAGE).toMatch(/empty/iu);
    expect(KIT_ID_SAFETY_MESSAGE).toMatch(/path separator/iu);
    expect(KIT_ID_SAFETY_MESSAGE).toMatch(/dot or a space|dot nor a space/iu);
    expect(KIT_ID_SAFETY_MESSAGE).toMatch(/NUL|null byte/iu);
  });
});

describe("isSafeKitId", () => {
  it("🔒 rejects an id no filesystem call could ever accept", () => {
    // A NUL byte is a third category, distinct from the traversal and Win32
    // name-normalization rules above. It does not reach a DIFFERENT kit — it
    // reaches NO path at all: every Node fs API refuses a path containing one
    // with `ERR_INVALID_ARG_VALUE` rather than `ENOENT`. MCP arguments arrive as
    // JSON, which can carry `\u0000` verbatim, so without this an id that
    // cleared the gate would surface a raw argument TypeError from deep inside
    // the store instead of the invalid-kit result the tool boundary promises.
    //
    // Scope is deliberately NUL-only. Other control characters (`\u0001`-
    // `\u001f`) are legal in a POSIX directory name, so refusing them would
    // make a legitimately-named kit unusable — the same defect this PR fixes.
    // NUL is the unique character no path may contain on any supported
    // platform, which is why it can be refused without that cost.
    for (const id of ["a\u0000b", "\u0000", "\u0000kit", "kit\u0000"]) {
      expect(isSafeKitId(id)).toBe(false);
    }
  });

  it("🔒 keeps admitting the control-adjacent ids that are real directories", () => {
    // Guards the scope decision above: the NUL rule must not become a blanket
    // control-character denylist.
    for (const id of ["kit\u0001x", "kit\tx", "kit\u001fx"]) {
      expect(isSafeKitId(id)).toBe(true);
    }
  });

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
// this server on an unpatched Node is exposed on that surface no matter what the
// kitId rule does. The workspace already tests on a patched runtime; this pins
// the PUBLISHED runtime to a patched release too, so the two cannot drift.
//
// The package list is DISCOVERED, not hand-written. A literal list is how the
// viewer came to sit at `>=22` while its sibling was raised — the same "one rule,
// restated per site, then drifted" defect this whole PR is about. Scope is stated
// as a rule instead: every publishable workspace package under `packages/`.
// `@ambitresearch/genie-e2e` is inside that scan but excluded by `private: true`,
// because nobody installs it, so its `engines` describes only the dev environment
// CI already pins; the monorepo root sits outside the scan and is private too.
const publishablePackages = readdirSync(new URL("../../../", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => new URL(`../../../${entry.name}/package.json`, import.meta.url))
  .filter((url) => existsSync(url))
  .map((url) => ({
    url,
    manifest: JSON.parse(readFileSync(url, "utf-8")) as {
      name?: string;
      private?: boolean;
      engines?: { node?: string };
    },
  }))
  .filter(({ manifest }) => manifest.private !== true)
  .map(({ url, manifest }) => [manifest.name ?? String(url), manifest] as const);

it("🔒 the publishable-package scan actually finds both published packages", () => {
  // Guards the discovery above: a glob that silently matches nothing would make
  // every assertion below pass vacuously.
  expect(publishablePackages.map(([name]) => name).sort()).toEqual([
    "@ambitresearch/genie",
    "@ambitresearch/genie-viewer",
  ]);
});

it.each(publishablePackages)(
  "🔒 %s declares a Node range with no vulnerable release in it",
  (name, manifest) => {
    // Interval-based, not floor-based. CVE-2025-27210 was fixed per release
    // line (20.19.4 / 22.17.1 / 24.4.1), so a lower endpoint above one patch
    // point says nothing about the lines above it — `>=22.19.0` reads as patched
    // but is satisfied by an unpatched 24.2.0.
    const range = manifest.engines?.node ?? "";
    expect(range, `${name} must declare engines.node`).not.toBe("");
    assertRangePatchesCve202527210(range, name);
  },
);

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
