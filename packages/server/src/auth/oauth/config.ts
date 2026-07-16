/**
 * OAuth signing-key resolution (DRO-273 / M5-01).
 *
 * The server refuses to start OAuth-protected endpoints without a signing
 * key of adequate length — see Implementation Notes in the issue.
 */
export class MissingOAuthKeyError extends Error {}

export function resolveOAuthSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.OAUTH_HS256_KEY;
  if (key === undefined || key.length < 32) {
    throw new MissingOAuthKeyError(
      "OAUTH_HS256_KEY env var must be set to a string of at least 32 characters to enable OAuth.",
    );
  }
  return key;
}
