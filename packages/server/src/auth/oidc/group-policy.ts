/**
 * Group-based access policy for external-OIDC-issued tokens (DRO-276 / M5-04).
 *
 * genie's existing OAuth server (M5-01, `packages/server/src/auth/oauth/*`)
 * self-issues HS256 bearer JWTs — it has no concept of an external Identity
 * Provider or group membership. This module adds the missing seam: given the
 * claims of a token that was actually issued by (or validated against) an
 * external OIDC provider, decide whether the caller is authorized to reach
 * genie's tool surface.
 *
 * The concrete rule (AC6 of DRO-276): callers whose token does not carry the
 * `genie-users` group in its `groups` claim are rejected with HTTP 403. This
 * is intentionally provider-agnostic — it operates on a decoded claims object,
 * not on any specific IdP's token format, so it is reusable regardless of
 * which OIDC provider an adopter points genie at (the M5-04 issue's stated
 * purpose: "acts as the template for adopters who bring their own provider").
 */

/** Claims shape this policy cares about. Extra claims are ignored. */
export interface OidcClaims {
  sub?: string;
  /** Group membership, as delivered by the IdP (custom claim, e.g. Keycloak's
   *  default groups mapper, Okta's Groups claim, etc.). Absent/empty means no
   *  group membership was asserted at all. */
  groups?: unknown;
  [key: string]: unknown;
}

/** The single group genie's OIDC integration test enforces (AC6). Exported so
 *  fixtures/tests can reference the same literal rather than duplicating it. */
export const REQUIRED_GROUP = "genie-users";

export class GroupAccessDeniedError extends Error {
  constructor(readonly requiredGroup: string) {
    super(`Access denied: caller is not a member of the "${requiredGroup}" group.`);
  }
}

/** Normalize a claims `groups` value into a string array. OIDC group claims
 *  are conventionally a JSON array of strings, but tolerate a single string
 *  (some IdPs emit a scalar when the caller has exactly one group) and treat
 *  anything else as "no groups". */
function normalizeGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

/**
 * Returns true if `claims` asserts membership in `requiredGroup` (defaults to
 * {@link REQUIRED_GROUP}).
 */
export function hasRequiredGroup(claims: OidcClaims, requiredGroup: string = REQUIRED_GROUP): boolean {
  return normalizeGroups(claims.groups).includes(requiredGroup);
}

/**
 * Enforce group membership. Throws {@link GroupAccessDeniedError} (callers map
 * this to HTTP 403) when `claims` does not carry `requiredGroup`.
 */
export function enforceGroupAccess(claims: OidcClaims, requiredGroup: string = REQUIRED_GROUP): void {
  if (!hasRequiredGroup(claims, requiredGroup)) {
    throw new GroupAccessDeniedError(requiredGroup);
  }
}
