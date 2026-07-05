/**
 * M4-03 (DRO-265) — static shell (`index.html`) + stylesheet (`viewer.css`)
 * structural suite.
 *
 * The grid *behaviour* is covered by `grid-renderer.test.ts` (jsdom-executed
 * `viewer.js`). This file locks the two static assets the renderer boots into:
 *
 *   - AC1 — `static/index.html` has a `<header>`, a search `<input id="q">`,
 *           and a `<main id="grid">`, and loads `viewer.css` + `viewer.js`.
 *   - AC7 — `static/viewer.css` declares a responsive grid via
 *           `repeat(auto-fill, minmax(320px, 1fr))` and uses CSS `@layer`
 *           for cascade hygiene (Impl Notes).
 *
 * These are asserted on the file *bytes* (parsed with jsdom for the HTML) — no
 * server boot needed; M4-08's `cli.boot.test.ts` already covers the live serve.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, "../static");

function readStatic(name: string): string {
  return readFileSync(resolve(STATIC_DIR, name), "utf8");
}

// ── index.html (AC1) ────────────────────────────────────────────────────────

describe("static/index.html (AC1)", () => {
  const html = readStatic("index.html");
  const doc = new JSDOM(html).window.document;

  it("has a <header>", () => {
    expect(doc.querySelector("header")).not.toBeNull();
  });

  it("has a search input #q", () => {
    const q = doc.querySelector("#q") as HTMLInputElement | null;
    expect(q).not.toBeNull();
    expect(q?.tagName).toBe("INPUT");
  });

  it('has a <main id="grid">', () => {
    const main = doc.querySelector("main#grid");
    expect(main).not.toBeNull();
  });

  it("loads viewer.css and viewer.js by relative path", () => {
    const css = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
      l.getAttribute("href"),
    );
    expect(css).toContain("./viewer.css");

    const scripts = [...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
    expect(scripts).toContain("./viewer.js");
  });

  it("loads viewer.js as an ES module (type=module)", () => {
    const mod = doc.querySelector('script[src="./viewer.js"]');
    expect(mod?.getAttribute("type")).toBe("module");
  });

  it("declares a UTF-8 charset and a viewport meta", () => {
    expect(doc.querySelector("meta[charset]")?.getAttribute("charset")?.toLowerCase()).toBe(
      "utf-8",
    );
    expect(doc.querySelector('meta[name="viewport"]')).not.toBeNull();
  });

  it("labels the search input for accessibility", () => {
    const q = doc.querySelector("#q") as HTMLInputElement;
    const labelled =
      q.getAttribute("aria-label") ??
      (q.id ? doc.querySelector(`label[for="${q.id}"]`)?.textContent : null);
    expect(labelled, "search input needs an aria-label or a <label for>").toBeTruthy();
  });
});

// ── viewer.css (AC7 + Impl Notes) ───────────────────────────────────────────

describe("static/viewer.css (AC7)", () => {
  const css = readStatic("viewer.css");

  it("AC7 — declares a responsive auto-fill grid with minmax(320px, 1fr)", () => {
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toMatch(/repeat\(\s*auto-fill\s*,\s*minmax\(\s*320px\s*,\s*1fr\s*\)\s*\)/);
  });

  it("Impl Notes — uses CSS @layer for cascade hygiene", () => {
    expect(css).toMatch(/@layer\b/);
  });

  it("uses grid display for the card container", () => {
    expect(css.replace(/\s+/g, " ")).toMatch(/display:\s*grid/);
  });

  it("identity rule — the clay accent (--color-accent) is CONSUMED only on the wordmark spark", () => {
    // The genie identity contract (tokens.css): the clay/gilt accent marks
    // generate/refine moments ONLY; structural chrome stays ink/neutral. This
    // is a *browse* surface, so its single sanctioned accent touch is the
    // wordmark spark. A regression that paints a border/heading/pill clay would
    // add another `color: var(--color-accent)` consumer and trip this guard.
    //
    // We count CONSUMERS (`var(--color-accent…)` reads), not the token
    // DEFINITIONS (`--color-accent: …` in :root / dark mode), so redefining the
    // token per-scheme never trips it.
    const consumers = css.match(/var\(\s*--color-accent\b/g) ?? [];
    expect(consumers.length).toBe(1);

    // And that one consumer is the spark rule.
    const sparkRule = /\.wordmark__spark\s*\{[^}]*color:\s*var\(--color-accent\)[^}]*\}/;
    expect(css).toMatch(sparkRule);
  });

  it("a11y — overrides --color-ink-3 below the design token's failing 55% lightness", () => {
    // DRO-743: the shared design token --color-ink-3 at oklch(55% …) fails AA
    // body-text contrast (3.80:1 on dark paper). This viewer ships its own
    // AA-passing override (darker on light paper, lighter on dark) so the
    // browse surface is accessible independent of when DRO-743 lands. Guard it:
    // the light-mode value must be darker than 55%, the dark-mode value lighter.
    expect(css).toMatch(/--color-ink-3:\s*oklch\(\s*4[0-9]%/); // light: ~45% (darker)
    expect(css).toMatch(/--color-ink-3:\s*oklch\(\s*6[0-9]%/); // dark:  ~68% (lighter)
  });
});
