// Pure rendering + validation helpers for the OIDC fixture's interaction view.
// Split out of server.mjs so they can be unit-tested without oidc-provider,
// which is installed only inside the fixture's Docker image.

/**
 * oidc-provider issues interaction uids as URL-safe random ids, so anything
 * outside this alphabet is a malformed or hostile request rather than a
 * legitimate interaction.
 */
const INTERACTION_UID = /^[A-Za-z0-9_-]+$/;

/** @param {unknown} uid @returns {boolean} */
export function isValidInteractionUid(uid) {
  return typeof uid === "string" && INTERACTION_UID.test(uid);
}

/**
 * Escape the five HTML-significant characters. `&` goes first so the entities
 * introduced below are not escaped a second time.
 *
 * @param {string} value @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal login form. The uid is reflected from the request URL, so it is
 * escaped here even though callers reject non-URL-safe uids up front.
 *
 * @param {string} uid @returns {string}
 */
export function renderLoginForm(uid) {
  return `
        <html><body>
          <form method="POST" action="/interaction/${escapeHtml(uid)}/login">
            <input name="username" />
            <input name="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </body></html>
      `;
}
