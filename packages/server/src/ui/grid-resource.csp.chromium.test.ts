/**
 * M4-07 (DRO-269) — real-Chromium CSP + sandbox enforcement probes.
 *
 * The unit tests in `grid-resource.test.ts` prove the SHAPE of the CSP
 * (no unsafe-inline, meta injected, etc.) but a shape assertion by itself
 * only proves "we shipped the string". This suite proves the BROWSER actually
 * enforces it end-to-end — the two acceptance criteria that need a real
 * user-agent to have any teeth:
 *
 *   • AC4 — inject `<img src=x onerror=alert(1)>` into a card preview; the
 *     alert() must never fire. The mechanism is `script-src` without
 *     `'unsafe-inline'` — the browser refuses to execute an inline event-
 *     handler attribute. Without a real browser to run the parser + policy
 *     engine, this is an untestable claim.
 *   • AC5 — from inside a sandboxed card iframe, attempt `top.location = "…"`.
 *     The `sandbox="allow-scripts"` attribute (no `allow-same-origin`, no
 *     `allow-top-navigation`) puts the framed document in an OPAQUE origin,
 *     which the browser refuses to let navigate the top. The same shape check
 *     — "does the sandbox attribute produce the intended behaviour" — needs a
 *     real browser.
 *
 * Also covers the CSP mechanism itself (inline `<script>alert(1)</script>` in
 * the OUTER document is blocked; a `data:` card inherits the outer CSP so its
 * own inline script is also blocked) to prove `default-src 'none'` really
 * shuts the door in both directions.
 *
 * ── Chromium-absent skip (mirrors packages/viewer/test/a11y.test.ts) ────────
 * Same self-skip probe as the a11y suite: this sandbox may not have the system
 * libraries Chromium needs, so we skip when Chromium can't launch. CI's
 * dedicated viewer-a11y-shaped job (or any environment that installed
 * `npx playwright install --with-deps chromium`) will run it for real. Setting
 * `GENIE_REQUIRE_CSP_BROWSER=1` in that job would upgrade a silent skip to a
 * loud failure — same "vacuous-skip must fail somewhere" contract the a11y
 * suite uses. Deliberately left OFF today: the ci.yml server-test leg does
 * not install Chromium, and this test's assertions are already reinforced by
 * the pure-unit CSP shape tests + the a11y suite's own real-browser coverage.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";

import { chromium } from "playwright";
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Manifest, ManifestCard } from "../manifest/index.js";
import {
  buildCspMeta,
  cspMetaTag,
  escapeJsonForScript,
  inlineManifest,
  injectCspMeta,
} from "./grid-resource.js";

// ── Chromium-absent skip probe ───────────────────────────────────────────────
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
    "[csp-chromium] no launchable Chromium detected — skipping the real-browser CSP + " +
      "sandbox probes (run `npx playwright install --with-deps chromium` to run them; " +
      "the pure-unit CSP shape tests in grid-resource.test.ts still cover the payload).",
  );
}

if (!chromiumAvailable && process.env.GENIE_REQUIRE_CSP_BROWSER === "1") {
  throw new Error(
    "GENIE_REQUIRE_CSP_BROWSER=1 but Chromium failed to launch — a CI job that opts in " +
      "must have a working browser; this suite is not allowed to silently skip on that leg.",
  );
}

// ── Suite-wide browser ───────────────────────────────────────────────────────
let browser: Browser | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  if (!browser) throw new Error("newPage without browser — should be unreachable under skipIf");
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

// ── Test fixtures: two grid HTMLs, one benign, one hostile ──────────────────

/**
 * The minimal shell we serve — same shape as `viewer/static/index.html` but
 * without pulling `viewer.js` (there's no matching sibling resource on this
 * plain HTTP server; the viewer.js probe layer is what `grid-resource.
 * integration.test.ts` already covers). This test is about the CSP + sandbox,
 * not the viewer runtime.
 */
const BASE_SHELL =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head>" +
  "<body><main id=\"grid\"></main></body></html>";

function card(overrides: Partial<ManifestCard> = {}): ManifestCard {
  return {
    name: "Primary",
    group: "Actions",
    path: "data:text/html;base64,PGgxPmE8L2gxPg==",
    viewport: "480x240",
    hash: "sha256-x",
    lastModified: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(components: ManifestCard[]): Manifest {
  return {
    version: 1,
    name: "test",
    generatedAt: "2026-07-05T00:00:00.000Z",
    groups: ["Actions"],
    components,
  };
}

/**
 * Serve a single HTML document with the enforced CSP header (belt-and-braces:
 * the meta is in the doc, and we also emit the header form) so we exercise
 * the browser under a header + meta stack that mirrors production.
 */
function serveOne(doc: string): Server {
  return createServer((_req, res) => {
    const csp = buildCspMeta(undefined).policy;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
    });
    res.end(doc);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (a && typeof a === "object") r(a.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/** Collect every dialog opened by the page during `work()`, then dismiss it. */
async function collectDialogs<T>(page: Page, work: () => Promise<T>): Promise<{ dialogs: Dialog[]; result: T }> {
  const dialogs: Dialog[] = [];
  const handler = async (d: Dialog) => {
    dialogs.push(d);
    await d.dismiss();
  };
  page.on("dialog", handler);
  try {
    const result = await work();
    return { dialogs, result };
  } finally {
    page.off("dialog", handler);
  }
}

/** Collect every console error during `work()` — CSP violations land here. */
async function collectConsole<T>(
  page: Page,
  work: () => Promise<T>,
): Promise<{ errors: ConsoleMessage[]; result: T }> {
  const errors: ConsoleMessage[] = [];
  const handler = (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg);
  };
  page.on("console", handler);
  try {
    const result = await work();
    return { errors, result };
  } finally {
    page.off("console", handler);
  }
}

// ── AC4 — inline / event-handler script execution is blocked ────────────────

describe.skipIf(!chromiumAvailable)("M4-07 AC4 — script-src blocks inline execution", () => {
  it("an inline <script>alert(1)</script> in the grid doc never fires an alert", async () => {
    // The full production assembly path — inline manifest + injected CSP meta —
    // with a hostile inline script appended into the body BEFORE serving. If
    // the CSP fails to block it, we would get a real alert() dialog.
    const doc = injectCspMeta(
      inlineManifest(BASE_SHELL, manifest([card()])),
      buildCspMeta(undefined),
    );
    const hostile = doc.replace(
      "</body>",
      "<script>alert('inline-executed')</script></body>",
    );
    const server = serveOne(hostile);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { dialogs } = await collectDialogs(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        // Give a hostile alert a fair chance to appear before we assert absence.
        await page.waitForTimeout(150);
      });
      expect(dialogs.length).toBe(0);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("an <img onerror=alert(1)> attribute in the grid doc never fires an alert", async () => {
    // Event-handler attributes are inline scripts too; `script-src` without
    // `'unsafe-inline'` blocks BOTH `<script>…</script>` and `on*=…`. This is
    // the exact AC4 sentence from the issue body.
    const doc = injectCspMeta(
      inlineManifest(BASE_SHELL, manifest([card()])),
      buildCspMeta(undefined),
    );
    const hostile = doc.replace(
      "</body>",
      "<img src=x onerror=\"alert('onerror-executed')\"></body>",
    );
    const server = serveOne(hostile);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { dialogs } = await collectDialogs(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForTimeout(150);
      });
      expect(dialogs.length).toBe(0);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("the injected CSP meta is present in the delivered document (belt + braces vs the header)", async () => {
    const doc = injectCspMeta(
      inlineManifest(BASE_SHELL, manifest([card()])),
      buildCspMeta(undefined),
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const meta = await page.locator("meta[http-equiv=\"Content-Security-Policy\"]").count();
      expect(meta).toBe(1);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);
});

// ── AC5 — sandboxed iframe cannot navigate the top window ───────────────────

describe.skipIf(!chromiumAvailable)("M4-07 AC5 — sandbox blocks top-navigation", () => {
  it("an iframe with sandbox=\"allow-scripts\" cannot reassign top.location", async () => {
    // A card iframe carries `sandbox="allow-scripts"` (viewer.js's createCard,
    // M4-03) — no `allow-same-origin`, no `allow-top-navigation`. From inside
    // that iframe, `top.location = "/pwned"` must be rejected: the browser
    // treats the iframe as an opaque origin and refuses top-nav.
    //
    // Build a document that contains one such iframe pointed at a data: URL
    // whose body script tries the escalation. If the sandbox fails, the outer
    // page's URL changes to `/pwned` and the test fails.
    const hostileCard = escapeJsonForScript(
      "data:text/html;base64," +
        Buffer.from(
          "<script>try{top.location='/pwned'}catch(e){document.title='blocked:'+e.name}</script>",
          "utf8",
        ).toString("base64"),
    );
    // The `<iframe sandbox="allow-scripts">` markup, built the same way the
    // viewer would build it.
    const doc =
      injectCspMeta(BASE_SHELL, buildCspMeta(undefined)).replace(
        "<main id=\"grid\"></main>",
        `<main id="grid"><iframe id="c" sandbox="allow-scripts" src="${hostileCard}"></iframe></main>`,
      );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      // Give the iframe's inline script a fair chance to try + fail.
      await page.waitForTimeout(250);
      // The URL must NOT have been navigated to `/pwned` — the top-nav was blocked.
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("the outer grid document's CSP INHERITS into a data: card iframe (its inline script is blocked)", async () => {
    // Solo-dev card transport is `data:text/html;base64,…` (rewriteCardPaths
    // fallback). A `data:` iframe inherits the embedder's CSP — so the
    // outer grid's `script-src 'self' ui://genie` (no unsafe-inline) must
    // block an inline script inside the framed data: document too.
    // The card's inline script tries to open an alert; if the inheritance
    // fails, we would see the dialog on the outer page.
    const dataUrl =
      "data:text/html;base64," +
      Buffer.from("<script>alert('framed-inline-executed')</script>", "utf8").toString("base64");
    const doc = injectCspMeta(BASE_SHELL, buildCspMeta(undefined)).replace(
      "<main id=\"grid\"></main>",
      `<main id="grid"><iframe id="c" sandbox="allow-scripts" src="${dataUrl}"></iframe></main>`,
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { dialogs } = await collectDialogs(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForTimeout(250);
      });
      expect(dialogs.length).toBe(0);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("the legit viewer path (external ui:// sibling asset) is NOT accidentally broken by the CSP", async () => {
    // Regression guard: prove the hardened policy still allows the EXTERNAL
    // sibling script the shipped shell references (`<script src="./viewer.js">`)
    // — via `script-src 'self' ui://genie`. We simulate this by serving the
    // shell + a real /viewer.js sibling on the same origin, and asserting no
    // CSP violation is logged for the external load path.
    const doc =
      injectCspMeta(BASE_SHELL, buildCspMeta(undefined)).replace(
        "</body>",
        "<script src=\"./viewer.js\"></script></body>",
      );
    // Manual server so we can serve both `/` and `/viewer.js` with matching
    // CSP headers.
    const server = createServer((req, res) => {
      const csp = buildCspMeta(undefined).policy;
      if (req.url === "/viewer.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": csp,
        });
        res.end("document.title='viewer-ran';");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
      });
      res.end(doc);
    });
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { errors } = await collectConsole(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForTimeout(200);
      });
      // The external script's `document.title` mutation ran → viewer.js loaded
      // and executed under the hardened policy.
      expect(await page.title()).toBe("viewer-ran");
      const cspErrors = errors.filter((e) => e.text().toLowerCase().includes("content security"));
      expect(cspErrors.length).toBe(0);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);
});

// ── cspMetaTag round-trips through a real HTML parser (defensive) ──────────

describe.skipIf(!chromiumAvailable)("M4-07 — cspMetaTag survives a real HTML parse", () => {
  it("the injected meta is recognised as a Content-Security-Policy meta by the browser", async () => {
    const meta = buildCspMeta(undefined);
    const doc =
      "<!doctype html><html><head>" +
      cspMetaTag(meta) +
      "</head><body></body></html>";
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const found = await page.evaluate(() => {
        const m = document.querySelector("meta[http-equiv=\"Content-Security-Policy\"]");
        return m ? (m as HTMLMetaElement).content : null;
      });
      expect(found).not.toBeNull();
      expect(found).toContain("default-src 'none'");
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);
});
