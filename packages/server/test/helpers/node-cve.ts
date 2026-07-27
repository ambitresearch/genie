/**
 * Shared authority for "does a declared Node range still admit a runtime that is
 * vulnerable to CVE-2025-27210?".
 *
 * CVE-2025-27210 is a Windows-only `path.join` / `path.normalize` traversal via
 * reserved device names (`CON`, `PRN`, `AUX`); it is the incomplete-fix follow-up
 * to CVE-2025-23084. It was patched in **20.19.4, 22.17.1 and 24.4.1** — three
 * separate release lines, each with its own patch point.
 *
 * That per-line structure is the whole reason this helper exists. A range's LOWER
 * ENDPOINT says nothing about the lines above it: `>=22.19.0` reads as "patched"
 * but is satisfied by `24.2.0`, which is not. Nor is it enough to filter a list of
 * sampled releases — `=22.16.0 || >=22.19.0 <23 || >=24.4.1` misses every sample
 * while admitting an unpatched 22.16.0. The check is therefore an **interval**
 * one: the vulnerable space is modelled as half-open ranges, and the declared
 * range is swept at every release where either predicate can change value.
 *
 * Kept in one module on purpose: this PR exists because a single rule was restated
 * at eight call sites and drifted. A security predicate duplicated across two test
 * files would be the same defect, so both published manifests and the mcpb bundle
 * assert through this one function.
 */

/** The release lines that fixed CVE-2025-27210, for error messages. */
export const CVE_2025_27210_FIXED_IN = ["20.19.4", "22.17.1", "24.4.1"] as const;

/**
 * Concrete releases that are **vulnerable** to CVE-2025-27210, used to pin the
 * interval model below and to make failure messages name a real release.
 *
 * Deliberately straddles every patch point (`20.19.3`, `22.17.0`, `24.4.0`) so an
 * off-by-one in either the intervals or the evaluator is caught, and includes
 * the odd-numbered lines (21.x, 23.x) which reached end-of-life without ever
 * receiving the fix.
 *
 * This is a *sample*, not the decision procedure — see `isVulnerableVersion`.
 */
export const CVE_2025_27210_VULNERABLE = [
  "18.20.8",
  "20.0.0",
  "20.19.3",
  "21.7.3",
  "22.0.0",
  "22.17.0",
  "23.11.1",
  "24.0.0",
  "24.4.0",
] as const;

/**
 * Patched releases this workspace actually runs on. Asserting these DO satisfy the
 * range keeps the security check non-vacuous: `>=999.0.0` would exclude every
 * vulnerable release while declaring a supported set no consumer can be on.
 * (Not "uninstallable": this repository sets no `engine-strict`, so npm warns and
 * installs regardless — see `renderNodeRequirement` below.)
 *
 * `22.19.0` is the `.nvmrc` pin; `24.4.1` is the first patched 24.x, which the CI
 * matrix reaches via a bare `node: 24`.
 */
export const CVE_2025_27210_SUPPORTED = ["22.19.0", "22.22.3", "24.4.1", "24.99.0"] as const;

type Version = [number, number, number];

function parseVersion(value: string): Version {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(value.trim());
  if (!m) throw new Error(`unparseable version: ${JSON.stringify(value)}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    // `Version` is a 3-tuple, but `noUncheckedIndexedAccess` widens a numeric
    // index to `| undefined`; the coalesce is a type narrowing, not a default.
    const [left, right] = [a[i] ?? 0, b[i] ?? 0];
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver-range evaluator covering the grammar these manifests use:
 * space-separated comparators ANDed together, `||` between alternatives, e.g.
 * `>=22.19.0 <23 || >=24.4.1`. Partial versions widen downward (`<23` is
 * `<23.0.0`), which is the standard reading for a bound of that shape.
 *
 * Hand-rolled because `semver` is not a dependency of this workspace; pinned by
 * `node-cve.test.ts` so a bug here cannot silently weaken the locks that use it.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  return (
    range
      .split("||")
      .map((clause) => clause.trim())
      // NO `.filter(Boolean)` here: in npm's resolver an EMPTY comparator set is
      // the wildcard `*`, not an absent clause. `semver.validRange("")` is `"*"`,
      // and `validRange(">=22.19.0 <23 || >=24.4.1 ||")` is `"*"` too — one stray
      // `||` erases the whole range rather than narrowing it. Dropping empty
      // clauses would score such a range on its surviving arms and certify a
      // published `engines.node` that in fact admits every vulnerable release.
      // An empty clause falls through to `.every()` over zero comparators, which
      // is vacuously true — exactly the wildcard behaviour, with no special case.
      .some((clause) =>
        clause
          .split(/\s+/u)
          .filter((token) => token.length > 0)
          .every((token) => {
            const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/u.exec(token);
            if (!m?.[2]) throw new Error(`unparseable comparator: ${JSON.stringify(token)}`);
            const cmp = compare(v, parseVersion(m[2]));
            switch (m[1] ?? "=") {
              case ">=":
                return cmp >= 0;
              case ">":
                return cmp > 0;
              case "<=":
                return cmp <= 0;
              case "<":
                return cmp < 0;
              default:
                return cmp === 0;
            }
          }),
      )
  );
}

/**
 * The vulnerable release space as half-open `[lo, hi)` intervals — the actual
 * decision procedure, replacing a filter over sampled points.
 *
 * Sampling can only ever prove "none of the releases I happened to list is
 * admitted"; it cannot prove "no vulnerable release is admitted". A range like
 * `=22.16.0 || >=22.19.0 <23 || >=24.4.1` slips through a sample check while
 * admitting an unpatched 22.16.0.
 *
 * The three intervals are contiguous runs of unpatched releases, so the gaps
 * between them are exactly the patched windows: `[20.19.4, 21.0.0)` and
 * `[22.17.1, 23.0.0)` and `[24.4.1, ∞)`.
 */
const VULNERABLE_INTERVALS: readonly { readonly lo: Version; readonly hi: Version | null }[] = [
  // Every line at or below 20.x, up to that line's own fix.
  { lo: [0, 0, 0], hi: [20, 19, 4] },
  // 21.x died unpatched and runs straight into 22.x's pre-fix window.
  { lo: [21, 0, 0], hi: [22, 17, 1] },
  // Likewise 23.x, running into 24.x's pre-fix window.
  { lo: [23, 0, 0], hi: [24, 4, 1] },
];

/** Whether a concrete release predates the fix on its own line. */
export function isVulnerableVersion(version: string): boolean {
  const v = parseVersion(version);
  return VULNERABLE_INTERVALS.some(
    ({ lo, hi }) => compare(v, lo) >= 0 && (hi === null || compare(v, hi) < 0),
  );
}

const format = (v: Version): string => v.join(".");

/**
 * Every release at which `satisfiesRange(_, range)` or `isVulnerableVersion` can
 * change value, plus the release immediately above each.
 *
 * Both predicates are step functions, and every step lands on a version literal
 * written in the range or on an interval endpoint above. Testing each breakpoint
 * and its immediate successor therefore visits at least one release from **every**
 * span on which both predicates are constant — which makes the check complete for
 * this comparator grammar, not merely representative.
 */
function criticalVersions(range: string): string[] {
  const breakpoints: Version[] = [[0, 0, 0]];
  for (const { lo, hi } of VULNERABLE_INTERVALS) {
    breakpoints.push(lo);
    if (hi !== null) breakpoints.push(hi);
  }
  for (const literal of range.matchAll(/\d+(?:\.\d+){0,2}/gu)) {
    breakpoints.push(parseVersion(literal[0]));
  }

  const seen = new Set<string>();
  for (const b of breakpoints) {
    seen.add(format(b));
    seen.add(format([b[0], b[1], b[2] + 1]));
  }
  return [...seen].sort((a, b) => compare(parseVersion(a), parseVersion(b)));
}

/**
 * Assert a declared Node range excludes every release vulnerable to
 * CVE-2025-27210 while still admitting the runtimes this workspace ships on.
 *
 * Throws a message naming the offending releases so a failure points straight at
 * the release line that was missed, rather than at the floor.
 */
export function assertRangePatchesCve202527210(range: string, label: string): void {
  // Sampled releases first so the message leads with a real, recognisable
  // release; the critical-point sweep is what makes the check complete.
  const admitted = [
    ...new Set(
      [...CVE_2025_27210_VULNERABLE, ...criticalVersions(range)].filter(
        (v) => isVulnerableVersion(v) && satisfiesRange(v, range),
      ),
    ),
  ];
  if (admitted.length > 0) {
    const shown = admitted.slice(0, 5).join(", ");
    throw new Error(
      `${label}: engine range ${JSON.stringify(range)} still admits Node ` +
        `${shown}${admitted.length > 5 ? ", …" : ""}, which predate the ` +
        `CVE-2025-27210 fixes (${CVE_2025_27210_FIXED_IN.join(" / ")}). Every ` +
        `release line has its own patch point, so no alternative in the range ` +
        `may reach below its line's fix.`,
    );
  }
  const missing = CVE_2025_27210_SUPPORTED.filter((v) => !satisfiesRange(v, range));
  if (missing.length > 0) {
    throw new Error(
      `${label}: engine range ${JSON.stringify(range)} excludes patched Node ` +
        `${missing.join(", ")}, which this workspace builds and tests on.`,
    );
  }
}

/**
 * Render a declared `engines.node` range as the prose the public docs must use.
 *
 * The prerequisite statements in the public entry points are the only thing
 * standing between a reader and a runtime the packages were never tested on.
 * Which files those are is decided by the derived scan in
 * `docs-node-requirement.test.ts` and is deliberately NOT restated here: the
 * hand-written copy of that list is what went stale last time, omitting the root
 * `CONTRIBUTING.md`. `engines.node` does not stand
 * there too: this repository sets no `engine-strict`, so npm treats the field as
 * advisory and carries on after an `EBADENGINE` warning that never mentions the
 * CVE. So a doc saying "Node 22.19 or newer" while the manifest says
 * `>=22.19.0 <23 || >=24.4.1` is not a cosmetic mismatch — it tells a user on
 * Node 23 or 24.2 that a command is supported, and nothing downstream corrects
 * them.
 *
 * That mismatch is exactly what happened when the CVE-2025-27210 floors landed:
 * every prose claim then in the tree kept describing the pre-narrowing range.
 * The tally is left to the scan for the same reason as the file list.
 * Rather than fix four strings and hope, the docs are checked against this
 * rendering, so the range and its documentation cannot diverge again.
 *
 * Deliberately **partial**: it renders only the clause shapes actually used here
 * and throws on anything else. A range this cannot express should fail loudly
 * during the next change rather than quietly emit prose that is wrong — the
 * silent-wrong-answer mode is the one being designed out.
 */
export function renderNodeRequirement(range: string): string {
  const clauses = range.split("||").map((clause) => clause.trim());

  const parts = clauses.map((clause) => {
    // `>=A <B` — a bounded line, rendered as "A through the end of major B-1".
    const bounded = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/u.exec(clause);
    if (bounded) {
      const [, major, minor, patch, upper] = bounded;
      const lastMajor = Number(upper) - 1;
      if (String(lastMajor) !== major) {
        throw new Error(
          `renderNodeRequirement: clause "${clause}" spans more than one major line; ` +
            `no prose form is defined for that.`,
        );
      }
      return `${major}.${minor}.${patch}–${major}.x`;
    }

    // `>=A` — an open-ended line.
    const open = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(clause);
    if (open) {
      return `${open[1]}.${open[2]}.${open[3]} or newer`;
    }

    throw new Error(
      `renderNodeRequirement: unsupported clause "${clause}". Extend this renderer ` +
        `(and the docs it drives) rather than loosening the assertion.`,
    );
  });

  return `Node.js ${parts.join(", or ")}`;
}

/**
 * Markdown's soft line breaks, rejoined — the unit a claim is actually written in.
 *
 * Prose here is hard-wrapped by hand. `docs/user/installation.md` already spans
 * its prerequisite across two physical lines, and the subject and the version
 * share a line only by luck: one inserted word before `Node.js 22.19.0` would
 * push the version onto the next line, and a PHYSICAL-line reader would stop
 * seeing that doc entirely. The floor sweep would go blind at the same moment,
 * so nothing else in this suite would notice.
 *
 * Joining is limited to LAZY CONTINUATION — a line that merely continues the
 * paragraph above it. A line that opens a new block does not continue anything,
 * and welding it to the previous one would attribute one block's subject to
 * another block's version. That is not hypothetical: consecutive rows of the
 * `actions/setup-node` pin table are adjacent non-blank lines, and joining them
 * would hand a Node-named row the next row's version number. Blank lines,
 * headings, fences, quotes, list markers and table rows therefore all break the
 * join, which is exactly CommonMark's own paragraph rule.
 *
 * Breaking the join is only half of the rule: a line also has to say whether it
 * leaves a paragraph OPEN behind it, because that is what decides the NEXT line.
 * A heading, a table row and a fence delimiter close one — the prose after
 * `## Node` is a new paragraph rather than more of the heading — so the line
 * after any of them continues nothing and must not be welded onto it. A list
 * item and a block quote do leave one open, since each contains a paragraph that
 * CommonMark allows a following unmarked line to continue lazily.
 */
function logicalLines(text: string): string[] {
  // `>` opens a blockquote, but `>=` opens a version comparator — a wrapped
  // `Requires Node\n>=22.19.0` must keep joining, so the quote marker excludes it.
  const OPENS_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>(?!=)|\||```|~~~)/u;
  // Opening a block and leaving one open are different questions, and it is the
  // second one that governs the NEXT line. An ATX heading, a table row and a
  // fence delimiter are single-line leaf blocks, so whatever follows one starts
  // fresh. A list item or a block quote CONTAINS a paragraph, and CommonMark
  // lets a following unmarked line lazily continue that paragraph, so those two
  // leave it open.
  const CLOSES_PARAGRAPH = /^\s*(?:#{1,6}\s|\||```|~~~)/u;
  const joined: string[] = [];
  let fenced = false;
  let open = false;

  for (const raw of text.split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(raw)) fenced = !fenced;
    const previous = joined.at(-1);
    const blank = raw.trim() === "";
    const continues = open && previous !== undefined && !fenced && !blank && !OPENS_BLOCK.test(raw);
    if (continues) joined[joined.length - 1] = `${previous} ${raw.trim()}`;
    else {
      joined.push(raw);
      open = !fenced && !blank && !CLOSES_PARAGRAPH.test(raw);
    }
  }

  return joined;
}

/**
 * A line's clauses, each tagged with the bracket depth it was written at.
 *
 * Commas, semicolons, sentence endings and brackets all end a clause, but only
 * the brackets carry scope: `eachNodeClause` restores the subject when one
 * closes, so it has to know which clauses were inside. An unmatched `)` is
 * clamped rather than treated as an error, because this reads prose, not source.
 *
 * A sentence ends a clause for the same reason a comma does — a subject cannot
 * outlive the sentence that named it, so `Node is required. pnpm 10.34.4 or
 * newer` must not read as a Node floor. Only a `.`, `!` or `?` followed by
 * whitespace counts, which keeps `Node.js` and `22.19.0` whole; an abbreviation
 * that does split is harmless, because the fragment behind it names no tool and
 * a clause naming no tool deliberately carries the previous subject forward.
 * That same inheritance is what `Requires Node. 22 or newer.` relies on.
 */
function clausesAtDepth(line: string): Array<{ clause: string; depth: number }> {
  const clauses: Array<{ clause: string; depth: number }> = [];
  let depth = 0;
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") clauses.push({ clause: buffer, depth });
    buffer = "";
  };
  // Spread rather than indexed access: it iterates by code point, which is the
  // unit the rest of this helper reads prose in.
  const characters = [...line];
  for (const [index, character] of characters.entries()) {
    if (character === "(" || character === ")") {
      flush();
      depth = character === "(" ? depth + 1 : Math.max(0, depth - 1);
    } else if (character === "," || character === ";") flush();
    else if (
      (character === "." || character === "!" || character === "?") &&
      /^\s*$/u.test(characters[index + 1] ?? "")
    )
      flush();
    else buffer += character;
  }
  flush();
  return clauses;
}

/**
 * Visit every clause in `text` whose subject is Node, with the version it pins.
 *
 * Both the floor sweep and the discovery predicate read prose the same way, so
 * the attribution lives here once. Splitting them let discovery drift into
 * asking a *shape* question — "does this doc state an open-ended floor?" — when
 * the question it owes the sweep is a *subject* one: "does this doc state a Node
 * requirement at all?". A doc phrasing its requirement as `Requires Node 23.x`
 * answered no to the first and yes to the second, so it was never checked.
 *
 * Attribution is per CLAUSE, not per line. One logical line may pin several
 * tools at once — `Install Node 22 (pnpm >=10.34.4)` — and this used to read
 * the whole line as Node's, handing the sweep pnpm's floor as if the document
 * had claimed it. The only floor returned there was the foreign one, so the
 * reported over-claim named a version the prose never applied to Node at all.
 *
 * A clause naming no tool INHERITS the previous clause's subject, because the
 * canonical prose relies on it: in `Node.js 22.19.0–22.x, or 24.4.1 or newer`
 * the clause after the comma is still about Node. Dropping the inheritance
 * would trade a false positive for a false negative and quietly stop policing
 * the claim this helper exists to police.
 *
 * "Names no tool" is decided against closed-class function words only — the
 * conjunctions and comparatives that join two clauses about one subject. A
 * list of TOOL names would be the hand-maintained enumeration this suite
 * exists to replace, and would go stale the first time a guide pinned
 * something new.
 *
 * Only the words BEFORE the clause's first version decide its subject. Words
 * after it qualify the same claim rather than introducing another — real
 * prose reads `or 24.4.1 or newer for the npm/source path, or Docker`, and
 * treating `for the npm/source path` as a new subject drops the very floor
 * the sweep exists to read.
 *
 * A PARENTHETICAL is an aside, so it changes the subject only for its own
 * duration. Splitting on the brackets is right — a floor inside the aside
 * belongs to whatever the aside names — but carrying the subject through the
 * closing bracket let the aside decide everything after it, in both directions.
 * `Node.js (LTS) 22.19.0 or newer` stated nothing, because `LTS` reset the
 * subject and the version clause behind it has no words to set it back; and
 * `pnpm 10.34.4 (Node 22 is required), or 10.35.0` handed pnpm's floor to Node.
 * The subject in force before an aside is therefore restored after it.
 */
function eachNodeClause(text: string, visit: (clause: string, line: string) => void): void {
  const CONTINUATION = new Set([
    "or",
    "and",
    "to",
    "through",
    "up",
    "at",
    "least",
    "newer",
    "later",
    "then",
    "plus",
    "version",
    "v",
    "x",
  ]);

  for (const line of logicalLines(text)) {
    if (!/node/iu.test(line)) continue;
    let subjectIsNode = false;
    // The subject in force at each open bracket, restored at its match.
    const enclosing: boolean[] = [];
    let depth = 0;
    for (const { clause: bracketed, depth: at } of clausesAtDepth(line)) {
      while (at > depth) {
        enclosing.push(subjectIsNode);
        depth += 1;
      }
      while (at < depth) {
        subjectIsNode = enclosing.pop() ?? false;
        depth -= 1;
      }
      for (const clause of bracketed.split(/\s+and\s+/u)) {
        const firstVersion = clause.search(/\d/u);
        const prefix = firstVersion === -1 ? clause : clause.slice(0, firstVersion);
        const words = prefix.toLowerCase().match(/[a-z][a-z.]*/gu) ?? [];
        if (words.some((word) => word.includes("node"))) subjectIsNode = true;
        else if (words.some((word) => !CONTINUATION.has(word))) subjectIsNode = false;
        if (!subjectIsNode) continue;
        visit(clause, line);
      }
    }
  }
}

/**
 * Every open-ended Node floor a doc claims, e.g. `≥22.19.0` or "22.19 or newer".
 *
 * Only floors attributed to Node within the same logical line count, and only
 * clauses with no upper bound. The name always said both; the patterns said
 * neither, so a
 * caller that trusted the name would read a contrast ratio as a runtime promise
 * and read `>=22.19.0 <23` as an open-ended one.
 *
 * Covers the plain, the typographic and the URL-encoded spellings, because the
 * README states its floor twice — once in prose and once inside a shields.io
 * badge URL, where `≥` is percent-encoded and would otherwise be invisible to a
 * search for the prose form.
 *
 * A floor may be written at any ARITY — `>=23`, `>=22.19`, `>=22.19.0` — and a
 * missing minor or patch normalises to 0, the lowest release the claim in fact
 * promises and therefore the one an over-claim must be judged against. This
 * matches `statesNodeRequirement`, whose comparator accepts a comparator
 * followed by any digit and whose span pattern accepts a bare major before the
 * extension word. The two functions are meant to disagree about SHAPES — that
 * is the whole point of the discovery/floor split — but never about how a
 * version is SPELLED: where they did, a document was discovered and then swept
 * as though it claimed nothing, which reads exactly like an honest document.
 */
export function findOpenEndedNodeFloors(text: string): string[] {
  // Attribution is per clause within a logical line: a version counts only
  // where Node is what is being versioned. Without that the function matched
  // any `>=x.y` and reported design
  // tokens and unrelated tool floors as Node prerequisites, which is why the
  // documentation sweep could not simply scan the repository.
  //
  // Scanning the whole logical line, rather than a window running forward from
  // the word `node`, also stops an early match from hiding a later one: in
  // `>=22.19.0 <23 || >=24.4.1` the bounded arm consumed the line's only `node`
  // mention, so the arm that actually is open-ended was never reached.
  const patterns = [
    // A comparator followed by an upper bound is a bounded clause, not a floor:
    // `>=22.19.0 <23` promises nothing whatsoever about 23.x. The bound is
    // matched in its encoded spellings too (`%20`, `%3C`) — and that half
    // matters MORE than the floor half, because a bounded clause misread as
    // open-ended is a promise the document never made.
    //
    // `i` for the percent-encoding and for `or newer` only: RFC 3986 §6.2.2.1
    // makes `%e2%89%a5` and `%E2%89%A5` the SAME octets, and a shields.io badge
    // URL is written either way. Everything else in these patterns is caseless
    // by construction — `>=`, digits, `\s`, and `≥`, which case-folds to itself
    // — so the flag widens the encoding and the English, never the attribution.
    //
    // `%20` alongside `\s` because a shields.io badge percent-encodes the space
    // between comparator and version: `node-%E2%89%A5%2022.19.0-brightgreen` is
    // the canonical rendering. Without it the badge is DISCOVERED as a
    // requirement by `statesNodeRequirement` but yields no floor here — the
    // discovery/floor split this function's own docblock warns against.
    //
    // `%3E%3D` for the same reason, one comparator over. The floor may be
    // spelled four ways — `>=`, `≥`, and either of their encodings — and this
    // list carried three of them, missing the encoding of the COMMONEST glyph
    // while covering the encoding of the rarer one. `encodeURIComponent(">=")`
    // emits exactly `%3E%3D`, so it is the default output of every generator,
    // not a hand-typed variant. `statesNodeRequirement` has read it all along,
    // which is what made the omission here silent rather than merely narrow.
    //
    // Minor and patch are OPTIONAL, because `>=23` is the most ordinary way to
    // write a floor and demanding `major.minor` excluded it from both patterns
    // at once. Three comparators that discovery does read are still excluded
    // here, deliberately: `<` and `<=` are CEILINGS, and `>` is an EXCLUSIVE
    // floor with no exact form in the major.minor.patch vocabulary
    // `nodeFloorOverclaim` consumes — normalising it either way would report a
    // version the document never claimed.
    /(?:>=|≥|%E2%89%A5|%3E%3D)(?:\s|%20)*(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:\s|%20)*(?:<|%3C))?/giu,
    // `or later` alongside `or newer`: `SPANNED` has always read both, so a doc
    // saying "22.19 or later" was discovered and yielded no floor. The same
    // arity rule applies, with `v?` for `Node v23 or newer` — but `.x` stays
    // OUT, even though discovery accepts it, because admitting it would read
    // `22.19.0–22.x or newer` (a span with an open tail) as a floor of 22.0.0,
    // a version that prose does not claim. The lookbehind keeps a hash width
    // out for the same reason a dot used to: `sha256 or newer` is not a floor.
    /(?<![\w.])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s+or (?:newer|later)/giu,
  ];

  const found: string[] = [];
  eachNodeClause(text, (clause) => {
    for (const pattern of patterns) {
      for (const match of clause.matchAll(pattern)) {
        if (match[4] !== undefined) continue;
        found.push(`${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}`);
      }
    }
  });
  return found;
}

/**
 * Does this document state a Node runtime requirement — in any shape?
 *
 * This is the documentation sweep's DISCOVERY step, and it is deliberately not
 * `findOpenEndedNodeFloors`. That function answers a narrower question — "does
 * this doc claim an open-ended floor?" — and using it to discover made a
 * document's visibility depend on the shape of its claim. A guide stating
 * `Requires Node 23.x`, or a bounded `Node >=23 <24`, yields no floor, so it
 * dropped out of the discovered set and was never compared with the manifest.
 * The wording most likely to be wrong was the wording that escaped the check.
 *
 * A requirement is a clause about Node carrying one of:
 *   - a comparator-led version (`>=22`, `≥24.4.1`, `%E2%89%A5` in a badge URL),
 *   - a version spanned or extended (`22.19.0–22.x`, `24.4.1 or newer`), or
 *   - a version on a line whose prose says it is required.
 *
 * Bare mentions are excluded on purpose, because the sweep runs over every
 * markdown file in the repository: `node docs/designs/design-6/…` is a path,
 * `actions/setup-node … v4.4.0` versions an Action rather than the runtime, and
 * `node: [22, 24]` describes a CI matrix. Requiring a range, a span or the word
 * "required" is what separates a promise to the reader from an incidental
 * number, and it is why this predicate can be pointed at the whole tree.
 */
export function statesNodeRequirement(text: string): boolean {
  // `i` here for the same reason as in `findOpenEndedNodeFloors`, and for
  // consistency with SPANNED below, which has always carried it: a percent-
  // encoded comparator is case-insensitive per RFC 3986 §6.2.2.1.
  const COMPARATOR = /(?:>=|<=|>|<|≥|%E2%89%A5|%3E%3D)(?:\s|%20)*\d/iu;
  const SPANNED = /\d+(?:\.\d+)*(?:\.x)?\s*(?:–|—|%E2%80%93|\bor newer\b|\bor later\b)/iu;
  const VERSION = /\d+\.(?:\d+|x)/u;
  // A major on its own: one or two digits that are not part of a longer number
  // and not the head of a dotted version. `sha256` and `line 256` are excluded
  // by construction rather than by a denylist.
  const BARE_MAJOR = /(?<![\w.])v?\d{1,2}(?![\d.])/u;

  let states = false;
  eachNodeClause(text, (clause, line) => {
    // A DOTTED version may take the requirement verb from anywhere on the
    // logical line, because real prose interposes a parenthetical between the
    // two — `Node.js 23.5.0 (the current release) is required` — and the clause
    // carrying the verb names no tool, so it cannot inherit Node as its subject.
    const dotted = /requir/iu.test(line) && VERSION.test(clause);
    // A BARE major must find the verb in its OWN clause. Requiring a dot used to
    // do this job by accident: it was the only reason `Install Node 22 (pnpm
    // >=10.34.4 is required)` did not read as a Node floor. Admitting the most
    // ordinary spelling of a floor therefore has to re-earn that exclusion
    // deliberately, by attributing the verb the same way the version is.
    const bare = /requir/iu.test(clause) && BARE_MAJOR.test(clause);
    if (COMPARATOR.test(clause) || SPANNED.test(clause) || dotted || bare) states = true;
  });
  return states;
}

/**
 * Does claiming "`floor` or newer" promise a runtime that `range` in fact rejects?
 *
 * Returns the counterexample release, or `null` when the claim is honest.
 *
 * A published `engines.node` is not a floor — it is a set, and since
 * CVE-2025-27210 it is a set **with a hole in it** (`>=22.19.0 <23 || >=24.4.1`
 * excludes all of 23.x and 24.0–24.4.0). Prose that flattens that set back to a
 * floor re-promises the hole. So the check is the same interval reasoning
 * `assertRangePatchesCve202527210` uses: sweep the range's own clause endpoints,
 * which are the only places membership can change, and report the first one above
 * the claimed floor that the range refuses. Sampling arbitrary releases would
 * miss a narrow hole; the endpoints cannot.
 */
export function nodeFloorOverclaim(floor: string, range: string): string | null {
  // The floor is itself a claim — "this release and everything after it works" —
  // so it has to be tested, not just used as a lower cutoff. Checking only
  // versions ABOVE it answered `null` for a doc whose floor the range refuses
  // outright: `23.0.0` against `>=22.19.0 <23 || >=24.4.1` sits in the CVE hole,
  // while the only endpoint above it (24.4.1) is supported.
  //
  // The candidates come from `criticalVersions`, the same sweep the security
  // assertion uses, rather than a second bespoke endpoint regex. That regex read
  // `>=` and `<` and silently ignored `>`, `<=` and `=`, so an inclusive upper
  // bound contributed no endpoint at all and the version it rejects — `22.20.1`
  // for `<=22.20.0` — was never considered. `criticalVersions` takes every
  // numeric literal in the range AND each one's successor, which covers every
  // comparator by construction and needs no update when a new one appears.
  const parsedFloor = parseVersion(floor);
  const candidates = [floor, ...criticalVersions(range)]
    .filter((candidate) => compare(parseVersion(candidate), parsedFloor) >= 0)
    .sort((a, b) => compare(parseVersion(a), parseVersion(b)));

  for (const candidate of candidates) {
    if (!satisfiesRange(candidate, range)) return candidate;
  }
  return null;
}
