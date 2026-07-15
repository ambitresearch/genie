/**
 * OIDC relying-party token verification (DRO-276 / M5-04).
 *
 * Complements `../oauth/*` (M5-01's self-issued authorization server): this
 * module lets genie ALSO act as an OIDC *relying party* against an adopter's
 * own external Identity Provider (Keycloak, Okta, Auth0, Authentik, etc.),
 * validating a bearer token that IdP issued rather than one genie minted
 * itself. Verification is standards-based (RS256 JWT signed by the IdP,
 * verified against its published JWKS, `iss`/`aud`/`exp` all checked) so any
 * spec-compliant OIDC provider works, not just the one this issue's
 * integration test happens to spin up.
 *
 * Configuration is opt-in via env, mirroring `resolveOAuthSigningKey`'s
 * "refuse to run without it" posture for `../oauth/config.ts`:
 *   - GENIE_OIDC_ISSUER   — the provider's issuer URL (used to derive its
 *     `/.well-known/openid-configuration` + JWKS endpoint).
 *   - GENIE_OIDC_AUDIENCE — the `aud` claim genie's tokens must carry
 *     (typically the OAuth client_id registered with the provider).
 * Both must be set for OIDC RP mode to activate; `createOidcVerifier` throws
 * {@link MissingOidcConfigError} otherwise so callers can no-op cleanly (see
 * `tryCreateOidcVerifier`), exactly as `tryCreateOAuthRouter` does for the
 * self-issued OAuth path.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcClaims } from "./group-policy.js";
import { enforceGroupAccess, REQUIRED_GROUP } from "./group-policy.js";

export class MissingOidcConfigError extends Error {}

export interface OidcVerifierConfig {
  /** Provider issuer URL, e.g. `http://localhost:9944`. */
  issuer: string;
  /** Expected `aud` claim (the registered client_id). */
  audience: string;
  /** Group required for access (AC6). Defaults to `genie-users`. */
  requiredGroup?: string;
}

export interface OidcVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredGroup: string;
  /**
   * Verify `token`'s signature (against the provider's live JWKS), `iss`,
   * `aud`, and expiry, THEN enforce group membership (AC6). Returns the
   * decoded claims on success. Throws on any failure — signature failure,
   * `iss`/`aud` mismatch, expiry, or {@link GroupAccessDeniedError} (403) for
   * a valid-but-ungrouped token.
   */
  verify(token: string): Promise<OidcClaims>;
}

/** Read {@link OidcVerifierConfig} from env. Missing/empty issuer or audience
 *  means OIDC RP mode is not configured (not an error by itself — the caller
 *  decides via {@link tryCreateOidcVerifier} vs {@link createOidcVerifier}). */
export function resolveOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcVerifierConfig {
  const issuer = env.GENIE_OIDC_ISSUER;
  const audience = env.GENIE_OIDC_AUDIENCE;
  if (!issuer || !audience) {
    throw new MissingOidcConfigError(
      "GENIE_OIDC_ISSUER and GENIE_OIDC_AUDIENCE must both be set to enable OIDC relying-party mode.",
    );
  }
  return { issuer, audience, requiredGroup: env.GENIE_OIDC_REQUIRED_GROUP || REQUIRED_GROUP };
}

interface OidcDiscoveryDocument {
  jwks_uri?: string;
  [key: string]: unknown;
}

/** Fetch `${issuer}/.well-known/openid-configuration` and return its
 *  `jwks_uri` — the RFC 8414 / OIDC Discovery 1.0 standard path every
 *  spec-compliant provider (Keycloak, Okta, Auth0, Authentik, node-oidc-
 *  provider, ...) serves, so this is provider-agnostic by construction. */
async function discoverJwksUri(issuerUrl: string): Promise<string> {
  const discoveryUrl = `${issuerUrl}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: GET ${discoveryUrl} -> ${res.status}`);
  }
  const doc = (await res.json()) as OidcDiscoveryDocument;
  if (!doc.jwks_uri) {
    throw new Error(`OIDC discovery document at ${discoveryUrl} is missing jwks_uri.`);
  }
  return doc.jwks_uri;
}

/**
 * Build a verifier bound to a live provider's JWKS. The provider's `jwks_uri`
 * is resolved once via OIDC discovery; the returned JWK set is fetched lazily
 * and cached across calls by `jose`'s `createRemoteJWKSet` (in-flight
 * de-duplication + background re-fetch on unknown `kid` — no manual caching
 * needed here).
 */
export async function createOidcVerifier(config: OidcVerifierConfig): Promise<OidcVerifier> {
  const issuerUrl = config.issuer.endsWith("/") ? config.issuer.slice(0, -1) : config.issuer;
  const jwksUri = await discoverJwksUri(issuerUrl);
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  const requiredGroup = config.requiredGroup ?? REQUIRED_GROUP;

  return {
    issuer: issuerUrl,
    audience: config.audience,
    requiredGroup,
    async verify(token: string): Promise<OidcClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: issuerUrl,
        audience: config.audience,
      });
      const claims = payload as OidcClaims;
      enforceGroupAccess(claims, requiredGroup);
      return claims;
    },
  };
}

/** Same as {@link createOidcVerifier}, but returns `undefined` (feature
 *  disabled) instead of throwing when OIDC RP mode isn't configured — the
 *  same "opt-in, never crash a caller that hasn't set this up" contract
 *  `tryCreateOAuthRouter` gives the self-issued OAuth path. */
export async function tryCreateOidcVerifier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OidcVerifier | undefined> {
  try {
    return await createOidcVerifier(resolveOidcConfig(env));
  } catch (error) {
    if (error instanceof MissingOidcConfigError) return undefined;
    throw error;
  }
}
