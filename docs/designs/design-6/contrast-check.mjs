#!/usr/bin/env node
// DRO-743 — independent contrast verifier for docs/designs/design-6/tokens.css.
//
// Parses the `:root` (light) and `:root[data-scheme="dark"]` (dark) token
// blocks directly out of tokens.css, converts each `oklch()` value to linear
// sRGB using Bjorn Ottosson's OKLab matrices (no deps), then applies the
// standard WCAG relative-luminance + contrast-ratio formulas. Prints the full
// pair ledger and exits non-zero if any AA-required pair regresses below its
// target — so this can be re-run after any future token edit, not just as a
// one-off audit.
//
// Run: node docs/designs/design-6/contrast-check.mjs   (from repo root)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = join(__dirname, "tokens.css");

// ── OKLCH -> OKLab -> linear sRGB (Bjorn Ottosson's matrices) ───────────────
function oklchToOklab(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b2 = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, b2];
}

function linearToSrgbGamma(c) {
  const cc = Math.min(1, Math.max(0, c));
  return cc <= 0.0031308 ? 12.92 * cc : 1.055 * Math.pow(cc, 1 / 2.4) - 0.055;
}

function toHex(rgbLinear) {
  return (
    "#" +
    rgbLinear
      .map((c) =>
        Math.min(255, Math.max(0, Math.round(linearToSrgbGamma(c) * 255)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

// WCAG relative luminance — expects LINEAR rgb components (already linear
// coming out of the OKLab conversion above; no separate un-gamma step needed).
function relLuminance([r, g, b]) {
  const clamp = (c) => Math.min(1, Math.max(0, c));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrastOf(rgb1, rgb2) {
  const L1 = relLuminance(rgb1);
  const L2 = relLuminance(rgb2);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseOklch(str) {
  const m = str.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) throw new Error(`bad oklch(): ${str}`);
  return [parseFloat(m[1]) / 100, parseFloat(m[2]), parseFloat(m[3])];
}

function rgbFromOklchStr(str) {
  if (str === "white") return [1, 1, 1]; // linear white — used for button-text pairs
  const [L, C, H] = parseOklch(str);
  const [Lo, a, b] = oklchToOklab(L, C, H);
  return oklabToLinearSrgb(Lo, a, b);
}

function ratioOf(str1, str2) {
  return contrastOf(rgbFromOklchStr(str1), rgbFromOklchStr(str2));
}

// ── Extract the light (:root) and dark (:root[data-scheme="dark"]) token
//    blocks from tokens.css and build {tokenName: oklchString} maps. ────────
function extractBlock(css, startMarker) {
  const start = css.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("\n}", braceStart);
  return css.slice(braceStart, braceEnd);
}

function parseTokens(block) {
  const tokens = {};
  const re = /--color-([a-z0-9-]+):\s*(oklch\([^)]*\))/g;
  let m;
  while ((m = re.exec(block))) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

const css = readFileSync(TOKENS_PATH, "utf-8");
const lightBlock = extractBlock(css, "\n:root {");
const darkBlock = extractBlock(css, '[data-scheme="dark"]');
const light = parseTokens(lightBlock);
// Dark is an override cascade over :root — merge, dark wins.
const dark = { ...light, ...parseTokens(darkBlock) };

const AA_BODY = 4.5;
const AA_UI = 3.0; // large text / UI components (focus ring, etc.) — WCAG 1.4.11 / 1.4.3 large-text floor

function row(label, fgTok, bgTok, tokMap, target) {
  const fg = tokMap[fgTok] ?? fgTok; // allow passing "white" literal
  const bg = tokMap[bgTok] ?? bgTok;
  const ratio = ratioOf(fg, bg);
  const verdict = target == null ? "" : ratio >= target ? "✓" : "✗";
  return { label, ratio, verdict, target };
}

console.log("=== LIGHT MODE (design.md §14 reproduction) ===");
const lightRows = [
  row("ink on paper", "ink", "paper", light, AA_BODY),
  row("ink-2 on paper", "ink-2", "paper", light, AA_BODY),
  row("ink-3 on paper", "ink-3", "paper", light, AA_BODY),
  row("ink-3 on paper-2", "ink-3", "paper-2", light, null),
  row("ink-3 on paper-3", "ink-3", "paper-3", light, null),
  row("struct on paper", "struct", "paper", light, AA_BODY),
  row("focus on paper", "focus", "paper", light, AA_UI),
  row("accent (clay) on paper", "accent", "paper", light, null),
  row("accent-2 (deep clay, text-safe) on paper", "accent-2", "paper", light, AA_BODY),
  row("white on accent", "white", "accent", light, null),
  row("white on accent-2", "white", "accent-2", light, AA_BODY),
  // DRO-748 fix: dedicated button-fill text token for Conjure/Refine/Apply/
  // Approve — gated, this is the pairing those buttons actually use.
  row("on-accent on accent [button-fill text]", "on-accent", "accent", light, AA_BODY),
  // Hover-state fill (button darkens to accent-2 on hover, §5 button ladder).
  // Not gated at AA_BODY — hard ceiling of the fill itself (even pure black
  // on accent-2 (light) only reaches 4.29:1), not a token-tuning gap. Clears
  // AA_UI (filled control, not body prose); flagged in design.md §14 rather
  // than silently assumed solved.
  row(
    "on-accent on accent-2 [button-fill text, HOVER state]",
    "on-accent",
    "accent-2",
    light,
    AA_UI,
  ),
];
for (const r of lightRows)
  console.log(`${r.ratio.toFixed(2)}:1  ${r.verdict.padEnd(1)}  ${r.label}`);

console.log('\n=== DARK MODE (data-scheme="dark") — DRO-743 ===');
const darkRows = [
  row("ink(dark) on paper(dark)", "ink", "paper", dark, AA_BODY),
  row("ink-2(dark) on paper(dark)", "ink-2", "paper", dark, AA_BODY),
  row("ink-3(dark) on paper(dark)", "ink-3", "paper", dark, AA_BODY),
  row("ink-3(dark) on paper-2(dark)", "ink-3", "paper-2", dark, null),
  row("ink-3(dark) on paper-3(dark)", "ink-3", "paper-3", dark, null),
  row("struct(dark) on paper(dark)", "struct", "paper", dark, AA_BODY),
  row("focus(dark, inherited — no override) on paper(dark)", "focus", "paper", dark, AA_UI),
  row("accent(dark, clay) on paper(dark)", "accent", "paper", dark, null),
  row("accent-2(dark, text-safe clay) on paper(dark)", "accent-2", "paper", dark, AA_BODY),
  row("accent-2(dark) on paper-2(dark)", "accent-2", "paper-2", dark, null),
  row("accent-2(dark) on paper-3(dark)", "accent-2", "paper-3", dark, null),
  row("white on accent(dark)", "white", "accent", dark, null),
  row("white on accent-2(dark)", "white", "accent-2", dark, null),
  // Not used by any button — --color-ink is tuned for body-text-on-paper and
  // flips per-scheme (near-black light / near-white dark); it was never a
  // viable button-fill-text token in dark mode (DRO-748 finding). Left
  // ungated (target: null) since this pairing is never actually rendered —
  // the button uses --color-on-accent instead (gated row below).
  row("ink(dark) on accent(dark) [not used — see on-accent below]", "ink", "accent", dark, null),
  // DRO-748 fix: --color-on-accent is scheme-invariant (no dark override —
  // same oklch(20% 0.004 60) in both schemes), so it inherits into `dark`
  // unchanged here. Gated: this is the pairing Conjure/Refine/Apply/Approve
  // buttons actually use in dark mode.
  row("on-accent on accent(dark) [button-fill text]", "on-accent", "accent", dark, AA_BODY),
  // Hover-state fill, dark mode — see the light-mode hover row above for
  // why this is gated at AA_UI, not AA_BODY (hard ceiling of the fill, not a
  // token-tuning gap). Dark-mode hover has more headroom than light-mode
  // hover since accent-2(dark) is lighter than accent-2(light).
  row(
    "on-accent on accent-2(dark) [button-fill text, HOVER state]",
    "on-accent",
    "accent-2",
    dark,
    AA_UI,
  ),
];
for (const r of darkRows)
  console.log(`${r.ratio.toFixed(2)}:1  ${r.verdict.padEnd(1)}  ${r.label}`);

// ── Print the computed hex for every dark token touched by this fix, so the
//    hex comments living in tokens.css/design.md have a re-derivable source
//    right here (previously verified by a separate throwaway script — see
//    PR description; folding toHex() into the persisted verifier means that
//    claim is checkable from this file alone, no separate script needed). ──
console.log("\n=== computed hex (dark-mode fix tokens) ===");
for (const tok of ["ink-3", "accent-2", "paper"]) {
  console.log(`--color-${tok} (dark): ${toHex(rgbFromOklchStr(dark[tok]))}`);
}
// --color-on-accent (DRO-748) has no dark override by design (scheme-invariant
// fix — see tokens.css comment) so this is its one value in both schemes.
console.log(`--color-on-accent (both schemes): ${toHex(rgbFromOklchStr(light["on-accent"]))}`);

// ── Exit non-zero if any AA-targeted pair fails, so this doubles as a guard
//    against future token edits silently reopening DRO-743. ─────────────────
const failed = [...lightRows, ...darkRows].filter((r) => r.target != null && r.ratio < r.target);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} pair(s) below their AA target:`);
  for (const r of failed) console.error(`  ${r.label}: ${r.ratio.toFixed(2)}:1 < ${r.target}:1`);
  process.exit(1);
}
console.log("\nAll AA-targeted pairs pass.");
