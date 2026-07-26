import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertRangePatchesCve202527210 } from "../../test/helpers/node-cve.js";
import { trackedFiles } from "../../test/helpers/tracked-files.js";

import {
  isSafeKitId,
  KIT_ID_SAFETY_CATEGORIES,
  KIT_ID_SAFETY_MESSAGE,
  KIT_ID_SAFETY_RATIONALE,
  sriSha256,
} from "./kit-files.js";

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

  it("🔒 gives every kind of rule its own verb rather than sharing one", () => {
    // The test above checks that each rule is MENTIONED. This one checks the
    // mention is grammatical, which is a different failure and was a live one:
    // the message read "it cannot be empty, `.`, `..`, end in a dot or a space,
    // or contain a path separator or a NUL byte" — one verb, "cannot be",
    // distributed across five list items. The last two are verb phrases, not
    // nouns, so a user read "cannot be end in a dot" and "cannot be contain a
    // path separator". This is the only string a rejected caller sees.
    //
    // Derive the requirement instead of pinning the wording. A guard's English
    // verb is decided by the SHAPE of its test, not by its subject: comparing
    // the whole id needs "be", matching an anchored suffix needs "end", and
    // testing a substring needs "contain". So classify each guard by operator
    // and require the message to carry that verb with its own "cannot". Add a
    // `startsWith` guard later and this fails until the message grows a
    // matching "cannot start with" clause — the wording cannot silently fall
    // back to a shared verb again.
    const source = readFileSync(path.join(import.meta.dirname, "kit-files.ts"), "utf8");
    const bodyStart = source.indexOf("export function isSafeKitId");
    expect(bodyStart).toBeGreaterThan(-1);
    const body = source.slice(bodyStart, source.indexOf("\n}", bodyStart));

    const KINDS = [
      { kind: "identity", operator: /===/u, verb: /\bcannot be\b/iu, verbText: "cannot be" },
      {
        kind: "suffix",
        operator: /\$\/u?\.test\(/u,
        verb: /\bcannot end\b/iu,
        verbText: "cannot end",
      },
      {
        kind: "containment",
        operator: /\.includes\(/u,
        verb: /\bcannot contain\b/iu,
        verbText: "cannot contain",
      },
    ] as const;

    const guardLines = body.split("\n").filter((line) => line.includes("return false;"));
    expect(guardLines.length).toBeGreaterThanOrEqual(5);

    const required = new Set<(typeof KINDS)[number]>();
    for (const line of guardLines) {
      const matched = KINDS.filter((k) => k.operator.test(line));
      // Every guard must classify as exactly one kind. A guard matching none
      // is a shape this lock cannot speak about — it would otherwise pass by
      // being invisible — and one matching two makes the required verb
      // ambiguous. Either way the classifier, not the message, needs updating.
      expect(
        matched.map((k) => k.kind),
        `guard did not classify uniquely: ${line.trim()}`,
      ).toHaveLength(1);
      required.add(matched[0]!);
    }

    // Anti-vacuity: the predicate really does mix all three shapes today, so a
    // classifier that silently stopped matching cannot leave this passing on an
    // empty requirement set.
    expect([...required].map((k) => k.kind).sort()).toEqual(["containment", "identity", "suffix"]);

    for (const { kind, verb, verbText } of required) {
      expect(
        KIT_ID_SAFETY_MESSAGE,
        `${kind} guards need their own "${verbText}" clause, not a shared verb`,
      ).toMatch(verb);
    }
  });
});

describe("isSafeKitId", () => {
  it("🔒 documents exactly as many rejection rules as it enforces", () => {
    // The terminating fix for a drift class that recurred four times in this
    // change: a hand-written enumeration of a machine-derivable fact. Three
    // separate places restate this predicate's rejection set — its own
    // docblock, KIT_ID_SAFETY_MESSAGE, and preview.ts's resolveKitDir comment —
    // and each time a guard was added, at least one of them was left describing
    // the previous rule set. Reviewers caught it every time, which is precisely
    // the failure: prose review is the wrong tool for an arithmetic invariant.
    //
    // So derive it. Count the guards in the function BODY and the bullets in
    // the list immediately above it, and require the two to agree. A new guard
    // now fails here until it is written down, and a bullet deleted during a
    // docblock rewrite fails here too. Neither number is typed into this test,
    // so the lock cannot itself go stale — the defect it exists to prevent.
    const source = readFileSync(path.join(import.meta.dirname, "kit-files.ts"), "utf8");

    const bodyStart = source.indexOf("export function isSafeKitId");
    expect(bodyStart).toBeGreaterThan(-1);
    const body = source.slice(bodyStart, source.indexOf("\n}", bodyStart));
    const guards = body.match(/return false;/gu) ?? [];

    // The docblock is the comment block that ends where the function begins.
    const docblock = source.slice(source.lastIndexOf("/**", bodyStart), bodyStart);
    // Only the top-level bullets of the "It returns false for:" list; the
    // "NOT in scope" list below it is indented identically, so cut at its
    // header rather than counting every dash in the block. Search for that
    // header AFTER the list start — the prose above the list forward-references
    // it by name, and an unanchored indexOf finds the reference, not the header.
    const listStart = docblock.indexOf("It returns false for");
    expect(listStart).toBeGreaterThan(-1);
    const scopeHeader = docblock.indexOf("NOT in scope", listStart);
    expect(scopeHeader).toBeGreaterThan(listStart);
    const returnsFalseList = docblock.slice(listStart, scopeHeader);
    const bullets = returnsFalseList.match(/^ \* {3}- /gmu) ?? [];

    expect(bullets.length).toBe(guards.length);
    // Guard the guard: if either regex silently stops matching, the assertion
    // above passes vacuously at 0 === 0.
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  it("🔒 explains a rejection with every category the predicate refuses", () => {
    // The same drift class as the test above, one level out. That lock counts
    // GUARDS against BULLETS; this one counts CATEGORIES against the number the
    // docblock claims. They are deliberately different numbers — five guards
    // implement three kinds of defect — so neither test subsumes the other.
    //
    // The failure this prevents: `preview.ts` told users a refusal guarded
    // "both against escaping the kits root and against an id that aliases a
    // different kit inside it" — two categories — twenty lines above its own
    // comment saying there are three. The NUL guard had introduced a category
    // that is neither an escape nor an alias, and the user-facing string kept
    // the old shape, so a user reading it would conclude their id had been
    // judged a traversal attempt.
    //
    // So the categories are now DATA, the error prose is BUILT from that data,
    // and the count is checked against the docblock's own claim. A fourth kind
    // fails here until both move.
    const source = readFileSync(path.join(import.meta.dirname, "kit-files.ts"), "utf8");

    const claim = /refuses (\w+) different kinds of id/u.exec(source);
    expect(claim).not.toBeNull();
    const declared = { two: 2, three: 3, four: 4, five: 5 }[claim![1] as string];
    expect(declared).toBeDefined();

    expect(KIT_ID_SAFETY_CATEGORIES.length).toBe(declared);
    // Every category must survive into the rendered rationale; a join that
    // silently dropped one would otherwise pass the count check above.
    for (const category of KIT_ID_SAFETY_CATEGORIES) {
      expect(KIT_ID_SAFETY_RATIONALE).toContain(category);
    }
  });

  it("\u{1F512} is never glossed with a shorter list of categories than it has", () => {
    // The count lock above pins ONE docblock. `preview.ts` then spent a release
    // summarising the same rule as "(containment + identity)" — an enumeration
    // of TWO categories, one line above the constructor that had already been
    // rewired to render all three from KIT_ID_SAFETY_CATEGORIES. Pinning the
    // authority does not stop a caller writing its own shorter list, so this is
    // a DISCOVERY lock over every source file rather than a check on a known
    // one.
    //
    // It fires on the enumerating SHAPE, not on a vocabulary: a parenthetical
    // gloss attached to the rule that joins its items with `+` or `and`. The
    // terminating fix is never to re-count such a gloss — the count moves — but
    // to delete it and let the rendered rationale speak.
    const srcRoot = path.join(import.meta.dirname, "..");
    const files = trackedFiles(srcRoot)
      .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts"))
      .map((rel) => path.join(srcRoot, rel));
    expect(files.length).toBeGreaterThan(20);

    const gloss = /isSafeKitId`?\s+rule\s+\(([^)]*)\)/gu;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(gloss)) {
        const items = match[1]!.split(/\s*(?:\+|,|\band\b)\s*/u).filter(Boolean);
        if (items.length > 1 && items.length < KIT_ID_SAFETY_CATEGORIES.length)
          offenders.push(`${path.basename(file)}: (${match[1]!})`);
      }
    }
    expect(offenders).toEqual([]);
  });

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
    // id NEVER RESOLVES TO A DIFFERENT KIT THAN IT SPELLS. (Not that it opens a
    // kit at all — the test below deliberately accepts `Victim` and `VICTIM~1`,
    // alternate spellings of one real directory, and `CON`, which is a device.) A plan for `victim..` stays under the
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

// The rationale above is the reason THIS lock exists. `isSafeKitId` deliberately
// accepts Win32 device names, so any prose promising that an accepted id "spells
// the directory it opens" is false by the predicate's own accepted set — a device
// name opens a device, not a directory. That claim was restated at four sites and
// review caught two of them, so the check is repo-wide rather than per file.
//
// It is DERIVED, not a banned phrase: the ban is conditional on the predicate
// still admitting a device name. Tighten `isSafeKitId` to refuse them and this
// lock retires itself instead of outlawing wording that has become true.
it("🔒 no rationale promises an accepted kitId opens a kit directory", () => {
  const deviceNames = ["CON", "NUL", "PRN", "AUX", "COM1", "LPT1"].filter(isSafeKitId);
  // Anti-vacuity: the claim is only wrong while these stay accepted.
  expect(deviceNames.length).toBeGreaterThan(0);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const sources = trackedFiles(repoRoot)
    .filter((relative) => /\.(?:ts|tsx|md)$/u.test(relative))
    .map((relative) => path.join(repoRoot, relative));
  expect(sources.length).toBeGreaterThan(100);

  const offenders = sources.filter((file) =>
    // Collapse docblock leaders first: the claim spans a line break at every
    // site, so a same-line pattern silently passes.
    // Both spellings: the authority itself said "names", so a `spells`-only
    // pattern would have missed the one site that mattered most.
    /(?:spells?|names?)\s+the\s+directory\s+it\s+opens/iu.test(
      readFileSync(file, "utf8").replace(/\n\s*\*?\s*/gu, " "),
    ),
  );
  expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
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
const publishablePackages = trackedFiles(fileURLToPath(new URL("../../../", import.meta.url)))
  .filter((relative) => /^[^/]+\/package\.json$/u.test(relative))
  .map((relative) => new URL(`../../../${relative}`, import.meta.url))
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

it("🔒 no comment still calls isSafeKitId merely a containment rule", () => {
  // The docblock above was corrected to say `isSafeKitId` is a
  // CONTAINMENT-AND-IDENTITY rule: alongside escapes it also refuses ids that
  // stay inside the kits root but do not SPELL the kit they open, and ids no
  // filesystem call would accept. Callers that go on describing it as "the
  // containment rule" teach the superseded, narrower contract, and a future
  // caller re-deriving the check from one of those sentences would reimplement
  // traversal defence alone and drop the identity half.
  //
  // Discovered, not enumerated. The same drift has now been corrected three
  // times in this review and each time a hand-listed set of sites left one
  // behind, so this asks the TREE which comments describe the predicate rather
  // than trusting a list to stay complete.
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = trackedFiles(srcRoot)
    .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts"))
    .map((rel) => path.join(srcRoot, rel));

  const describing: string[] = [];
  const historical: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    // Comments only. The predicate's NAME appears in live code at every call
    // site; it is the prose around it that can teach the wrong contract.
    const comments = [
      ...text.matchAll(/\/\*[\s\S]*?\*\//gu),
      ...text.matchAll(/(?:^|[^:])(\/\/.*(?:\n\s*\/\/.*)*)/gmu),
    ].map((match) => match[0]);
    for (const comment of comments) {
      if (!comment.includes("isSafeKitId")) continue;
      const rel = path.relative(srcRoot, file);
      describing.push(rel);
      // A comment that RECORDS a corrected claim has to keep quoting the wrong
      // words to stay legible; `preview.ts` deliberately preserves the old
      // wording as history. Only claims made in the present tense are drift.
      if (/used to/u.test(comment)) historical.push(rel);
      else if (/containment rule/u.test(comment)) stale.push(rel);
    }
  }

  // Anti-vacuity, both arms. An empty walk would satisfy the assertion below
  // while reading nothing, and if the historical exemption never fired it would
  // be dead weight that could silently start excusing real drift.
  expect(describing.length).toBeGreaterThan(3);
  expect(historical.length).toBeGreaterThan(0);

  expect(
    [...new Set(stale)].sort(),
    "these comments describe isSafeKitId as merely a containment rule, which is " +
      "the contract it had BEFORE the identity and representability guards were " +
      "added — say containment-and-identity, or point at the docblock in " +
      "kit-files.ts rather than restating a narrower version of it",
  ).toEqual([]);
});

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

// The scan above covers the PUBLISHED runtime. The monorepo root is private, so
// it is outside that scan — but it is not outside the contract, because it is the
// manifest that governs a SOURCE checkout, and `CONTRIBUTING.md` and
// `docs/developer/contributing.md` state the same patched range to contributors
// who clone this repo. Leaving the root at a bare `>=22.19.0` let those docs
// promise a range the manifest beside them contradicted: `>=22.19.0` is satisfied
// by an unpatched 23.5.0. Private means "not installed by consumers", not
// "exempt from the CVE" — a contributor runs the same `writeFiles` path.
it("🔒 the source checkout declares a Node range with no vulnerable release in it", () => {
  const root = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf-8"),
  ) as { private?: boolean; engines?: { node?: string } };

  // Anti-vacuity: if the root ever stops being private it joins the scan above
  // instead, and this test should be deleted rather than left duplicating it.
  expect(root.private, "root manifest is expected to be private").toBe(true);

  const range = root.engines?.node ?? "";
  expect(range, "root must declare engines.node").not.toBe("");
  assertRangePatchesCve202527210(range, "monorepo root");
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
