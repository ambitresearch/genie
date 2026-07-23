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

  it("exposes the persistent three-route shell with correct landmarks", () => {
    expect(doc.querySelectorAll("header")).toHaveLength(1);
    expect(doc.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
    expect(
      [...doc.querySelectorAll("[data-route-link]")].slice(0, 3).map((link) => link.textContent),
    ).toEqual(["Generate", "Browse", "Review"]);
  });

  it("puts the labeled Generate prompt before selectors and submit in DOM order", () => {
    const controls = [
      ...doc.querySelectorAll(
        "#generate-form textarea, #generate-form select, #generate-form button",
      ),
    ];
    expect(controls[0]?.id).toBe("generate-prompt");
    expect(doc.querySelector('label[for="generate-prompt"]')).not.toBeNull();
    expect(doc.querySelector("#generate-error[role='alert']")).not.toBeNull();
    expect(doc.querySelector("#app-status[aria-live='polite']")).not.toBeNull();
  });

  it("has a search input #q", () => {
    const q = doc.querySelector("#q") as HTMLInputElement | null;
    expect(q).not.toBeNull();
    expect(q?.tagName).toBe("INPUT");
  });

  it("has exactly one main region containing the grid", () => {
    expect(doc.querySelectorAll("main")).toHaveLength(1);
    expect(doc.querySelector("main #grid")).not.toBeNull();
  });

  it("loads viewer.css and viewer.js by relative path", () => {
    const css = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
      l.getAttribute("href"),
    );
    expect(css).toContain("./viewer.css");

    const scripts = [...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
    expect(scripts).toContain("./viewer.js");
  });

  it('loads viewer.js as a CLASSIC script — never type="module" (DRO-749 / file:// CORS)', () => {
    // A module script's relative-src fetch is rejected by the browser when
    // the document is opened via file:// (every file:// document gets an
    // opaque, distinct origin, so the ES module loader's same-origin check
    // fails against it) — verified empirically against a real headless-
    // Chromium file:// navigation (console: "has been blocked by CORS
    // policy"); the module never executes. This was shipped as type="module"
    // in the original M4-03 merge and silently broke the file:// vehicle
    // (DS-052 / RFC G-5) with no CI job catching it. A classic script has no
    // such restriction. This assertion is the regression guard: it fails
    // loudly if type="module" is ever reintroduced, rather than only being
    // caught by a manual file:// smoke test.
    const mod = doc.querySelector('script[src="./viewer.js"]');
    expect(mod?.getAttribute("type")).not.toBe("module");
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

  it("M4-04 (DRO-266) — has a collapsible HMR reload counter (#hmr-count) in the header (AC6)", () => {
    // AC6: "Reload count shown in viewer header for debugging (collapsible)."
    // A native <details> makes it collapsible with zero JS; #hmr-count is the
    // live read-out viewer.js's bumpReloadCounter writes into.
    const meter = doc.querySelector("#browse-view details.hmr-meter");
    expect(meter, "collapsible <details> HMR meter in Browse").not.toBeNull();
    expect(
      meter?.querySelector("summary"),
      "the <details> needs a <summary> to toggle",
    ).not.toBeNull();

    const count = doc.getElementById("hmr-count");
    expect(count, "#hmr-count live read-out").not.toBeNull();
    // Starts at zero (a fresh page has fired no reloads yet).
    expect(count?.getAttribute("data-count")).toBe("0");
    expect(count?.textContent?.trim()).toBe("0");
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

  it("provides 44px controls, a visible focus ring, responsive reflow, and reduced motion", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)/s);
    expect(css).toMatch(/\.conjure-button\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1099px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*719px\)/);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.generate-progress__skeleton\s*\{[^}]*animation:\s*none/s,
    );
  });

  it("uses a fixed minimum for the nested viewer instead of viewport-relative height", () => {
    const rule = /\.ds-viewer-embed\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/min-height:\s*\d+px/);
    expect(rule).not.toMatch(/\b(?:vh|dvh|svh|lvh)\b/);
  });

  it("identity rule — structural navigation never consumes clay", () => {
    const navRule = /\.app-nav(?:__link)?[^{]*\{[^}]*\}/g;
    const structuralRules = css.match(navRule)?.join("\n") ?? "";
    expect(structuralRules).not.toMatch(/--color-accent/);

    expect(css).toMatch(/\.conjure-button\s*\{[^}]*background:\s*var\(--color-accent\)[^}]*\}/s);
    expect(css).toMatch(
      /\.generate-error\s*\{[^}]*border-left:\s*3px solid var\(--color-accent\)[^}]*\}/s,
    );
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

  it("M4-09 (DRO-271) AC2/AC6 — --color-accent-2 has its own DRO-743-style dark override", () => {
    // This viewer.css is a SEPARATE inlined copy of docs/designs/design-6/
    // tokens.css (RFC G-5: "one artefact, three vehicles") — it does not
    // @import or otherwise share state with that file. DRO-743 added a dark
    // override for --color-accent-2 to tokens.css (light value 56% falls
    // back to 3.78:1 on dark paper, failing AA) but nothing ported that fix
    // here, because nothing in viewer.css consumed --color-accent-2 at the
    // time. Now the wordmark spark does (the clay-text-rule fix, same test
    // file, "identity rule" case above) — so without this override, the
    // spark would silently regress to the exact contrast failure DRO-743
    // already fixed once, just in dark mode specifically. Both required
    // triggers (manual `data-scheme="dark"` + automatic `prefers-color-
    // scheme: dark`, per the AC7 tests below) must carry the override, or
    // one vehicle would still show the light-mode (failing) value.
    const lightMatch = /--color-accent-2:\s*oklch\(\s*56%/.exec(css);
    expect(
      lightMatch,
      "expected the light-mode --color-accent-2 (56%) to still be present",
    ).not.toBeNull();

    const darkOverrides = css.match(/--color-accent-2:\s*oklch\(\s*64%\s+0\.11\s+42\s*\)/g) ?? [];
    expect(
      darkOverrides.length,
      "expected the DRO-743 dark --color-accent-2 override (64% 0.11 42) in BOTH the manual data-scheme block and the prefers-color-scheme media query",
    ).toBe(2);
  });

  it("M4-09 AC7 — honors the OS prefers-color-scheme automatically, not only a manual toggle", () => {
    // Two independent triggers must both exist: `:root[data-scheme="dark"]`
    // (an explicit override — already present, no in-app toggle UI exists
    // yet) AND an `@media (prefers-color-scheme: dark)` block (automatic,
    // needs no app code) applying the SAME dark palette. Without the media
    // query, a user whose OS is set to dark mode would still see the light
    // viewer chrome by default.
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);

    // The media-query block sets the same paper/ink dark values as the
    // explicit override (spot-check the two AA-load-bearing tokens rather
    // than every property, to stay resilient to unrelated token additions).
    const mediaBlockMatch =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\s*\}\s*\}/.exec(css);
    expect(
      mediaBlockMatch,
      "expected a parseable @media (prefers-color-scheme: dark) block",
    ).not.toBeNull();
    const mediaBlock = mediaBlockMatch?.[1] ?? "";
    expect(mediaBlock).toMatch(/--color-paper:\s*oklch\(\s*19%/);
    expect(mediaBlock).toMatch(/--color-ink-3:\s*oklch\(\s*6[0-9]%/);

    // `color-scheme: light dark` on `html` is what makes UA-native chrome
    // (e.g. the search input's cancel/reveal icons) follow the OS preference
    // too, not just the app's own custom-property palette.
    expect(normalized).toMatch(/html\s*\{[^}]*color-scheme:\s*light\s+dark/);
  });

  it("M4-09 AC7 — a manual data-scheme still wins over the OS preference", () => {
    // The media-query block scopes to `:root:not([data-scheme="light"])` —
    // an explicit "force light" override must be able to beat an OS dark
    // preference (an explicit choice always wins over an ambient one).
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toMatch(/:root:not\(\[data-scheme=["']light["']\]\)/);
  });
});
