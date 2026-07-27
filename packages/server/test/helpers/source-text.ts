/**
 * Reading TypeScript source as text, without mistaking a glob for a comment.
 *
 * Several contract tests in this package answer questions by scanning source:
 * which verbs declare a `kitId`, which of them call the gate, what the comments
 * around a rule teach. Every one of them has to separate live code from prose,
 * and every one of them wrote that separation by hand.
 *
 * The natural way to write it is wrong. `/\*[\s\S]*?\*\/` finds a comment
 * opener inside any string literal holding a glob — `"**\/*"`, `"src/*.ts"`,
 * `"components/**\/*.tsx"` all contain the two characters that open a block
 * comment — and then runs to the NEXT `*\/` in the file, which is usually the
 * end of an unrelated docblock some way below. Everything in between is treated
 * as comment.
 *
 * Both directions of that mistake are live in this repository's history:
 *
 *   - As a STRIPPER it deletes code. A glob above a declaration, with any
 *     docblock below it, erases the declaration: the file silently drops out of
 *     whatever the scan was enumerating. An audit that reports "these verbs are
 *     ungated" then omits a verb because of a string literal three lines up.
 *   - As an EXTRACTOR it invents prose. `test/server-store-injection.test.ts`
 *     passes `writes: ["**\/*"]`, and an unanchored extractor turned the 1814
 *     characters after it into a single "comment" — live test code, handed to a
 *     predicate that decides whether the comments in this package assert
 *     something they should not.
 *
 * Anchoring the opener to the start of a line fixes both. A string literal is
 * never the first thing on its line in this codebase's formatting (Prettier puts
 * it after `const x = `, `writes: `, or an indent inside an array), while a real
 * block comment always is. The trade-off is explicit: a block comment written
 * mid-line — `foo(); /* note *\/` — is not recognised. That is the right way to
 * be wrong. Failing to strip a comment leaves prose in the "code" view, which
 * makes a scan report MORE than it should and fails loudly; failing to keep code
 * makes it report less, and silence is the failure mode these tests exist to
 * prevent.
 *
 * Line comments are matched as runs so a sentence wrapped across several `//`
 * lines stays one unit, and the `[^:]` guard keeps `https://` out.
 */

/**
 * A block comment, recognised only where one can legally begin: at the start of
 * a line, after nothing but indentation.
 */
const BLOCK_COMMENT = /^[ \t]*\/\*[\s\S]*?\*\//gmu;

/**
 * A run of consecutive `//` lines, captured as one comment.
 *
 * The run must be built from adjacent lines only. Allowing `\s*` between them
 * spans blank lines and fuses two unrelated comments into one "sentence" able to
 * state a claim neither of them made.
 */
const LINE_COMMENT_RUN = /(?:^|[^:])(\/\/.*(?:\n[ \t]*\/\/.*)*)/gmu;

/**
 * `source` with its comments replaced by whitespace — the live-code view.
 *
 * Use this for any question of the form "does this file DO x", so that a file
 * explaining why it does not do x is not counted as doing it. That is not
 * hypothetical: `validate.ts` says it "deliberately applies no isSafeKitId
 * gate", which on a raw-text scan marks it gated and empties the audit.
 */
export const stripComments = (source: string): string =>
  source.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT_RUN, " ");

/**
 * Every comment in `source`, in the order they appear — the prose view.
 *
 * Returned with comment markers and wrapping removed, so a phrase broken across
 * lines is still one phrase. Use this for any question of the form "does this
 * file SAY x".
 */
export const commentTexts = (source: string): string[] => {
  const raw = [...source.matchAll(BLOCK_COMMENT), ...source.matchAll(LINE_COMMENT_RUN)].map(
    (match) => match[0],
  );

  return raw
    .map((comment) =>
      comment
        .replace(/\/\*+|\*+\/|^\s*\*|^\s*\/\//gmu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((text) => text.length > 0);
};
