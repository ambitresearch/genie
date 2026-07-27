import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { commentTexts, stripComments } from "./source-text.js";
import { trackedFiles, trackedPath } from "./tracked-files.js";

const SERVER_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** This file, relative to SERVER_ROOT — see the self-exclusion note below. */
const SELF = trackedPath(SERVER_ROOT, fileURLToPath(import.meta.url));

/**
 * The banned shape, spelled at runtime.
 *
 * Assembled from pieces so that this file does not itself contain the literal
 * it forbids: the scan below reads every tracked source in the package, and a
 * detector that trips on its own definition teaches nothing.
 */
const UNANCHORED_OPENER = ["\\/", "\\*", "[\\s\\S]*?", "\\*", "\\/"].join("");

/** The anchor that makes the opener safe: start of line, indentation only. */
const ANCHOR = "^[ \\t]*";

/**
 * Occurrences of the block-comment pattern that are not anchored to a line
 * start, reported as 1-based line numbers.
 *
 * Deliberately line-based rather than built on `stripComments`. The pattern
 * being searched for ends `\*\/`, so in real source it is immediately followed
 * by the regex flags — `\*\//gu` — and those two slashes read as a line comment.
 * Stripping comments first therefore truncates the very text this is looking
 * for, and reports nothing. Working per line also keeps the reported numbers
 * true: replacing a block comment with a space removes its newlines, so an
 * offset taken from stripped text names the wrong line.
 */
const unanchoredUses = (source: string): number[] => {
  const hits: number[] = [];
  source.split("\n").forEach((raw, index) => {
    const trimmed = raw.trimStart();
    // Prose, not code: a docblock's opener, its `*` continuations, and a line
    // comment. The helper's own docblock describes this shape at length.
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

    // A trailing line comment, ignoring `https://` and the `\/` that ends the
    // pattern itself.
    const trailing = /(?<![:\\])\/\//u.exec(raw);
    const code = trailing ? raw.slice(0, trailing.index) : raw;

    const at = code.indexOf(UNANCHORED_OPENER);
    if (at === -1) return;
    if (!code.slice(Math.max(0, at - ANCHOR.length), at).endsWith(ANCHOR)) hits.push(index + 1);
  });
  return hits;
};

describe("source-text — a glob is not a comment", () => {
  // A string literal holding a glob contains the two characters that open a
  // block comment. Read without an anchor, the pattern runs from there to the
  // next terminator in the file, which is normally an unrelated docblock below.
  const GLOB_ABOVE_DECLARATION = [
    'const IGNORE = ["**/*.ts"];',
    "",
    "export const inputSchema = {",
    "  kitId: z.string(),",
    "};",
    "",
    "/** A docblock, whose terminator would close the span the glob opened. */",
    "export const handler = async () => {};",
    "",
  ].join("\n");

  it("🔒 keeps code that follows a glob literal", () => {
    // The unanchored reading erases everything between the glob and the next
    // terminator, so the declaration disappears and the file drops out of
    // whatever the scan was enumerating — silently, and in the direction that
    // reports too little.
    const unanchored = GLOB_ABOVE_DECLARATION.replace(
      new RegExp(UNANCHORED_OPENER, "gu"),
      " ",
    ).replace(/(?:^|[^:])\/\/.*$/gmu, " ");

    expect(
      unanchored.includes("kitId: z."),
      "the fixture no longer demonstrates the hazard — an unanchored read is " +
        "supposed to lose this declaration, so this test would pass vacuously",
    ).toBe(false);

    expect(stripComments(GLOB_ABOVE_DECLARATION)).toContain("kitId: z.");
  });

  it("🔒 does not turn a glob into a comment", () => {
    // The same mistake in the other direction. `test/server-store-injection`
    // passes `writes: ["**/*"]`, and an unanchored extractor read the 1814
    // characters after it as one comment — live test code, handed to predicates
    // that decide what the prose in this package asserts.
    //
    // The docblock below is load-bearing: the unanchored span only invents a
    // comment when a terminator appears AFTER the glob. Without it this fixture
    // demonstrates nothing and both readings agree.
    const source = [
      'await call("plan", {',
      '  writes: ["**/*"],',
      "});",
      "",
      "/** Unrelated prose, whose terminator closes the span the glob opened. */",
      "",
    ].join("\n");

    const unanchored = [...source.matchAll(new RegExp(UNANCHORED_OPENER, "gu"))].map((m) => m[0]);

    // The phantom span opens at the `/` INSIDE the glob, so it starts after
    // `writes:` — assert on the live code it actually swallows, `});`.
    expect(
      unanchored.some((text) => text.includes("});")),
      "the fixture no longer demonstrates the hazard — an unanchored read is " +
        "supposed to swallow this call as prose, so this test would pass vacuously",
    ).toBe(true);

    // Second direction, and the one that matters more: swallowing the code also
    // consumes the real docblock's terminator, so the unanchored reader never
    // reports that docblock on its own. The bug hides prose as well as inventing it.
    expect(
      unanchored.some(
        (text) =>
          text.trim() ===
          "/** Unrelated prose, whose terminator closes the span the glob opened. */",
      ),
      "the fixture no longer demonstrates the hazard — an unanchored read is " +
        "supposed to lose this docblock as a standalone comment",
    ).toBe(false);

    expect(commentTexts(source)).toEqual([
      "Unrelated prose, whose terminator closes the span the glob opened.",
    ]);
  });

  it("🔒 still reads a real block comment and a wrapped line-comment run", () => {
    // Anti-vacuity for both directions: a reader that finds nothing anywhere
    // would satisfy the two tests above while measuring nothing.
    const source = [
      "/** A docblock. */",
      "const a = 1;",
      "// A sentence that",
      "// wraps across lines.",
      "const b = 2;",
      "",
    ].join("\n");

    expect(commentTexts(source)).toEqual(["A docblock.", "A sentence that wraps across lines."]);
    expect(stripComments(source)).not.toContain("docblock");
    expect(stripComments(source)).toContain("const a = 1;");
  });

  it("🔒 keeps a blank line between two comment runs from fusing them", () => {
    // Joining runs across blank lines lets two unrelated comments read as one
    // sentence, which can state a claim neither of them made.
    const source = ["// first claim", "", "// second claim", ""].join("\n");

    expect(commentTexts(source)).toEqual(["first claim", "second claim"]);
  });
});

describe("source-text — a line comment is recognised only at a line start", () => {
  it("🔒 a `//` inside a string literal is not a comment", () => {
    // The same mistake as the glob, in the other pair of characters. Reading
    // `//` wherever it appears finds one inside any literal that holds a
    // protocol-relative URL or a POSIX path — `isSafeRefUrl("file:///etc/passwd")`
    // is real code in `conjure.test.ts` — and then treats the rest of that line
    // as prose. As a stripper it deletes the assertion; as an extractor it
    // reports the literal as something the file says.
    const source = ['expect(isSafeRefUrl("file:///etc/passwd")).toBe(false);', ""].join("\n");

    const unanchored = /(?:^|[^:])(\/\/.*(?:\n[ \t]*\/\/.*)*)/gmu;

    expect(
      source.replace(new RegExp(unanchored.source, unanchored.flags), " ").includes("toBe(false)"),
      "the fixture no longer demonstrates the hazard — an unanchored read is " +
        "supposed to delete this assertion, so this test would pass vacuously",
    ).toBe(false);

    expect(stripComments(source)).toContain("toBe(false)");
    expect(commentTexts(source)).toEqual([]);
  });

  it("🔒 an inline comment does not consume the character before it", () => {
    // The `https://` guard was spelled as "any character that is not a colon",
    // and that character is part of the match. Replacing the match therefore
    // removes a character of live code along with the comment — a terminator,
    // a brace, or a comma, depending on the line.
    const source = ["const a = 1;// why", ""].join("\n");

    expect(stripComments(source)).toContain("const a = 1;");

    // And the documented cost of the anchor, asserted rather than assumed: the
    // trailing comment is not read at all. `hiddenContractProse` below is what
    // keeps that from becoming a place for a contract to hide.
    expect(commentTexts(source)).toEqual([]);
  });

  it("🔒 still reads a line-leading comment run, indented or not", () => {
    // Anti-vacuity: a reader that anchored so hard it found nothing would
    // satisfy both tests above while measuring nothing at all.
    const source = ["// top level", "", "  // indented, and", "  // wrapped", ""].join("\n");

    expect(commentTexts(source)).toEqual(["top level", "indented, and wrapped"]);
  });
});

describe("source-text — prose that the anchored reading cannot see", () => {
  /**
   * Vocabulary that makes a comment a claim some contract test in this package
   * reads, rather than an incidental annotation like `// ISO-8601`.
   */
  const CONTRACT_VOCABULARY =
    /isSafeKitId|kitId|list_kits|listKits|getKit|traversal|containment|identity|gate/u;

  /**
   * Lines carrying contract prose in a comment the anchored reading drops.
   *
   * Anchoring is an approximation, and this is the price: a comment written
   * after code on the same line is not read. That is the safe direction for the
   * stripper, which would otherwise delete code, but for the extractor it is a
   * place for a claim to hide — and silence is the failure mode these scans
   * exist to prevent. Flagging it converts the blind spot into a loud one.
   *
   * The `//` must sit outside any string literal opened on that line, so that
   * `"file:///etc/passwd"` is not reported as a hidden comment.
   */
  const hiddenContractProse = (source: string): number[] => {
    const hits: number[] = [];
    source.split("\n").forEach((line, index) => {
      const at = line.indexOf("//");
      if (at <= 0 || line.trimStart().startsWith("//")) return;

      const before = line.slice(0, at);
      const quoted = ['"', "'", "`"].some(
        (mark) => (before.split(mark).length - 1) % 2 === 1 || before.endsWith(":"),
      );
      if (quoted) return;
      if (CONTRACT_VOCABULARY.test(line.slice(at))) hits.push(index + 1);
    });
    return hits;
  };

  it("🔒 no contract prose in this package hides in a trailing comment", () => {
    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const relative of trackedFiles(SERVER_ROOT).filter((file) => file.endsWith(".ts"))) {
      // No `SELF` exclusion here, unlike the block-comment scan below. That one
      // must exempt itself because its own detector spells the banned pattern
      // out as a regex; this one bans a shape, not a literal, and the fixtures
      // in this file sit inside string literals that the quote guard skips. An
      // exclusion that changed nothing would misreport what is covered.
      scanned.push(relative);
      const lines = hiddenContractProse(readFileSync(path.join(SERVER_ROOT, relative), "utf-8"));
      for (const line of lines) offenders.push(`${relative}:${line}`);
    }

    expect(scanned, "the scan must cover the file that defines it").toContain(SELF);
    expect(
      offenders,
      "these state a contract in a comment written after code on the same " +
        "line, which the anchored reading in `test/helpers/source-text.ts` " +
        "does not see — move the comment onto its own line",
    ).toEqual([]);
  });

  it("🔒 that scan can tell a hidden claim from a visible one", () => {
    // Two-sided, and it has to clear the literal that motivated the anchor in
    // the first place, or the empty result above would just mean the detector
    // never fires.
    expect(hiddenContractProse("const x = 1; // the kitId gate runs first")).toEqual([1]);
    expect(hiddenContractProse("// the kitId gate runs first")).toEqual([]);
    expect(hiddenContractProse("  // the kitId gate runs first")).toEqual([]);
    expect(hiddenContractProse('expect(safe("file:///x")).toBe(false); // kitId')).toEqual([]);
    expect(hiddenContractProse("const a = 1; // unrelated note")).toEqual([]);
  });
});

describe("source-text — a block comment is recognised only at a line start", () => {
  it("🔒 no source in this package reads block comments without the anchor", () => {
    // Each contract test that scans source used to spell this separation
    // itself, and a copy is where the anchor gets dropped. What is enforced
    // here is the anchor, not the import: `helpers/tracked-files.test.ts`
    // spells its own line-anchored stripper and is deliberately left alone,
    // because the property that matters is the reading, not who owns it.
    //
    // Lines that are themselves comments are skipped, so prose describing the
    // shape — the helper's own docblock does, at length — is not an offence.
    // Self is excluded for the same reason the detector is assembled at
    // runtime.
    const offenders: string[] = [];
    for (const relative of trackedFiles(SERVER_ROOT).filter((file) => file.endsWith(".ts"))) {
      if (relative === SELF) continue;
      const lines = unanchoredUses(readFileSync(path.join(SERVER_ROOT, relative), "utf-8"));
      for (const line of lines) offenders.push(`${relative}:${line}`);
    }

    expect(
      offenders,
      "these read a block comment without anchoring it to a line start, so a " +
        "glob in a string literal opens a comment that runs to the next " +
        "terminator — import `stripComments`/`commentTexts` from " +
        "`test/helpers/source-text.ts` instead",
    ).toEqual([]);
  });

  it("🔒 that scan can tell the two spellings apart", () => {
    // Two-sided: the detector has to flag the unanchored spelling and clear the
    // anchored one, or the empty result above means nothing.
    const unanchored = `const code = source.replace(/${UNANCHORED_OPENER}/gu, "");`;
    const anchored = `const code = source.replace(/${ANCHOR}${UNANCHORED_OPENER}/gmu, " ");`;

    expect(unanchoredUses(unanchored)).toEqual([1]);
    expect(unanchoredUses(anchored)).toEqual([]);
    expect(unanchoredUses(`// ${unanchored}`)).toEqual([]);

    // Prose quoting the spelling is not an offence either. A docblock is the
    // one place the banned literal has to be writable — this helper's own
    // documentation names it — and without this the detector would push the
    // next author to weaken it rather than write the explanation.
    expect(
      unanchoredUses(["/**", ` * Never write ${UNANCHORED_OPENER} here.`, " */"].join("\n")),
    ).toEqual([]);
  });
});
