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
 * ── Why the cross-origin AC5 case below is not redundant with the data: one ──
 * The original AC5 test ("cannot reassign top.location") uses a `data:` URL
 * card. This file's OWN next test proves `data:` iframes INHERIT the outer
 * document's CSP — so an unlisted inline `<script>` may never even START
 * running in that transport. The original test only asserts the outer URL didn't
 * change; it never confirms the card's script actually executed first. That
 * makes it possible for the assertion to pass for the WRONG reason (CSP
 * silently prevented the script from running at all) rather than the reason
 * AC5 actually names ("assert blocked by sandbox"). The production previews
 * transport (RFC §6/T-09) is a genuinely cross-origin `https://` host, which
 * does NOT inherit the shell's CSP (confirmed in this file's module doc) — so
 * a cross-origin card is the only scenario that isolates the sandbox as the
 * sole mechanism, independent of CSP. The tests below add that isolation: a
 * second, real `node:http` origin sending NO CSP of its own, confirming the
 * card's script DID run (via a side-channel `document.title`/global write)
 * before asserting the escalation itself was refused.
 *
 * ── Chromium-absent skip (mirrors packages/viewer/test/a11y.test.ts) ────────
 * Same self-skip probe as the a11y suite: this sandbox may not have the system
 * libraries Chromium needs, so we skip when Chromium can't launch. CI's
 * dedicated viewer-a11y job installs Chromium and sets
 * `GENIE_REQUIRE_CSP_BROWSER=1`, upgrading a silent skip to a loud failure —
 * the same "vacuous skip must fail somewhere" contract the a11y suite uses.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chromium } from "playwright";
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Manifest, ManifestCard } from "../manifest/index.js";
import {
  buildCspMeta,
  collectInlineCspHashes,
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
 * without pulling the full viewer runtime. This test is about the CSP +
 * sandbox, not grid rendering.
 */
const BASE_SHELL =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>' +
  '<body><main id="grid"></main></body></html>';

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
 * Serve a single HTML document. MCP resources/read cannot deliver HTTP
 * response headers; the real host constructs its own CSP from `_meta.ui.csp`.
 * These probes exercise genie's additional in-document meta directly.
 */
function serveOne(doc: string): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

/**
 * Serve `html` on its OWN, genuinely distinct `node:http` origin (a different
 * port is a different origin for same-hostname purposes here — same-site but
 * cross-origin is enough to prove the CSP does not leak across it; see the
 * module doc's cross-origin section), deliberately sending NO
 * `Content-Security-Policy` header of its own. Any containment observed
 * against a card served this way is attributable SOLELY to the iframe
 * `sandbox` attribute — this server never cooperates with a policy.
 */
async function serveCrossOriginHostileCard(
  html: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); // deliberately no CSP
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/card.html`,
    close: () => close(server),
  };
}

/** Collect every dialog opened by the page during `work()`, then dismiss it. */
async function collectDialogs<T>(
  page: Page,
  work: () => Promise<T>,
): Promise<{ dialogs: Dialog[]; result: T }> {
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
    const hostile = doc.replace("</body>", "<script>alert('inline-executed')</script></body>");
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

  it("the injected CSP meta is present in the delivered document", async () => {
    const doc = injectCspMeta(
      inlineManifest(BASE_SHELL, manifest([card()])),
      buildCspMeta(undefined),
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').count();
      expect(meta).toBe(1);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);
});

// ── AC5 — sandboxed iframe cannot navigate the top window ───────────────────

describe.skipIf(!chromiumAvailable)("M4-07 AC5 — sandbox blocks top-navigation", () => {
  it('an iframe with sandbox="allow-scripts" cannot reassign top.location', async () => {
    // A card iframe carries `sandbox="allow-scripts"` (viewer.js's createCard,
    // M4-03) — no `allow-same-origin`, no `allow-top-navigation`. From inside
    // that iframe, `top.location = "/pwned"` must be rejected: the browser
    // treats the iframe as an opaque origin and refuses top-nav.
    //
    // Build a document that contains one such iframe pointed at a data: URL
    // whose body script tries the escalation. If the sandbox fails, the outer
    // page's URL changes to `/pwned` and the test fails.
    const hostileScript = "try{top.location='/pwned'}catch(e){document.title='blocked:'+e.name}";
    const hostileCard = escapeJsonForScript(
      "data:text/html;base64," +
        Buffer.from(`<script>${hostileScript}</script>`, "utf8").toString("base64"),
    );
    // The `<iframe sandbox="allow-scripts">` markup, built the same way the
    // viewer would build it.
    const hashes = collectInlineCspHashes(`<script>${hostileScript}</script>`);
    const doc = injectCspMeta(BASE_SHELL, buildCspMeta(undefined, hashes)).replace(
      '<main id="grid"></main>',
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
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeDefined();
      expect(await frame!.title()).toMatch(/^blocked:/);
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("a data: card inherits the grid CSP and blocks an unlisted inline script", async () => {
    // Solo-dev card transport is `data:text/html;base64,…` (rewriteCardPaths
    // fallback). A `data:` iframe inherits the embedder's CSP — so the
    // outer grid's hash-only script-src must block an unlisted inline script
    // inside the framed data: document too.
    // The card's inline script tries to open an alert; if the inheritance
    // fails, we would see the dialog on the outer page.
    const dataUrl =
      "data:text/html;base64," +
      Buffer.from("<script>alert('framed-inline-executed')</script>", "utf8").toString("base64");
    const doc = injectCspMeta(BASE_SHELL, buildCspMeta(undefined)).replace(
      '<main id="grid"></main>',
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

  it("hashes preserve legitimate data-card script/style while event handlers stay blocked", async () => {
    const cardHtml =
      "<!doctype html><style>body{display:grid}</style><body>" +
      "<script>window.name='trusted-ran'</script>" +
      "<img src=x onerror=\"window.name='handler-ran'\">" +
      "</body>";
    const dataUrl = "data:text/html;base64," + Buffer.from(cardHtml, "utf8").toString("base64");
    const hashes = collectInlineCspHashes(cardHtml);
    const doc = injectCspMeta(BASE_SHELL, buildCspMeta(undefined, hashes)).replace(
      '<main id="grid"></main>',
      `<main id="grid"><iframe id="c" sandbox="allow-scripts" src="${dataUrl}"></iframe></main>`,
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForTimeout(250);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeDefined();
      expect(await frame!.evaluate(() => window.name)).toBe("trusted-ran");
      expect(await frame!.locator("body").evaluate((body) => getComputedStyle(body).display)).toBe(
        "grid",
      );
    } finally {
      await context.close();
      await close(server);
    }
  }, 30_000);

  it("a GENUINELY CROSS-ORIGIN card (no CSP of its own) still cannot reassign top.location — isolates the sandbox as the sole mechanism", async () => {
    // The `data:` test above (and the original top.location test) cannot rule
    // out CSP inheritance as the reason nothing happened — this test closes
    // that gap. The card is served from ITS OWN node:http origin, sending NO
    // `Content-Security-Policy` header at all, so the shell's policy cannot
    // reach it (confirmed elsewhere in this file: CSP does not leak across a
    // real origin boundary). This is also the shape production actually uses
    // — RFC §6/T-09's separate `previews.*` host, or simply a hostile/
    // uncooperative previews host that sends no CSP of its own.
    //
    // We prove the script executed (a `window.name` write) BEFORE asserting
    // the escalation failed — otherwise a silent no-op would be
    // indistinguishable from "successfully blocked". We read it back via
    // Playwright's `frame.evaluate()` (a CDP automation hook the TEST
    // harness has, not a same-origin-policy exemption `window.name` enjoys
    // in page JS — it does not) rather than via page script, so this
    // read-back is not itself evidence of an isolation gap.
    const cardHtml =
      "<!doctype html><html><body><script>" +
      "window.name = 'ran';" +
      "try { top.location = 'http://evil.example/pwned'; window.name = 'ran-nav-succeeded'; }" +
      "catch (e) { window.name = 'ran-blocked:' + e.name; }" +
      "</script></body></html>";
    const card = await serveCrossOriginHostileCard(cardHtml);
    // frame-src must legitimately allow the card's dynamic origin — mirrors
    // configuring GENIE_PREVIEWS_BASE_URL to that origin in production.
    const cspMeta = buildCspMeta(card.url);
    const doc = injectCspMeta(BASE_SHELL, cspMeta).replace(
      '<main id="grid"></main>',
      `<main id="grid"><iframe id="c" sandbox="allow-scripts" src="${card.url}"></iframe></main>`,
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.querySelectorAll("iframe").length > 0, {
        timeout: 5000,
      });
      await page.waitForTimeout(300);

      // The shell (parent) document itself must never have navigated away.
      expect(page.url()).toBe(`http://127.0.0.1:${port}/`);

      const frame = page.frames().find((f) => f.url() === card.url);
      expect(frame).toBeDefined();
      const name = await frame!.evaluate(() => window.name);
      // The script DID run (no CSP from this origin to block it) — proving
      // the assertions below are about the sandbox, not silent non-execution.
      expect(name.startsWith("ran")).toBe(true);
      // The AC only requires the navigation itself never succeeds — whether
      // the browser throws synchronously (SecurityError, the common case) or
      // silently no-ops the assignment is a browser-internal implementation
      // detail this test does not assume either way.
      expect(name).not.toBe("ran-nav-succeeded");
      // The card's own frame must also still be its original document — a
      // successful top-nav would have replaced the whole page, including the frame.
      expect(frame!.url()).toBe(card.url);
    } finally {
      await context.close();
      await close(server);
      await card.close();
    }
  }, 30_000);

  it("a GENUINELY CROSS-ORIGIN card's onerror=alert(1) never fires either (AC4, sandbox-isolated variant)", async () => {
    // Complements the AC4 tests above (which use the shell's own document /
    // an implicitly-CSP-covered transport). Here the card has NO cooperating
    // CSP of its own — sandbox alone must still prevent user-visible dialogs
    // (no `allow-modals`), independent of any script-src.
    const cardHtml =
      '<!doctype html><html><body><img src="x" onerror="window.name=\'pwned\';alert(1)" /></body></html>';
    const card = await serveCrossOriginHostileCard(cardHtml);
    const cspMeta = buildCspMeta(card.url);
    const doc = injectCspMeta(BASE_SHELL, cspMeta).replace(
      '<main id="grid"></main>',
      `<main id="grid"><iframe id="c" sandbox="allow-scripts" src="${card.url}"></iframe></main>`,
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { dialogs } = await collectDialogs(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(() => document.querySelectorAll("iframe").length > 0, {
          timeout: 5000,
        });
        await page.waitForTimeout(300);
      });
      const frame = page.frames().find((f) => f.url() === card.url);
      expect(frame).toBeDefined();
      const name = await frame!.evaluate(() => window.name);
      // The onerror handler DID run (no CSP from this origin) — the missing
      // dialog below is therefore attributable to `allow-modals` being absent
      // from the sandbox token list, not to the script never firing.
      expect(name).toBe("pwned");
      expect(dialogs.length).toBe(0);
    } finally {
      await context.close();
      await close(server);
      await card.close();
    }
  }, 30_000);

  it("an exact hash allows the trusted inline viewer script but not an injected neighbour", async () => {
    const trusted = "document.title='viewer-ran';";
    const hashes = collectInlineCspHashes(`<script>${trusted}</script>`);
    const doc = injectCspMeta(BASE_SHELL, buildCspMeta(undefined, hashes)).replace(
      "</body>",
      `<script>${trusted}</script><script>window.name='untrusted-ran'</script></body>`,
    );
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      const { errors } = await collectConsole(page, async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForTimeout(200);
      });
      expect(await page.title()).toBe("viewer-ran");
      expect(await page.evaluate(() => window.name)).toBe("");
      const cspErrors = errors.filter((e) => e.text().toLowerCase().includes("content security"));
      expect(cspErrors.length).toBeGreaterThan(0);
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
    const doc = "<!doctype html><html><head>" + cspMetaTag(meta) + "</head><body></body></html>";
    const server = serveOne(doc);
    const port = await listen(server);
    const { context, page } = await newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const found = await page.evaluate(() => {
        const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
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
