import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  isValidInteractionUid,
  renderLoginForm,
} from "./support/oidc-provider-image/interaction-view.mjs";

/**
 * The OIDC fixture reflects the interaction uid straight out of `req.url` into
 * the login form's `action` attribute. oidc-provider only ever issues URL-safe
 * random ids, so the fixture both rejects anything else and escapes at the
 * interpolation site — either barrier alone closes the hole, and having both
 * documents the contract.
 */
describe("isValidInteractionUid", () => {
  it("accepts the URL-safe ids oidc-provider issues", () => {
    for (const uid of ["abc123", "a_b-C9", "Zm9vYmFy"]) {
      expect(isValidInteractionUid(uid)).toBe(true);
    }
  });

  it("rejects anything outside the URL-safe alphabet", () => {
    for (const uid of ['"><script>alert(1)</script>', "../../etc/passwd", "a b", "a.b", ""]) {
      expect(isValidInteractionUid(uid)).toBe(false);
    }
  });

  it("rejects non-string input", () => {
    expect(isValidInteractionUid(undefined)).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes ampersands first so entities are not double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("renderLoginForm", () => {
  /** Pins the markup packages/e2e/test/m5-oidc.test.ts drives in Playwright. */
  it("renders the form the browser fills in", () => {
    const html = renderLoginForm("aVal1d_uid-9");
    expect(html).toContain('action="/interaction/aVal1d_uid-9/login"');
    expect(html).toContain('<input name="username" />');
    expect(html).toContain('<input name="password" type="password" />');
  });

  it("escapes a uid that tries to break out of the action attribute", () => {
    const html = renderLoginForm('"><script>alert(1)</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain(
      'action="/interaction/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/login"',
    );
  });
});
