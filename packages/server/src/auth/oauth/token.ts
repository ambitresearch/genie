import type { OAuthStore } from "./store.js";
import { signJwtHS256 } from "./jwt.js";

export interface TokenRequestBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly error: string = "invalid_request",
  ) {
    super(message);
  }
}

const ACCESS_TOKEN_TTL_SECONDS = 3600;

function authenticateClient(store: OAuthStore, body: TokenRequestBody): string {
  if (!body.client_id) throw new TokenError("client_id is required.", "invalid_client");
  const client = store.getClient(body.client_id);
  if (client === undefined) throw new TokenError("Unknown client_id.", "invalid_client");
  // Public clients (PKCE, no secret registered at DCR-issue time under `none` auth) may omit
  // client_secret; confidential clients must present the one issued at registration.
  if (body.client_secret !== undefined && body.client_secret !== client.client_secret) {
    throw new TokenError("Invalid client_secret.", "invalid_client");
  }
  return client.client_id;
}

function issueTokenResponse(
  store: OAuthStore,
  signingKey: string,
  clientId: string,
  scope: string,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwtHS256(
    {
      sub: clientId,
      client_id: clientId,
      scope,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    },
    signingKey,
  );
  const refreshToken = store.issueRefreshToken(clientId, scope);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

/**
 * AC4/AC5 — `/token`. Supports `authorization_code` (with PKCE verifier) and
 * `refresh_token` grants. Returns a signed HS256 JWT access token.
 */
export function handleTokenRequest(
  store: OAuthStore,
  signingKey: string,
  body: TokenRequestBody,
): Record<string, unknown> {
  if (body.grant_type === "authorization_code") {
    const clientId = authenticateClient(store, body);
    if (!body.code) throw new TokenError("code is required.");
    if (!body.redirect_uri) throw new TokenError("redirect_uri is required.");
    if (!body.code_verifier) throw new TokenError("code_verifier is required.");

    const record = store.consumeAuthorizationCode({
      code: body.code,
      client_id: clientId,
      redirect_uri: body.redirect_uri,
      code_verifier: body.code_verifier,
    });
    if (record === undefined) {
      throw new TokenError("Invalid or expired authorization code.", "invalid_grant");
    }

    return issueTokenResponse(store, signingKey, clientId, record.scope);
  }

  if (body.grant_type === "refresh_token") {
    const clientId = authenticateClient(store, body);
    if (!body.refresh_token) throw new TokenError("refresh_token is required.");
    const record = store.consumeRefreshToken(body.refresh_token, clientId);
    if (record === undefined) {
      throw new TokenError("Invalid refresh token.", "invalid_grant");
    }
    return issueTokenResponse(store, signingKey, clientId, record.scope);
  }

  throw new TokenError(
    `Unsupported grant_type '${String(body.grant_type)}'.`,
    "unsupported_grant_type",
  );
}
