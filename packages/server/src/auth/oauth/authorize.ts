import type { OAuthStore } from "./store.js";

export interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export class AuthorizeError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

const SUPPORTED_SCOPES = ["read", "write"];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function validateAuthorizeRequest(store: OAuthStore, query: AuthorizeQuery): {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
} {
  if (query.response_type !== "code") {
    throw new AuthorizeError("response_type must be 'code'.");
  }
  if (!query.client_id) throw new AuthorizeError("client_id is required.");
  const client = store.getClient(query.client_id);
  if (client === undefined) throw new AuthorizeError("Unknown client_id.");
  if (!query.redirect_uri || !client.redirect_uris.includes(query.redirect_uri)) {
    throw new AuthorizeError("redirect_uri is missing or not registered for this client.");
  }
  if (query.code_challenge_method !== "S256" || !query.code_challenge) {
    throw new AuthorizeError("PKCE code_challenge with method S256 is required.");
  }
  const requestedScopes = (query.scope ?? "read").split(/\s+/).filter(Boolean);
  const scopes = requestedScopes.filter((s) => SUPPORTED_SCOPES.includes(s));
  if (scopes.length === 0) throw new AuthorizeError("No valid scopes requested.");

  return {
    clientId: query.client_id,
    redirectUri: query.redirect_uri,
    scopes,
    codeChallenge: query.code_challenge,
  };
}

/** AC3 — render the minimal server-rendered consent screen (GET /authorize). */
export function renderConsentScreen(store: OAuthStore, query: AuthorizeQuery): string {
  const { scopes } = validateAuthorizeRequest(store, query);
  const params = new URLSearchParams({
    response_type: query.response_type ?? "",
    client_id: query.client_id ?? "",
    redirect_uri: query.redirect_uri ?? "",
    scope: scopes.join(" "),
    state: query.state ?? "",
    code_challenge: query.code_challenge ?? "",
    code_challenge_method: query.code_challenge_method ?? "",
  });

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>genie — Authorize</title></head>
<body>
  <h1>Authorize access to genie</h1>
  <p>This application is requesting the following permissions:</p>
  <ul>
    ${scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n    ")}
  </ul>
  <form method="POST" action="/authorize">
    <input type="hidden" name="params" value="${escapeHtml(params.toString())}">
    <button type="submit" name="decision" value="allow">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>`;
}

/** AC3 — handle the consent decision (POST /authorize); returns the redirect URL. */
export function handleConsentDecision(
  store: OAuthStore,
  params: URLSearchParams,
  decision: string,
): string {
  const query: AuthorizeQuery = {
    response_type: params.get("response_type") ?? undefined,
    client_id: params.get("client_id") ?? undefined,
    redirect_uri: params.get("redirect_uri") ?? undefined,
    scope: params.get("scope") ?? undefined,
    state: params.get("state") ?? undefined,
    code_challenge: params.get("code_challenge") ?? undefined,
    code_challenge_method: params.get("code_challenge_method") ?? undefined,
  };
  const { clientId, redirectUri, scopes, codeChallenge } = validateAuthorizeRequest(store, query);

  const redirectUrl = new URL(redirectUri);
  if (decision !== "allow") {
    redirectUrl.searchParams.set("error", "access_denied");
    if (query.state) redirectUrl.searchParams.set("state", query.state);
    return redirectUrl.toString();
  }

  const code = store.issueAuthorizationCode({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  redirectUrl.searchParams.set("code", code);
  if (query.state) redirectUrl.searchParams.set("state", query.state);
  return redirectUrl.toString();
}
