import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { ts } from "ts-morph";

import { commentTexts, stripComments, unwrapped } from "./source-text.js";
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

/**
 * The line-comment opener as it is spelled inside a regex literal, assembled at
 * runtime for the same reason as `UNANCHORED_OPENER`: this file is inside the
 * corpus it scans.
 */
const LINE_OPENER = ["\\", "/", "\\", "/"].join("");

/**
 * Occurrences of the line-comment opener that are not anchored to a line start,
 * reported as 1-based line numbers.
 *
 * Safety is decided by what precedes the opener inside the regex. Grouping
 * punctuation and horizontal-whitespace classes are transparent — a marker strip
 * legitimately reaches the opener through `^\s*(?:` — so those are peeled away
 * before asking whether what remains ends at a line boundary, either `^` or an
 * explicit newline.
 */
const unanchoredLineUses = (source: string): number[] => {
  const hits: number[] = [];
  const TRANSPARENT = /(?:\((?:\?:)?|\||\[[^\]]*\]\*|\\s\*|\s)+$/u;

  source.split("\n").forEach((raw, index) => {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

    let from = 0;
    for (;;) {
      const at = raw.indexOf(LINE_OPENER, from);
      if (at === -1) return;
      from = at + LINE_OPENER.length;

      let before = raw.slice(0, at);
      for (;;) {
        const peeled = before.replace(TRANSPARENT, "");
        if (peeled === before) break;
        before = peeled;
      }
      if (before.endsWith("^") || before.endsWith("\\n")) continue;
      // A literal colon in front of the opener is a URL scheme, not a comment:
      // `/^https:\\/\\/host\\//u` matches an address. No scan looking for comments
      // writes a colon there — the colon-workaround arm ends in `)` — so this
      // separates the two uses without weakening the check.
      if (before.endsWith(":")) continue;
      hits.push(index + 1);
      return;
    }
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

  it("🔒 returns the two comment kinds interleaved in source order", () => {
    // Reading each kind with its own pass and concatenating the results groups
    // the output by kind, not by position, so a line comment written before a
    // docblock is reported after it. Callers join this array to ask whether a
    // file SAYS something, and joining a mis-ordered array puts two comments
    // side by side that are not adjacent in the source — the same way a run
    // spanning a blank line does. Both invent a sentence nobody wrote.
    const source = [
      "// line one",
      "/** block one. */",
      "// line two",
      "/** block two. */",
      "",
    ].join("\n");

    expect(commentTexts(source)).toEqual(["line one", "block one.", "line two", "block two."]);
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
   * Which means this detector's own blind spots are the thing to design
   * against. Finding the comment by hand cannot be done a line at a time: `//`
   * is two ordinary characters, legal inside a string, a template, or a regex,
   * and a line may hold both a literal containing them AND a real comment after
   * it. Reading as far as the first `//` therefore answers the wrong question —
   * `"file:///x"` decides the line, and a claim written past it is never
   * examined. Guarding that with quote-parity only moves the miss: parity is a
   * property of the whole line, so it cannot say which side of the line a given
   * `//` fell on.
   *
   * So the comments are taken from the parser rather than guessed at. Every
   * `//` the language considers a comment is one, and every `//` it considers
   * part of a literal is not, with no case analysis here to get wrong. The
   * parser is already a first-class dependency of this package (`ts-morph`
   * re-exports it, and `src/framework/*` compiles with it), so this costs no new
   * dependency and roughly 2ms per file.
   *
   * Scope is single-line comments, deliberately. A block comment opened after
   * code is a different shape with a different failure mode, and it has its own
   * lock in the sibling `describe` below.
   */
  const hiddenContractProse = (source: string): number[] => {
    const parsed = ts.createSourceFile(
      "scan.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const comments = new Map<number, ts.CommentRange>();
    const record = (ranges: readonly ts.CommentRange[] | undefined): void => {
      for (const range of ranges ?? [])
        if (!comments.has(range.pos)) comments.set(range.pos, range);
    };
    const walk = (node: ts.Node): void => {
      record(ts.getLeadingCommentRanges(source, node.getFullStart()));
      record(ts.getTrailingCommentRanges(source, node.getEnd()));
      for (const child of node.getChildren(parsed)) walk(child);
    };
    walk(parsed);

    const hits = new Set<number>();
    for (const range of comments.values()) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const { line, character } = parsed.getLineAndCharacterOfPosition(range.pos);
      // Code before it on the line is what makes the comment hidden; a comment
      // that starts the line is read by the anchored reading already.
      if (source.slice(range.pos - character, range.pos).trim() === "") continue;
      if (CONTRACT_VOCABULARY.test(source.slice(range.pos, range.end))) hits.add(line + 1);
    }
    return [...hits].sort((a, b) => a - b);
  };

  it("🔒 no contract prose in this package hides in a trailing comment", () => {
    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const relative of trackedFiles(SERVER_ROOT).filter((file) => file.endsWith(".ts"))) {
      // No `SELF` exclusion here, unlike the block-comment scan below. That one
      // must exempt itself because its own detector spells the banned pattern
      // out as a regex; this one bans a shape, not a literal, and the fixtures
      // in this file are string and template literals, which the parser reads
      // as literals rather than comments. An exclusion that changed nothing
      // would misreport what is covered.
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
    // Two-sided, or the empty result above would just mean the detector never
    // fires.
    expect(hiddenContractProse("const x = 1; // the kitId gate runs first")).toEqual([1]);
    expect(hiddenContractProse("// the kitId gate runs first")).toEqual([]);
    expect(hiddenContractProse("  // the kitId gate runs first")).toEqual([]);
    expect(hiddenContractProse("const a = 1; // unrelated note")).toEqual([]);
  });

  it("🔒 a `//` inside a literal neither raises nor silences the scan", () => {
    // The detector has to clear the literal that motivated the anchor in the
    // first place — `"file:///x"` is not a comment — WITHOUT letting that
    // literal become the hiding place. Those are two separate claims about the
    // same line, and reading only as far as the FIRST `//` conflates them: the
    // slashes inside the URL answer "is there a comment here?" for the whole
    // line, so a real trailing comment after it is never examined at all.
    //
    // That is a silent miss in a repository-wide lock, which is the one failure
    // mode these scans exist to prevent, so each literal is asserted twice:
    // once alone (must stay quiet) and once followed by contract prose (must
    // fire). A reading that cannot separate them fails one half whichever way
    // it errs.
    for (const code of [
      'expect(safe("file:///x")).toBe(false);',
      "const url = `https://host/${id}/contents`;",
      "const re = /a\\/\\/b/;",
    ]) {
      expect(hiddenContractProse(code), `${code} — no comment, must stay quiet`).toEqual([]);
      expect(
        hiddenContractProse(`${code} // the kitId gate runs first`),
        `${code} — trailing claim, must be seen`,
      ).toEqual([1]);
    }
  });
});

describe("source-text — a block comment is recognised only at a line start", () => {
  it("🔒 no source in this package reads block comments without the anchor", () => {
    // Each contract test that scans source used to spell this separation
    // itself, and a copy is where the anchor gets dropped. What is enforced
    // here is the anchor, not the import — a caller may still spell its own
    // reading, provided it anchors. In practice every caller now delegates:
    // three that spelled their own kept the block anchor but dropped the line
    // one, which is the defect the sibling scan below was added for.
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
describe("source-text — a line comment is recognised only at a line start", () => {
  it("🔒 no source in this package reads line comments without the anchor", () => {
    // The sibling scan above covers the block opener. This one covers the line
    // opener, which has its own near-miss spelling: a scan that wants to spare
    // `https://` writes a "any character but a colon" arm in front of the two
    // slashes. That arm reads `file:///x` as a comment — the colon is spent on
    // the URL scheme, the first slash satisfies "not a colon", and the next two
    // open a comment that runs to the end of the line, taking any code sharing
    // that line with it.
    //
    // Self is excluded because this file has to spell both readings to compare
    // them.
    const offenders: string[] = [];
    for (const relative of trackedFiles(SERVER_ROOT).filter((file) => file.endsWith(".ts"))) {
      if (relative === SELF) continue;
      const lines = unanchoredLineUses(readFileSync(path.join(SERVER_ROOT, relative), "utf-8"));
      for (const line of lines) offenders.push(`${relative}:${line}`);
    }

    expect(
      offenders,
      "these match a line comment without anchoring it to a line start, so a " +
        "`file:///` literal opens a comment that swallows the rest of the line " +
        "— import `stripComments`/`commentTexts` from " +
        "`test/helpers/source-text.ts` instead",
    ).toEqual([]);
  });

  it("🔒 that scan tells the colon workaround from a real anchor", () => {
    // Two-sided, and specifically over the near-miss: the "not a colon" arm has
    // to be flagged and the line anchor cleared, or the empty result above is
    // just an assertion that nothing in the package matches a line comment.
    const colonArm = `const code = raw.replace(/(?:^|[^:])${LINE_OPENER}.*$/gmu, " ");`;
    const anchored = `const code = raw.replace(/${ANCHOR}${LINE_OPENER}.*$/gmu, " ");`;
    const newlineAnchored = `const runs = raw.matchAll(/(?:\\n[ \\t]*${LINE_OPENER}.*)*/gmu);`;

    expect(unanchoredLineUses(colonArm)).toEqual([1]);
    expect(unanchoredLineUses(anchored)).toEqual([]);
    expect(unanchoredLineUses(newlineAnchored)).toEqual([]);

    // A marker strip that runs from the line start is the third safe spelling,
    // and it reaches the opener through a group rather than directly.
    expect(unanchoredLineUses(`raw.replace(/^\\s*(?:${LINE_OPENER}+|\\*+)\\s?/u, "")`)).toEqual([]);

    // A URL regex is cleared, and it has to be: matching an address is not
    // reading a comment, and flagging it would push the next author to stop
    // anchoring URLs rather than to anchor comments.
    expect(
      unanchoredLineUses(
        `expect(url).toMatch(/^https:${LINE_OPENER}host\\.example${LINE_OPENER[0]}${LINE_OPENER[1]}/u);`,
      ),
    ).toEqual([]);

    // Prose naming the spelling is not an offence, on the same grounds as the
    // block scan: the explanation has to be writable somewhere.
    expect(unanchoredLineUses(`// never write (?:^|[^:])${LINE_OPENER} here`)).toEqual([]);
  });
});
describe("source-text — comment order is positional across the whole package", () => {
  /**
   * Every position in `source` where `text` could have started.
   *
   * Extraction collapses wrapping, so a whole comment cannot be searched for
   * verbatim; its opening words survive intact. Those words are not unique —
   * two comments can open the same way, and a comment can quote a phrase that
   * appears earlier — so every occurrence is a candidate, and choosing among
   * them is left to the ordering check below.
   */
  const candidates = (source: string, text: string): number[] => {
    const opener = text.split(" ").slice(0, 4).join(" ");
    const found: number[] = [];

    for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
      found.push(at);
    }

    return found;
  };

  /**
   * Whether `texts` can be laid out in `source` in the order they were given.
   *
   * Asking whether *some* consistent layout exists — rather than pinning each
   * comment to its first textual match — is what keeps a repeated opening
   * phrase from reading as a violation. It is a property of the output, so it
   * holds whatever `commentTexts` does internally.
   *
   * The comments are taken as an argument rather than read from `source` so
   * that the rejecting branch can be exercised directly. Deriving them here
   * would make it unreachable the moment the extractor is correct, and a
   * branch that cannot be reached is a branch that can be deleted without any
   * test noticing.
   */
  const isPositional = (source: string, texts: string[]): boolean => {
    let previous = -1;

    for (const text of texts) {
      const at = candidates(source, text);

      // An opener that cannot be found anywhere tells us nothing about order —
      // markers inside it may have been rewritten by extraction.
      if (at.length === 0) continue;

      const forward = at.filter((position) => position >= previous);
      if (forward.length === 0) return false;

      previous = forward[0]!;
    }

    return true;
  };

  it("🔒 no tracked file reports its comments out of source order", () => {
    const misordered = trackedFiles(SERVER_ROOT)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => {
        const source = readFileSync(path.join(SERVER_ROOT, file), "utf8");
        return !isPositional(source, commentTexts(source));
      });

    expect(misordered).toEqual([]);
  });

  it("🔒 the scan can actually see a violation", () => {
    // Guards the assertion above against passing because it looked at nothing.
    // A line comment before a docblock is the shape that grouping-by-kind gets
    // wrong: the check must accept the source order and reject the grouped
    // reading, which reports the docblock first.
    const source = ["// written first", "/** written second. */", ""].join("\n");

    const inOrder = commentTexts(source);

    expect(inOrder).toEqual(["written first", "written second."]);
    expect(isPositional(source, inOrder)).toBe(true);
    expect(isPositional(source, ["written second.", "written first"])).toBe(false);
  });
});

describe("source-text — a CRLF checkout reads the same as an LF one", () => {
  /** The same source as a Windows checkout would deliver it. */
  const asCrlf = (source: string): string => source.replace(/\r?\n/gu, "\r\n");

  it("🔒 reads the same comments on either checkout", () => {
    // `.` excludes `\r`, so a run continuation spelled `\n` alone cannot follow
    // one line to the next once the file ends its lines `\r\n`. Every wrapped
    // `//` block then reads as several separate comments, and a prose lock
    // searching for a phrase that spans the wrap finds nothing — silently, and
    // only on Windows.
    const split = trackedFiles(SERVER_ROOT)
      .filter((file) => file.endsWith(".ts"))
      .filter((relative) => {
        const source = readFileSync(path.join(SERVER_ROOT, relative), "utf8");
        return (
          JSON.stringify(commentTexts(source)) !== JSON.stringify(commentTexts(asCrlf(source)))
        );
      });

    expect(split).toEqual([]);
  });

  it("🔒 that parity scan can see a run CRLF would split", () => {
    const wrapped = "// a claim spanning\n// two comment lines\n";

    expect(commentTexts(wrapped)).toEqual(["a claim spanning two comment lines"]);
    expect(commentTexts(asCrlf(wrapped))).toEqual(commentTexts(wrapped));

    // Non-vacuity: the corpus really does contain multi-line runs, so the scan
    // above is exercising the behaviour it claims to protect.
    const withRuns = trackedFiles(SERVER_ROOT).filter((relative) =>
      /^[ \t]*\/\/.*\n[ \t]*\/\//mu.test(readFileSync(path.join(SERVER_ROOT, relative), "utf8")),
    );
    expect(withRuns.length).toBeGreaterThan(10);
  });

  it("🔒 collapses a wrapped docblock claim on either checkout", () => {
    const doc = " * shared by every\n * kit-taking tool\n";

    expect(unwrapped(doc)).toContain("every kit-taking tool");
    expect(unwrapped(asCrlf(doc))).toContain("every kit-taking tool");
  });

  it("🔒 no tracked source hand-rolls the docblock unwrap", () => {
    // Assembled, not written literally, so this file does not trip its own scan.
    const HAND_ROLLED = new RegExp(["\\\\n", "\\\\s\\*", "\\\\\\*\\?"].join(""), "u");

    // The helper module is where the idiom is supposed to live; every other
    // file must delegate to it. Asserting that it still spells the shape keeps
    // the exclusion honest — an exclusion nobody checks is how a scan quietly
    // stops covering anything.
    const AUTHORITY = "test/helpers/source-text.ts";
    expect(HAND_ROLLED.test(readFileSync(path.join(SERVER_ROOT, AUTHORITY), "utf8"))).toBe(true);

    const offenders = trackedFiles(SERVER_ROOT)
      .filter((file) => file.endsWith(".ts") && file !== SELF && file !== AUTHORITY)
      .filter((relative) =>
        HAND_ROLLED.test(readFileSync(path.join(SERVER_ROOT, relative), "utf8")),
      );

    expect(offenders).toEqual([]);
  });

  it("🔒 that scan tells a hand-rolled unwrap from the shared helper", () => {
    const HAND_ROLLED = new RegExp(["\\\\n", "\\\\s\\*", "\\\\\\*\\?"].join(""), "u");

    expect(HAND_ROLLED.test(String.raw`text.replace(/\n\s*\*?\s*/gu, " ")`)).toBe(true);
    expect(HAND_ROLLED.test(`text = unwrapped(raw)`)).toBe(false);
  });
});

describe("source-text — a docblock documents the declaration below it", () => {
  /**
   * Docblocks that document nothing, reported as 1-based line numbers.
   *
   * TypeScript attaches only the NEAREST leading docblock to a declaration, so
   * when two are stacked the upper one is silently orphaned. Nothing complains:
   * it is a legal comment, it renders in the file, and it reads — to a human
   * skimming — exactly like documentation. Only the tooling disagrees, and it
   * disagrees quietly. The block stops appearing on hover, stops being pulled
   * into generated docs, and drifts from the declaration it was written for
   * while still sitting a few lines above it.
   *
   * That is a documentation defect this package is unusually exposed to, because
   * several of its contracts are asserted ONLY in prose — the `isSafeKitId`
   * docblock is the rule, not a gloss on it. A stranded block is therefore a
   * contract statement that has quietly detached from the thing it constrains.
   *
   * The detector is the parser's own view rather than a text heuristic: for
   * every node, the leading comment ranges at its full start, keeping the
   * docblocks and reporting all but the last. Two things it must get right:
   *
   *   - Ranges are reported per NODE, and a parent and its first child share a
   *     full start, so the same comment arrives several times. Deduping by
   *     comment position rather than by node is what keeps the count honest.
   *   - A file-level banner is NOT an orphan. A file-overview docblock at
   *     position 0, followed by the first declaration's own docblock, is the
   *     ordinary and correct shape — eight files in this package are written
   *     that way — so position 0 is excluded. Running the scan WITHOUT that
   *     exclusion first is how that was established, rather than assumed.
   */
  const orphanedDocblocks = (source: string): number[] => {
    const parsed = ts.createSourceFile(
      "scan.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const hits = new Set<number>();
    const seenStarts = new Set<number>();
    const walk = (node: ts.Node): void => {
      const start = node.getFullStart();
      if (!seenStarts.has(start)) {
        seenStarts.add(start);
        const docs = (ts.getLeadingCommentRanges(source, start) ?? []).filter(
          (range) => source.slice(range.pos, range.pos + 3) === "/**" && range.pos !== 0,
        );
        for (const range of docs.slice(0, -1))
          hits.add(parsed.getLineAndCharacterOfPosition(range.pos).line + 1);
      }
      for (const child of node.getChildren(parsed)) walk(child);
    };
    walk(parsed);

    return [...hits].sort((a, b) => a - b);
  };

  it("🔒 no docblock in this package is stranded above another docblock", () => {
    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const relative of trackedFiles(SERVER_ROOT).filter((file) => file.endsWith(".ts"))) {
      scanned.push(relative);
      const source = readFileSync(path.join(SERVER_ROOT, relative), "utf-8");
      for (const line of orphanedDocblocks(source)) offenders.push(`${relative}:${line}`);
    }

    expect(scanned, "the scan must cover the file that defines it").toContain(SELF);
    expect(
      offenders,
      "these docblocks are followed by another docblock, so TypeScript attaches " +
        "the lower one and this one documents nothing — move the declaration it " +
        "describes up to sit directly beneath it",
    ).toEqual([]);
  });

  it("🔒 that scan can tell a stranded docblock from a stacked-but-attached one", () => {
    // Two-sided, or the empty result above would just mean the detector never
    // fires. Assembled rather than written literally, so this file does not
    // itself contain the shape it forbids.
    const doc = (text: string): string => ["/**", ` * ${text}`, " */"].join("\n");
    // Every fixture opens with a declaration, so the stacked pair under test is
    // mid-file — the shape the real defect has. Without it the pair would start
    // at position 0 and be excluded as a file banner, and this test would pass
    // by measuring the exclusion instead of the rule.
    const head = "export const head = 0;";

    expect(
      orphanedDocblocks([head, doc("stranded"), doc("attached"), "export const a = 1;"].join("\n")),
      "the upper block of a stacked pair documents nothing",
    ).toEqual([2]);
    expect(
      orphanedDocblocks([head, doc("attached"), "export const a = 1;"].join("\n")),
      "one block, one declaration",
    ).toEqual([]);
    expect(
      orphanedDocblocks(
        [head, doc("first"), "export const a = 1;", doc("second"), "export const b = 2;"].join(
          "\n",
        ),
      ),
      "separated by a declaration, so neither is stranded",
    ).toEqual([]);
    expect(
      orphanedDocblocks([doc("file banner"), doc("attached"), "export const a = 1;"].join("\n")),
      "a banner at position 0 is the ordinary shape, not an orphan",
    ).toEqual([]);
    expect(
      orphanedDocblocks(
        [head, "// a line comment", doc("attached"), "export const a = 1;"].join("\n"),
      ),
      "only docblocks count; a line comment above one strands nothing",
    ).toEqual([]);
  });
});
