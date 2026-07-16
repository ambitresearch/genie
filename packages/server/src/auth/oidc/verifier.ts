/**
 * OIDC relying-party token verification (DRO-276 / M5-04).
 *
 * Complements `../oauth/*` (M5-01's self-issued authorization server): this
 * module lets genie ALSO act as an OIDC *relying party* against an adopter's
 * own external Identity Provider (Keycloak, Okta, Auth0, Authentik, etc.),
 * validating a bearer token that IdP issued rather than one genie minted
 * itself. The provider must expose OIDC discovery/JWKS, issue signed JWT
 * access tokens for the genie resource/API using the RFC 9068 `typ: at+jwt`
 * discriminator, and map group membership into a `groups` claim. Opaque
 * access tokens and OIDC ID tokens are not supported. Verification checks the
 * signature plus exact `iss`, configured `aud`, required RFC 9068 claims, and
 * token type before enforcing group membership.
 *
 * Configuration is opt-in via env, mirroring `resolveOAuthSigningKey`'s
 * "refuse to run without it" posture for `../oauth/config.ts`:
 *   - GENIE_OIDC_ISSUER   — the provider's issuer URL (used to derive its
 *     `/.well-known/openid-configuration` + JWKS endpoint).
 *   - GENIE_OIDC_AUDIENCE — the resource/API identifier expected in the
 *     access token's `aud` claim.
 * Both must be non-empty for OIDC RP mode to activate. When neither variable
 * is present the feature is disabled; a partial or empty configuration is a
 * startup error so an intended auth gate cannot fail open.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isIP } from "node:net";
import type { OidcClaims } from "./group-policy.js";
import { enforceGroupAccess, REQUIRED_GROUP } from "./group-policy.js";

export class MissingOidcConfigError extends Error {}

export interface OidcVerifierConfig {
  /** Provider issuer URL, e.g. `http://localhost:9944`. */
  issuer: string;
  /** Expected access-token `aud` claim for the genie resource/API. */
  audience: string;
  /** Group required for access (AC6). Defaults to `genie-users`. */
  requiredGroup?: string;
  /** OIDC discovery request timeout. Defaults to 10 seconds. */
  discoveryTimeoutMs?: number;
}

export interface OidcVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredGroup: string;
  /**
   * Verify `token`'s signature (against the provider's live JWKS), `typ:
   * at+jwt`, `iss`, `aud`, and mandatory RFC 9068 claims, THEN enforce group
   * membership (AC6). Returns the decoded claims on success. Throws on any
   * failure — signature failure, token-type/`iss`/`aud` mismatch, expiry, or
   * {@link GroupAccessDeniedError} (403) for a valid-but-ungrouped token.
   */
  verify(token: string): Promise<OidcClaims>;
}

/** Read {@link OidcVerifierConfig} from env. A missing or empty issuer or
 *  audience is invalid once either OIDC variable is present. */
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
  issuer?: string;
  jwks_uri?: string;
  [key: string]: unknown;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    (isIP(normalized) === 4 && normalized.split(".")[0] === "127") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function requireSecureOidcUrl(
  value: string,
  label: "issuer" | "jwks_uri",
  allowPlaintextLoopback: boolean,
): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error(`OIDC ${label} must not contain credentials or a fragment.`);
  }
  const allowedDevelopmentUrl =
    allowPlaintextLoopback && url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !allowedDevelopmentUrl) {
    throw new Error(`OIDC ${label} must use HTTPS unless it is a loopback development URL.`);
  }
  return url;
}

function enforceAccessTokenClaimTypes(claims: OidcClaims): void {
  for (const claim of ["sub", "client_id", "jti"] as const) {
    if (typeof claims[claim] !== "string") {
      throw new Error(`OIDC access token claim "${claim}" must be a string.`);
    }
  }
}

/** Fetch `${issuer}/.well-known/openid-configuration` and return its
 *  `jwks_uri` using the RFC 8414 / OIDC Discovery 1.0 endpoint required by
 *  this integration. */
async function discoverJwksUri(
  discoveryIssuer: string,
  expectedIssuer: string,
  timeoutMs: number,
  allowPlaintextLoopback: boolean,
): Promise<string> {
  const discoveryUrl = `${discoveryIssuer}/.well-known/openid-configuration`;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(discoveryUrl, { signal, redirect: "manual" });
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`OIDC discovery timed out after ${timeoutMs} ms: GET ${discoveryUrl}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: GET ${discoveryUrl} -> ${res.status}`);
  }
  const doc = (await res.json()) as OidcDiscoveryDocument;
  if (doc.issuer !== expectedIssuer) {
    throw new Error(
      `OIDC discovery issuer mismatch: expected ${expectedIssuer}, received ${String(doc.issuer)}.`,
    );
  }
  if (!doc.jwks_uri) {
    throw new Error(`OIDC discovery document at ${discoveryUrl} is missing jwks_uri.`);
  }
  requireSecureOidcUrl(doc.jwks_uri, "jwks_uri", allowPlaintextLoopback);
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
  const issuer = config.issuer;
  const issuerUrl = requireSecureOidcUrl(issuer, "issuer", true);
  const allowPlaintextLoopback = issuerUrl.protocol === "http:";
  const discoveryIssuer = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const discoveryTimeoutMs = config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  if (!Number.isFinite(discoveryTimeoutMs) || discoveryTimeoutMs <= 0) {
    throw new Error("discoveryTimeoutMs must be a positive finite number.");
  }
  const jwksUri = await discoverJwksUri(
    discoveryIssuer,
    issuer,
    discoveryTimeoutMs,
    allowPlaintextLoopback,
  );
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  const requiredGroup = config.requiredGroup ?? REQUIRED_GROUP;

  return {
    issuer,
    audience: config.audience,
    requiredGroup,
    async verify(token: string): Promise<OidcClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: config.audience,
        typ: "at+jwt",
        requiredClaims: ["exp", "sub", "client_id", "iat", "jti"],
      });
      const claims = payload as OidcClaims;
      enforceAccessTokenClaimTypes(claims);
      enforceGroupAccess(claims, requiredGroup);
      return claims;
    },
  };
}

/** Same as {@link createOidcVerifier}, but returns `undefined` only when both
 *  OIDC variables are absent. Partial or explicitly empty configuration is a
 *  startup error. */
export async function tryCreateOidcVerifier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OidcVerifier | undefined> {
  if (env.GENIE_OIDC_ISSUER === undefined && env.GENIE_OIDC_AUDIENCE === undefined) {
    return undefined;
  }
  return createOidcVerifier(resolveOidcConfig(env));
}
