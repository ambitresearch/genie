/**
 * M4-09 (DRO-271) — viewer chrome accessibility audit, real Chromium + axe-core.
 *
 * Scope (per the issue body): "Audit the viewer chrome (the grid wrapper, not
 * the per-card iframes) for WCAG 2.2 AA conformance with axe-core. Component
 * authors own their own preview accessibility; the viewer must not block it."
 * Every `analyze()` call below therefore `.exclude(["iframe"])`s the per-card
 * previews — a hostile or merely-inaccessible component preview must never
 * fail THIS suite; only the grid/header/search chrome is in scope.
 *
 * ── Why a real browser, not jsdom (unlike grid-renderer.test.ts) ───────────
 * `grid-renderer.test.ts` and `static-index.test.ts` unit-test the DOM shape
 * and CSS text `viewer.js`/`viewer.css` produce — fast, but jsdom does not
 * compute layout, contrast, or real focus order. axe-core's contrast checks
 * in particular need genuine rendered pixels (computed `background-color`
 * through `color-mix`/`@layer`/CSS custom properties), which is exactly why
 * the issue names axe-core + AC6 asks for *computed* colours "not a JPEG".
 * So this suite launches real headless Chromium (via `playwright`, already a
 * devDependency for `@axe-core/playwright`) and serves the ACTUAL
 * `packages/viewer/static/*` files over a plain `node:http` server — no Vite,
 * no jsdom, no mocks. `viewer.js` is a classic script (DRO-749): this suite
 * loads it exactly the way a real page does, `<script src="./viewer.js">`,
 * with zero test-hook seam involved.
 *
 * ── Environment note (sandboxed workspace) ──────────────────────────────────
 * This sandbox has no system libglib/libnss/fontconfig install for Chromium
 * to link against, and `pnpm approve-builds` cannot run `apt-get` here. A
 * prior agent (DRO-717) pre-provisioned a private lib root + font cache
 * exactly for this: `LD_LIBRARY_PATH=/tmp/apt-scratch/localroot/usr/lib/
 * x86_64-linux-gnu` (153 .so files, verified to include libglib-2.0,
 * libnss3, libnspr4 etc.) and `FONTCONFIG_FILE=/tmp/fonts.conf` (Liberation
 * TTFs + a writable `/tmp/fontcache`). CI (GitHub Actions `ubuntu-latest`)
 * has a real Chromium dependency closure out of the box and needs neither
 * variable — harmless no-ops there. Local dev on a normal desktop likewise
 * needs neither. This is a sandbox-only workaround, not a new deploy
 * requirement.
 *
 * AC coverage map:
 *   - AC1 — this file; `pnpm --filter @ambitresearch/genie-viewer test:a11y` (package.json
 *           script below) runs it.
 *   - AC2 — zero critical/serious violations, scanned twice (light + dark).
 *   - AC3 — keyboard walk: Tab → search, Tab → card 1 (article, tabindex=0),
 *           Tab → card 2; Enter on a focused card navigates (mirrors the
 *           grid-renderer unit test, but through REAL Tab/Enter key events).
 *   - AC4 — `#q` has an accessible name (aria-label).
 *   - AC5 — every `<iframe>` has a non-empty `title`.
 *   - AC6 — axe-core `color-contrast` (part of the wcag2aa/wcag22aa tag sets
 *           this suite scans with) plus an explicit computed-style spot
 *           check on the two DRO-743-fixed dark-mode tokens.
 *   - AC7 — the same scan + keyboard walk repeated with
 *           `emulateMedia({ colorScheme: "dark" })`.
 *
 * `assertNoBlockingViolations` treats axe-core's `incomplete` bucket as a
 * failure too. There are currently no approved exceptions, so a finding axe
 * cannot auto-grade must receive explicit review rather than silently pass.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm, mkdir, writeFile, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, "../static");
const FIXTURE_KIT_DIR = resolve(HERE, "fixtures/kit");
const requireFromHere = createRequire(import.meta.url);
const requireFromAxePlaywright = createRequire(requireFromHere.resolve("@axe-core/playwright"));
const axeSource = readFileSync(requireFromAxePlaywright.resolve("axe-core/axe.min.js"), "utf8");

// ── Chromium-absent skip (mirrors packages/e2e's isDockerAvailable pattern) ─
// A real browser binary is a genuinely heavier dependency than the rest of
// this repo's fast, no-external-deps unit suite — `pnpm test` (this file's
// default include path via the root vitest.config.ts) must stay green on a
// machine that has never run `npx playwright install`. So this file probes
// once, at collection time, whether Chromium actually launches, and skips the
// whole suite (never fails it) when it does not. CI runs it for real via a
// DEDICATED job (ci.yml `viewer-a11y`) that installs the browser first and
// sets `GENIE_REQUIRE_A11Y_BROWSER=1`, so a misconfigured CI leg fails loudly
// instead of silently skipping — the same "vacuous-skip must fail somewhere"
// contract `GENIE_REQUIRE_DOCKER`/`GENIE_REQUIRE_LLM` already establish for
// the Gitea and M2 legs.
async function isChromiumAvailable(): Promise<boolean> {
  if (process.env.GENIE_SKIP_A11Y_TESTS === "1") return false;
  try {
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();
if (!chromiumAvailable) {
  console.info(
    "[a11y] no launchable Chromium detected — skipping the axe-core viewer audit " +
      "(run `npx playwright install --with-deps chromium` to run it locally; " +
      "CI's dedicated viewer-a11y job runs it for real).",
  );
}

if (!chromiumAvailable && process.env.GENIE_REQUIRE_A11Y_BROWSER === "1") {
  throw new Error(
    "GENIE_REQUIRE_A11Y_BROWSER=1 but Chromium failed to launch — the CI viewer-a11y " +
      "job must have a working browser; this is not a suite that is allowed to " +
      "silently skip on that leg.",
  );
}

// ── Tiny static file server ─────────────────────────────────────────────────
// No Vite involved (that's M4-02/M4-10's vehicle, not this one) — this suite
// only needs to serve plain files byte-for-byte, exactly like the `file://`
// tier conceptually does but over http:// so `fetch("./manifest.json")`
// (viewer.js's non-inline path) behaves like a real browser session rather
// than tripping the file:// CORS restriction a *module* script would hit
// (moot here — viewer.js is a classic script either way, DRO-749).

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveDir(root: string): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let relPath = decodeURIComponent(url.pathname);
        if (relPath === "/") relPath = "/index.html";
        const filePath = join(root, relPath);
        // Minimal traversal guard — this only ever serves fixed fixture
        // content in-process, but there is no reason to skip the check.
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    })();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

// ── Test kit root: the real static/ viewer shell + the M4-02 fixture kit ───
// The viewer's OWN static/{index.html,viewer.js,viewer.css} is the thing
// under audit; the fixture kit (already used by grid-renderer.test.ts /
// static-index.test.ts) supplies a realistic two-group manifest + two real
// preview.html iframes so AC3/AC5's "per card" assertions have more than one
// card to walk.
async function buildAuditRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-viewer-a11y-"));
  // Copy the real shipped shell verbatim — this is the artefact under audit.
  await cp(join(STATIC_DIR, "index.html"), join(dir, "index.html"));
  await cp(join(STATIC_DIR, "viewer.js"), join(dir, "viewer.js"));
  await cp(join(STATIC_DIR, "viewer.css"), join(dir, "viewer.css"));
  // Copy the fixture kit's manifest + component previews alongside it, so
  // `fetch("./.genie/manifest.json")` and each card's iframe `src` resolve.
  await mkdir(join(dir, ".genie"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, ".genie/manifest.json"), join(dir, ".genie/manifest.json"));
  await cp(join(FIXTURE_KIT_DIR, "components"), join(dir, "components"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, "tokens"), join(dir, "tokens"), { recursive: true });
  return dir;
}

async function buildEmptyRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-viewer-a11y-empty-"));
  await cp(join(STATIC_DIR, "index.html"), join(dir, "index.html"));
  await cp(join(STATIC_DIR, "viewer.js"), join(dir, "viewer.js"));
  await cp(join(STATIC_DIR, "viewer.css"), join(dir, "viewer.css"));
  await mkdir(join(dir, ".genie"), { recursive: true });
  await writeFile(
    join(dir, ".genie/manifest.json"),
    JSON.stringify({
      version: 1,
      name: "empty",
      generatedAt: "2026-07-01T00:00:00.000Z",
      groups: [],
      components: [],
    }),
  );
  return dir;
}

function populatedReviewDraft() {
  const componentName = "ReviewStatus";
  const group = "audit";
  const path = `components/${group}/${componentName}/${componentName}.html`;
  return {
    componentName,
    group,
    files: [
      {
        path,
        content: [
          `<!-- @genie group="${group}" -->`,
          "<!doctype html>",
          '<html lang="en">',
          "<head>",
          '<meta charset="utf-8" />',
          '<meta name="viewport" content="width=device-width, initial-scale=1" />',
          "<style>",
          ":root{--card-radius:18px;--card-padding:24px;--card-gap:12px;}",
          "body{margin:0;font:16px system-ui;background:#f8f5ee;color:#17202a;}",
          ".card{box-sizing:border-box;border:1px solid #d8d0c2;border-radius:var(--card-radius);padding:var(--card-padding);display:grid;gap:var(--card-gap);}",
          ".eyebrow{margin:0;color:#4f5f73;font-size:12px;text-transform:uppercase;letter-spacing:.12em;}",
          "h1{margin:0;font-size:28px;}p{margin:0;}",
          "</style>",
          "</head>",
          "<body>",
          '<article class="card" aria-label="Review status">',
          '<p class="eyebrow">Ready</p>',
          "<h1>ReviewStatus</h1>",
          "<p>Deterministic controls and checklist-ready draft.</p>",
          "</article>",
          "</body>",
          "</html>",
        ].join("\n"),
        mimeType: "text/html",
        encoding: "utf-8",
      },
    ],
    manifestEntry: {
      viewport: { width: 360, height: 180 },
      subtitle: "Review audit fixture",
      tags: ["review", "a11y"],
    },
    usage: {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    },
  };
}

async function writeReviewHost(root: string): Promise<void> {
  const draft = populatedReviewDraft();
  const embeddedManifest = {
    version: 1,
    name: "audit-kit",
    generatedAt: "2026-07-25T00:00:00.000Z",
    groups: [],
    components: [],
  };
  const shell = await readFile(join(root, "index.html"), "utf8");
  await writeFile(
    join(root, "embedded-review.html"),
    shell.replace(
      '<script src="./viewer.js"></script>',
      `<script type="application/json" id="manifest">${JSON.stringify(embeddedManifest).replace(
        /</g,
        "\\u003c",
      )}</script>\n    <script src="./viewer.js"></script>`,
    ),
  );
  const host = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>genie review host harness</title>
    <style>
      html,
      body,
      iframe {
        width: 100%;
        height: 100%;
        margin: 0;
      }
      iframe {
        display: block;
        border: 0;
      }
    </style>
  </head>
  <body>
    <iframe id="viewer-frame" title="genie viewer"></iframe>
    <script>
      const frame = document.getElementById("viewer-frame");
      const draft = ${JSON.stringify(draft)};
      const kit = {
        id: "audit-kit",
        name: "Audit UI kit",
        owner: "local",
        updatedAt: "2026-07-25T00:00:00.000Z",
        canEdit: true
      };
      function reply(id, structuredContent) {
        frame.contentWindow.postMessage(
          { jsonrpc: "2.0", id, result: { structuredContent } },
          "*"
        );
      }
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.method === "ui/initialize") {
          frame.contentWindow.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: { hostCapabilities: { serverTools: true } }
            },
            "*"
          );
          return;
        }
        if (message.method !== "tools/call") return;
        const name = message.params && message.params.name;
        const args = (message.params && message.params.arguments) || {};
        if (name === "mcp__genie__list_kits") {
          reply(message.id, { kits: [kit] });
        } else if (name === "mcp__genie__list_files") {
          reply(message.id, {
            files: [
              { path: "styles.css" },
              { path: "components/audit/Existing/Existing.html" }
            ]
          });
        } else if (name === "mcp__genie__read_file") {
          reply(message.id, {
            path: args.path,
            content: args.path === "styles.css" ? ":root{--card-radius:18px;}" : "<!-- @genie group=\"audit\" -->",
            mimeType: args.path === "styles.css" ? "text/css" : "text/html",
            encoding: "utf-8"
          });
        } else if (name === "mcp__genie__list_components") {
          reply(message.id, {
            components: [
              {
                name: "Existing",
                group: "audit",
                path: "components/audit/Existing/Existing.html"
              }
            ]
          });
        } else if (name === "mcp__genie__conjure") {
          reply(message.id, draft);
        } else if (name === "mcp__genie__plan") {
          reply(message.id, { planId: "plan-review-audit" });
        } else if (name === "mcp__genie__write_files") {
          reply(message.id, {
            writtenPaths: Array.isArray(args.files) ? args.files.map((file) => file.path) : []
          });
        } else if (name === "mcp__genie__validate") {
          reply(message.id, { ok: true, bad: 0, total: 1 });
        } else {
          frame.contentWindow.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unknown tool: " + name }
            },
            "*"
          );
        }
      });
      frame.src = "./embedded-review.html?route=generate";
    </script>
  </body>
</html>`;
  await writeFile(join(root, "host.html"), host);
}

// ── Suite-wide browser (one Chromium instance, fresh context per test) ─────
// Guarded the same way as the describe blocks below: when Chromium can't
// launch, every describe.skipIf(!chromiumAvailable) block is skipped, so
// nothing ever calls newPage() — but this hook is a file-level beforeAll
// (outside any describe), which vitest always runs regardless of sibling
// skips. Without this guard it would re-attempt the same failing launch and
// throw, defeating the whole point of the skip above.

let browser: Browser | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

/** A fresh, isolated page + context, closed by the caller when done. */
async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  if (!browser)
    throw new Error(
      "newPage() called without a launched browser — this should be unreachable when chromiumAvailable is false, since every describe block is skipIf-guarded.",
    );
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/**
 * Pre-approved `results.incomplete` findings, keyed by rule id. Empty by
 * default: new incomplete findings require explicit review. Entries may be an
 * exact target selector or a RegExp, and each one needs a written
 * justification for why axe's inability to decide is acceptable here.
 */
const APPROVED_INCOMPLETE: Record<string, (string | RegExp)[]> = {
  // The checklist state glyphs (✓ / ✕ / ○) are symbol-only, so axe reports
  // "Element content contains only non-text characters" and declines to judge
  // their contrast. They are `aria-hidden="true"` decorations: the check's real
  // state is carried by the adjacent label text and the row's own
  // `check-item--pass|fail|pending` colour, both of which ARE scanned.
  "color-contrast": [/^li\[data-check-id="[a-z0-9-]+"\] > \.check-item__icon/],
};
type AxeSelector = Parameters<AxeBuilder["include"]>[0];
type AxeCheck = { message?: string };
type AxeNode = {
  target: string[];
  html: string;
  any?: AxeCheck[];
  all?: AxeCheck[];
  none?: AxeCheck[];
};
type AxeRuleResult = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: AxeNode[];
};
type AxeScanResults = {
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
};

/**
 * Run an axe-core scan restricted to the WCAG 2.2 AA rule sets (AC2), always
 * excluding `<iframe>` (per-card previews are out of scope — see the file
 * header) and throw with a fully actionable message — rule id, impact, and
 * every offending node's selector/HTML — if any violation is `critical` or
 * `serious`. `minor`/`moderate` findings are intentionally allowed through
 * (the issue's own AC2 wording): they still show up in `results.violations`
 * for a human to read if this is ever run outside the pass/fail assertion.
 *
 * Also inspects `results.incomplete` — axe-core's third bucket for checks it
 * could not auto-resolve (as opposed to checks that ran and failed). Without
 * this, a real gap can hide here indefinitely: `results.violations` alone
 * can otherwise silently miss a real gap. Any incomplete result NOT in
 * `APPROVED_INCOMPLETE` fails the
 * suite — new incomplete findings need their own justification, not a free
 * pass because SOME incomplete findings are pre-approved.
 */
async function assertNoBlockingViolations(
  page: Page,
  extra?: { rules?: string[]; include?: AxeSelector[]; exclude?: AxeSelector[] },
): Promise<void> {
  let builder = new AxeBuilder({ page });
  for (const selector of extra?.include ?? []) {
    builder = builder.include(selector);
  }
  for (const selector of extra?.exclude ?? ["iframe"]) {
    builder = builder.exclude(selector);
  }
  builder = extra?.rules
    ? builder.withRules(extra.rules)
    : builder.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  checkAxeResults(await builder.analyze());
}

function checkAxeResults(results: AxeScanResults): void {
  const blocking = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  if (blocking.length > 0) {
    const detail = blocking
      .map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n` +
          v.nodes.map((n) => `  - ${n.target.join(" ")}: ${n.html}`).join("\n"),
      )
      .join("\n\n");
    throw new Error(`axe-core found blocking violations:\n\n${detail}`);
  }

  const unapproved = results.incomplete.flatMap((v) => {
    const approved = APPROVED_INCOMPLETE[v.id] ?? [];
    const offending = v.nodes.filter((n) => {
      const target = n.target.join(" ");
      return !approved.some((rule) =>
        typeof rule === "string" ? rule === target : rule.test(target),
      );
    });
    return offending.map((n) => ({ rule: v, node: n }));
  });
  if (unapproved.length > 0) {
    const detail = unapproved
      .map(({ rule, node }) => {
        // An incomplete result is useless for triage without axe's own reason
        // for giving up, so surface every check message it attached.
        const why = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])]
          .map((check) => check.message)
          .filter(Boolean)
          .join("; ");
        return (
          `${rule.id} (${rule.impact}): ${rule.help}\n  - ${node.target.join(" ")}: ${node.html}` +
          (why ? `\n    why: ${why}` : "")
        );
      })
      .join("\n\n");
    throw new Error(
      `axe-core found unreviewed "incomplete" results (not in APPROVED_INCOMPLETE — ` +
        `needs its own justification, see AC2):\n\n${detail}`,
    );
  }
}

async function assertNoBlockingViolationsInFrame(
  frame: Frame,
  extra?: { rules?: string[] },
): Promise<void> {
  await frame.evaluate(axeSource);
  const results = await frame.evaluate(
    async (options: { rules?: string[] }) => {
      const axe = (
        window as typeof window & {
          axe: { run: (context: unknown, options: unknown) => Promise<unknown> };
        }
      ).axe;
      return await axe.run(
        { exclude: [["iframe"]] },
        options.rules
          ? { runOnly: { type: "rule", values: options.rules } }
          : { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } },
      );
    },
    { rules: extra?.rules },
  );
  checkAxeResults(results as AxeScanResults);
}

// ── AC2/AC6 — populated Browse workbench, light mode ────────────────────────
//
// M7-02 (#234) migrated standalone Browse from the plain M4 grid to the tree
// + component-detail workbench (Design 6 §7/§11); this suite now audits that
// surface instead. The embedded `ui://genie/grid` tool-result path (the
// classic `.ds-card` grid) is unchanged by this issue and is still covered
// by `grid-renderer.test.ts` / `hmr-client.test.ts`.

describe.skipIf(!chromiumAvailable)(
  "viewer chrome — axe-core scan (populated Browse workbench, light mode)",
  () => {
    let root: string;
    let server: Server;
    let port: number;
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      root = await buildAuditRoot();
      server = serveDir(root);
      port = await listen(server);
      ({ context, page } = await newPage());
      await page.goto(`http://127.0.0.1:${port}/?route=browse`);
      // Wait for the real fetch('./.genie/manifest.json') boot path to finish
      // painting the tree, rather than racing axe-core against an empty tree.
      await page.waitForSelector('[role="treeitem"]', { timeout: 5_000 });
    }, 30_000);

    afterAll(async () => {
      await context.close();
      await close(server);
      await rm(root, { recursive: true, force: true });
    });

    it("AC2 — zero critical or serious violations against the viewer shell (iframes excluded)", async () => {
      await assertNoBlockingViolations(page);
    });

    it("AC6 — color-contrast rule itself reports zero violations (real rendered pixels)", async () => {
      // A narrower, single-rule scan so a future contrast regression fails with
      // an unambiguous rule id even if the AC2 tag-based scan above is ever
      // loosened.
      await assertNoBlockingViolations(page, { rules: ["color-contrast"] });
    });

    it("AC4 — the search input has a real accessible name", async () => {
      const name = await page
        .locator("#q")
        .evaluate((el: Element) => el.getAttribute("aria-label"));
      expect(name).toBe("Filter components by name");
    });

    it("AC5 — every rendered iframe has a non-empty title", async () => {
      const titles = await page
        .locator("iframe")
        .evaluateAll((frames: Element[]) => frames.map((f) => f.getAttribute("title")));
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(title).toBeTruthy();
        expect(title?.trim()).not.toBe("");
      }
    });

    it("M7-02 AC15 — Tab order is search -> tree item 1 -> tree item 2 (roving tabindex)", async () => {
      await page.locator("#q").focus();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("q");

      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => ({
        role: document.activeElement?.getAttribute("role"),
        cls: document.activeElement?.className,
      }));
      expect(first.role).toBe("treeitem");
      expect(first.cls).toContain("browse-tree__item");

      // Roving tabindex means the SECOND Tab moves focus to the detail pane
      // (Refine button / metadata), not automatically the next tree row —
      // arrow-key navigation (asserted below) is how the tree itself is
      // walked (WAI-ARIA treeview pattern). This still proves iframes are
      // never a Tab stop.
      await page.keyboard.press("Tab");
      const second = await page.evaluate(() => document.activeElement?.tagName);
      expect(second).not.toBe("IFRAME");
    });

    it("M7-02 AC15 — ArrowDown moves roving focus to the next tree item and Enter selects it", async () => {
      await page.locator("#q").focus();
      await page.keyboard.press("Tab"); // -> first tree item
      await page.keyboard.press("ArrowDown");
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-component-name"),
      );
      expect(focused).toBeTruthy();

      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          page.evaluate(() => document.querySelector(".browse-breadcrumb")?.textContent ?? ""),
        )
        .toContain(focused ?? "");
    });
  },
);

// ── AC2/AC6 — populated Browse workbench, dark mode (AC7 coverage) ─────────

describe.skipIf(!chromiumAvailable)(
  "viewer chrome — axe-core scan (populated Browse workbench, dark mode / AC7)",
  () => {
    let root: string;
    let server: Server;
    let port: number;
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      root = await buildAuditRoot();
      server = serveDir(root);
      port = await listen(server);
      ({ context, page } = await newPage());
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`http://127.0.0.1:${port}/?route=browse`);
      await page.waitForSelector('[role="treeitem"]', { timeout: 5_000 });
    }, 30_000);

    afterAll(async () => {
      await context.close();
      await close(server);
      await rm(root, { recursive: true, force: true });
    });

    it("AC7 — the OS-dark palette is actually applied (color-scheme picked up the emulated preference)", async () => {
      // Sanity check that emulateMedia really flipped the page before trusting
      // a clean axe-core run as meaningful: read the computed --color-paper via
      // the *body* background, which should be the dark (~19% L) tone, not the
      // light (~98% L) one.
      //
      // Chromium's getComputedStyle serialization of an oklch()-declared color
      // is version-dependent: older/some builds resolve to `rgb(...)`, but the
      // Chromium this suite launches returns the color functional notation
      // verbatim — `oklch(0.19 0.006 60)` (note: 0-1 range, not `19%`) — since
      // browsers are not required to convert a CSS Color 4 function to legacy
      // rgb() syntax just because the computed-style getter is called. Handle
      // both serializations rather than assume either one.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      const oklchMatch = /oklch\(\s*([\d.]+%?)/.exec(bg);
      if (oklchMatch) {
        const raw = oklchMatch[1] as string;
        // L is either "0.19" (0-1 range) or "19%" (percentage range) depending
        // on serialization; normalize both to a 0-1 lightness before asserting.
        const lightness = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
        expect(lightness).toBeLessThan(0.3);
        return;
      }

      const rgbMatch = /rgb\((\d+), (\d+), (\d+)\)/.exec(bg);
      expect(rgbMatch, `expected an oklch(...) or rgb(...) background, got ${bg}`).not.toBeNull();
      const [, r, g, b] = rgbMatch as RegExpExecArray;
      expect(Number(r)).toBeLessThan(80);
      expect(Number(g)).toBeLessThan(80);
      expect(Number(b)).toBeLessThan(80);
    });

    it("AC2/AC7 — zero critical or serious violations in dark mode (iframes excluded)", async () => {
      await assertNoBlockingViolations(page);
    });

    it("AC6/AC7 (DRO-743) — dark-mode color-contrast rule reports zero violations", async () => {
      // The specific regression DRO-743 fixed (ink-3 3.80:1, clay-text 3.78:1,
      // both < 4.5:1 body-text AA) would surface here as a `color-contrast`
      // violation if it had regressed — this is the axe-core-level guard the
      // DRO-743 issue itself said M4-09 should provide.
      await assertNoBlockingViolations(page, { rules: ["color-contrast"] });
    });

    it("M7-02 AC15 — Tab order still holds in dark mode (search -> tree item, never an iframe)", async () => {
      await page.locator("#q").focus();
      await page.keyboard.press("Tab");
      const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      expect(role).toBe("treeitem");
    });
  },
);

// ── M7-03 (#235) — Review workspace responsive axe scans ───────────────────

describe.skipIf(!chromiumAvailable)("viewer chrome — axe-core scan (Review route)", () => {
  let root: string;
  let server: Server;
  let port: number;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    root = await buildAuditRoot();
    server = serveDir(root);
    port = await listen(server);
    ({ context, page } = await newPage());
  }, 30_000);

  afterAll(async () => {
    await context.close();
    await close(server);
    await rm(root, { recursive: true, force: true });
  });

  async function gotoReview(width: number, height: number): Promise<void> {
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${port}/?route=review`);
    await page.waitForSelector('#review-view:not([hidden]) [aria-label="Draft preview"]', {
      timeout: 5_000,
    });
  }

  it("M7-03 AC a11y — Review route empty state has zero critical/serious violations at 1440px full three-pane", async () => {
    await gotoReview(1440, 980);

    await assertNoBlockingViolations(page);
  });

  it("M7-03 AC a11y — Review route empty state has zero critical/serious violations at 900px collapsed conversation rail", async () => {
    await gotoReview(900, 800);
    await expect
      .poll(() =>
        page.locator("#review-rail-toggle").evaluate((el) => getComputedStyle(el).display),
      )
      .not.toBe("none");

    await assertNoBlockingViolations(page);
  });

  it("M7-03 AC a11y — Review route empty state has zero critical/serious violations at 480px segmented bottom-sheet layout", async () => {
    await gotoReview(480, 800);
    await expect
      .poll(() => page.locator("#review-segmented").evaluate((el) => getComputedStyle(el).display))
      .not.toBe("none");

    await assertNoBlockingViolations(page);
  });

  it("M7-03 AC a11y — Review route apply-confirm dialog has zero critical/serious violations", async () => {
    await gotoReview(900, 800);
    await page.evaluate(() => {
      const dialog = document.getElementById("apply-confirm");
      if (!dialog) throw new Error("missing #apply-confirm");
      dialog.hidden = false;
    });
    await page.locator("#apply-confirm-heading").focus();

    await assertNoBlockingViolations(page);
  });
});

// ── M7-03 (#235) — populated Review workspace, real host bridge ──────────────

describe.skipIf(!chromiumAvailable)(
  "viewer chrome — axe-core scan (populated Review route)",
  () => {
    let root: string;
    let server: Server;
    let port: number;

    beforeAll(async () => {
      root = await buildAuditRoot();
      await writeReviewHost(root);
      server = serveDir(root);
      port = await listen(server);
    }, 30_000);

    afterAll(async () => {
      await close(server);
      await rm(root, { recursive: true, force: true });
    });

    async function viewerFrame(page: Page): Promise<Frame> {
      await page.waitForSelector("#viewer-frame", { timeout: 5_000 });
      await expect
        .poll(() =>
          page.frames().some((candidate) => candidate.url().includes("/embedded-review.html")),
        )
        .toBe(true);
      const frame = page
        .frames()
        .find((candidate) => candidate.url().includes("/embedded-review.html"));
      if (!frame) throw new Error("missing #viewer-frame content frame");
      return frame;
    }

    async function gotoPopulatedReview(page: Page, width: number, height: number): Promise<Frame> {
      await page.setViewportSize({ width, height });
      await page.goto(`http://127.0.0.1:${port}/host.html`);
      const frame = await viewerFrame(page);
      await frame.waitForSelector("#kit-select:not(:disabled)", { timeout: 5_000 });
      await frame.fill("#generate-prompt", "A compact review status card with safe controls");
      await frame.waitForSelector("#conjure-button:not(:disabled)", { timeout: 5_000 });
      await frame.click("#conjure-button");
      await frame.waitForSelector("#review-view:not([hidden]) #draft-review:not([hidden])", {
        state: "attached",
        timeout: 5_000,
      });
      await frame.waitForSelector("#review-preview iframe", { state: "attached", timeout: 5_000 });
      await frame.waitForSelector('[data-check-id="schema"].check-item--pass', {
        state: "attached",
        timeout: 5_000,
      });
      await frame.waitForSelector("#review-controls:not([hidden]) input[type='range']", {
        state: "attached",
        timeout: 5_000,
      });
      return frame;
    }

    async function withPopulatedReview<T>(
      width: number,
      height: number,
      run: (page: Page, frame: Frame) => Promise<T>,
    ): Promise<T> {
      const { context, page } = await newPage();
      try {
        const frame = await gotoPopulatedReview(page, width, height);
        return await run(page, frame);
      } finally {
        await context.close();
      }
    }

    async function acknowledgeManualChecks(frame: Frame): Promise<void> {
      for (const id of ["visual-intent", "a11y-spot"]) {
        await frame.check(`[data-check-toggle="${id}"]`);
      }
    }

    async function approveDraft(frame: Frame): Promise<void> {
      await acknowledgeManualChecks(frame);
      await frame.click("#decision-approve");
      await expect
        .poll(() => frame.locator("#decision-approve").getAttribute("aria-pressed"))
        .toBe("true");
      await expect.poll(() => frame.locator("#apply-button").isDisabled()).toBe(false);
    }

    it("M7-03 AC a11y — Review route populated state has zero critical/serious violations at 1440px full three-pane", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        await assertNoBlockingViolationsInFrame(frame);
      });
    }, 30_000);

    it("M7-03 AC a11y — Review route populated state has zero critical/serious violations at 480px review bottom-sheet", async () => {
      await withPopulatedReview(480, 800, async (_page, frame) => {
        await frame.click("#review-segment-review");
        await expect
          .poll(() => frame.locator("#review-view").getAttribute("data-active-pane"))
          .toBe("review");

        await assertNoBlockingViolationsInFrame(frame);
      });
    }, 30_000);

    it("M7-03 AC a11y — populated Review after Approve has zero critical/serious violations and ungates Apply", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        await approveDraft(frame);

        await assertNoBlockingViolationsInFrame(frame);
      });
    }, 30_000);

    it("M7-03 AC keyboard — populated Review Tab order reaches Refine, Approve, and Apply", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        async function walk(from: string): Promise<string[]> {
          await frame.locator(from).focus();
          const reached: string[] = [];
          for (let i = 0; i < 24; i++) {
            await frame.page().keyboard.press("Tab");
            reached.push(
              await frame.evaluate(() => {
                const active = document.activeElement;
                if (!active) return "";
                return (
                  active.id ||
                  active.getAttribute("data-check-toggle") ||
                  active.textContent?.trim() ||
                  active.tagName
                );
              }),
            );
          }
          return reached;
        }

        // Apply is disabled until the draft is approved and Approve is
        // disabled once it is, so no single walk can reach all three. Walk
        // the pre-decision state first...
        const beforeApproval = await walk("#draft-name");
        expect(beforeApproval).toContain("refine-input");
        expect(beforeApproval).toContain("decision-approve");
        expect(beforeApproval).not.toContain("apply-button");

        // ...then approve and walk again to prove Apply has entered the tab
        // order, and that the now-disabled Approve has left it while still
        // reporting its pressed state to assistive tech.
        await approveDraft(frame);
        const afterApproval = await walk("#draft-name");
        expect(afterApproval).toContain("refine-input");
        expect(afterApproval).toContain("apply-button");
        expect(afterApproval).not.toContain("decision-approve");
        await expect
          .poll(() => frame.locator("#decision-approve").getAttribute("aria-pressed"))
          .toBe("true");
      });
    }, 30_000);

    it("M7-03 AC a11y — populated Review apply-confirm dialog opens the real way with focus inside and zero critical/serious violations", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        await approveDraft(frame);
        await frame.click("#apply-button");
        await frame.waitForSelector("#apply-confirm:not([hidden])", { timeout: 5_000 });
        await expect
          .poll(() => frame.evaluate(() => document.activeElement?.id))
          .toBe("apply-confirm-heading");

        await assertNoBlockingViolationsInFrame(frame);
      });
    }, 30_000);

    // ── Layout regressions (jsdom has no layout engine, so these only bite here) ──

    it("M7-03 — the conversation rail keeps a gutter so its eyebrow is not flush to the edge", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        const box = await frame.evaluate(() => {
          const rail = document.querySelector<HTMLElement>(".review-conversation");
          const eyebrow = rail?.querySelector<HTMLElement>(".eyebrow");
          if (!rail || !eyebrow) throw new Error("missing conversation rail eyebrow");
          return {
            railLeft: rail.getBoundingClientRect().left,
            eyebrowLeft: eyebrow.getBoundingClientRect().left,
          };
        });
        // A flush-left eyebrow reads as clipped against the viewport edge.
        expect(box.eyebrowLeft - box.railLeft).toBeGreaterThanOrEqual(12);
      });
    }, 30_000);

    it("M7-03 — a checklist detail wraps in the text column, not the 16px icon column", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        const widths = await frame.evaluate(() => {
          const detail = document.querySelector<HTMLElement>(".check-item__detail");
          if (!detail) throw new Error("expected at least one checklist detail");
          const label = detail
            .closest(".check-item")
            ?.querySelector<HTMLElement>(".check-item__label");
          if (!label) throw new Error("missing sibling label");
          return {
            detail: detail.getBoundingClientRect().width,
            label: label.getBoundingClientRect().width,
          };
        });
        // Auto-placement drops a third grid child into row 2 / column 1 (the icon
        // track), squeezing the detail to ~16px and wrapping it one word per line.
        expect(widths.detail).toBeGreaterThanOrEqual(widths.label * 0.9);
      });
    }, 30_000);
    it("M7-03 — draft summary values get the panel's full width instead of a starved second column", async () => {
      await withPopulatedReview(1440, 980, async (_page, frame) => {
        const box = await frame.evaluate(() => {
          const dl = document.querySelector<HTMLElement>("#draft-summary");
          const dd = dl?.querySelector<HTMLElement>("dd");
          if (!dl || !dd) throw new Error("missing populated draft summary");
          return {
            dl: dl.getBoundingClientRect().width,
            dd: dd.getBoundingClientRect().width,
          };
        });
        // Design 6 §02-preview-refine stacks label above value in this panel. A
        // `max-content` label track plus a 24px gap left only 78px for values,
        // wrapping every one of them across three lines.
        expect(box.dd).toBeGreaterThanOrEqual(box.dl * 0.9);
      });
    }, 30_000);

    // ── F40 (Copilot round 13) — WCAG 2.2 AA §1.4.10 Reflow names 320×256 CSS
    // px as the floor every surface must survive (400% zoom of 1280×1024), so
    // the short viewport below is the standard, not a contrived edge case. The
    // overlay is `position: fixed`: anything past the fold is not merely off
    // screen, it is unreachable, because scrolling the page behind the dialog
    // does not move the panel at all.
    it("M7-03 \u2014 the apply dialog stays reachable on a short viewport instead of clipping its controls", async () => {
      await withPopulatedReview(1024, 256, async (_page, frame) => {
        await approveDraft(frame);
        await frame.click("#apply-button");
        await frame.waitForSelector("#apply-confirm:not([hidden])", { timeout: 5_000 });

        const box = await frame.evaluate(() => {
          const panel = document.querySelector<HTMLElement>(".review-dialog__panel");
          const accept = document.getElementById("apply-confirm-accept");
          const cancel = document.getElementById("apply-confirm-cancel");
          if (!panel || !accept || !cancel) throw new Error("missing apply dialog controls");
          const edges = (el: Element) => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          };
          return {
            viewport: window.innerHeight,
            panel: edges(panel),
            accept: edges(accept),
            cancel: edges(cancel),
            overflows: panel.scrollHeight > panel.clientHeight,
            scrollable: /auto|scroll/.test(getComputedStyle(panel).overflowY),
          };
        });

        // The panel itself never leaves the overlay, and the overlay's
        // `--space-lg` gutter survives the bound — `100vh` would also stop the
        // spill, but by welding the panel to the viewport edges on exactly the
        // viewports that can least afford to lose the breathing room.
        expect(box.panel.top).toBeGreaterThanOrEqual(12);
        expect(box.panel.bottom).toBeLessThanOrEqual(box.viewport - 12);
        // Bounding it is only half the fix: whatever no longer fits has to
        // become reachable, or the clipping just moves inside the border.
        expect(box.overflows).toBe(true);
        expect(box.scrollable).toBe(true);

        // A new scroll container is a new a11y surface — axe fails one that no
        // keyboard user can reach. Scan the state the user lands in: scrolling
        // first would park the heading half outside the clip and reduce this to
        // an unresolvable-background "incomplete".
        await assertNoBlockingViolationsInFrame(frame);

        // ...and "reachable" is the assertion that actually bites. Without a
        // scroll container the page behind the fixed overlay scrolls instead,
        // which moves these controls by exactly 0px.
        await frame.locator("#apply-confirm-accept").scrollIntoViewIfNeeded();
        const reached = await frame.evaluate(() => {
          const accept = document.getElementById("apply-confirm-accept");
          const cancel = document.getElementById("apply-confirm-cancel");
          if (!accept || !cancel) throw new Error("missing apply dialog controls");
          const edges = (el: Element) => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          };
          return { viewport: window.innerHeight, accept: edges(accept), cancel: edges(cancel) };
        });
        expect(reached.accept.top).toBeGreaterThanOrEqual(0);
        expect(reached.accept.bottom).toBeLessThanOrEqual(reached.viewport);
        expect(reached.cancel.top).toBeGreaterThanOrEqual(0);
        expect(reached.cancel.bottom).toBeLessThanOrEqual(reached.viewport);
      });
    }, 30_000);

    // ── AC19 — the segmented pane control only EXISTS below 720px, so a
    // Tab-order assertion taken at 1440 physically cannot see it. Roving
    // tabindex means exactly one tab stop, and the inactive tab is reachable
    // only by arrow key: if the keydown handler is missing, that tab becomes
    // permanently unreachable for a keyboard user.
    it("M7-03 — the sub-720px pane tabs are reachable by keyboard, not just by pointer", async () => {
      await withPopulatedReview(480, 900, async (page, frame) => {
        const before = await frame.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-review-pane]"));
          if (tabs.length < 2) throw new Error("expected a segmented pane control below 720px");
          const active = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
          tabs[active].focus();
          return {
            active,
            tabIndexes: tabs.map((t) => t.tabIndex),
            focused: document.activeElement === tabs[active],
          };
        });
        expect(before.focused).toBe(true);
        // Exactly one tab stop — that is what makes the arrow keys load-bearing.
        expect(before.tabIndexes.filter((i) => i === 0)).toHaveLength(1);

        await page.keyboard.press("ArrowRight");

        const after = await frame.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-review-pane]"));
          const active = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
          return {
            active,
            focusedIsActive: document.activeElement === tabs[active],
            tabIndexes: tabs.map((t) => t.tabIndex),
          };
        });
        expect(after.active).not.toBe(before.active);
        // Selection alone is not enough: focus must follow, or the user is
        // left typing into a pane they cannot see.
        expect(after.focusedIsActive).toBe(true);
        expect(after.tabIndexes.filter((i) => i === 0)).toHaveLength(1);
      });
    }, 30_000);
  },
);

// ── AC6 — empty-state contrast (a real rendered surface with no cards) ─────

describe.skipIf(!chromiumAvailable)("viewer chrome — axe-core scan (empty manifest)", () => {
  let root: string;
  let server: Server;
  let port: number;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    root = await buildEmptyRoot();
    server = serveDir(root);
    port = await listen(server);
    ({ context, page } = await newPage());
    await page.goto(`http://127.0.0.1:${port}/?route=browse`);
    // M7-02 (#234) — an empty kit now renders the Browse tree's own CTA
    // ("Conjure your first component") rather than the M4 grid's `.ds-empty`.
    await page.waitForSelector(".browse-tree__empty", { timeout: 5_000 });
  }, 30_000);

  afterAll(async () => {
    await context.close();
    await close(server);
    await rm(root, { recursive: true, force: true });
  });

  it("AC2/AC6 — the empty state itself has zero critical/serious violations", async () => {
    // No cards/iframes exist in this fixture; assertNoBlockingViolations's
    // `.exclude(["iframe"])` is simply a no-op selector match here.
    await assertNoBlockingViolations(page);
  });
});
