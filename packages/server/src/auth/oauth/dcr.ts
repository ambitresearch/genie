import type { OAuthStore } from "./store.js";

export interface DcrRequestBody {
  redirect_uris?: unknown;
  client_name?: unknown;
  [key: string]: unknown;
}

export class DcrValidationError extends Error {}

/**
 * RFC 7591 Dynamic Client Registration (AC2). Accepts a DCR request body and
 * registers a new client, returning `{ client_id, client_secret,
 * client_secret_expires_at: 0 }` (non-expiring secret — no rotation in v1).
 */
export function registerDynamicClient(
  store: OAuthStore,
  body: DcrRequestBody,
): Record<string, unknown> {
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new DcrValidationError("redirect_uris is required and must be a non-empty array.");
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || uri.length === 0) {
      throw new DcrValidationError("Each redirect_uri must be a non-empty string.");
    }
  }
  const clientName = typeof body.client_name === "string" ? body.client_name : undefined;

  const client = store.registerClient(redirectUris as string[], clientName);
  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_secret_expires_at: client.client_secret_expires_at,
    redirect_uris: client.redirect_uris,
    client_name: client.client_name,
  };
}
