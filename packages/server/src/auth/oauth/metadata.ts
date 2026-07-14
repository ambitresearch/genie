export interface OAuthMetadataOptions {
  issuer: string;
}

/**
 * RFC 8414 Authorization Server Metadata (AC1). Served at
 * `/.well-known/oauth-authorization-server`.
 */
export function buildAuthorizationServerMetadata(opts: OAuthMetadataOptions): Record<string, unknown> {
  const { issuer } = opts;
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  };
}
