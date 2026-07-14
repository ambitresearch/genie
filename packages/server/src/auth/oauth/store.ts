import { randomBytes, createHash, randomUUID } from "node:crypto";

/**
 * In-memory OAuth state store (DRO-273 / M5-01).
 *
 * Scope: a single running genie process. Clients, auth codes, and refresh
 * tokens do not survive a restart — acceptable for the MCP-server-per-launch
 * model (each `claude mcp add` / `codex mcp login` re-runs DCR against a
 * freshly started server). Not shared across processes; do not point two
 * server instances at the same client_id.
 */

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_secret_expires_at: 0;
  redirect_uris: string[];
  client_name?: string;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  expiresAt: number;
  consumed: boolean;
}

export interface RefreshTokenRecord {
  token: string;
  client_id: string;
  scope: string;
}

const AUTH_CODE_TTL_MS = 60_000;

export class OAuthStore {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
    const client: RegisteredClient = {
      client_id: randomUUID(),
      client_secret: randomBytes(32).toString("base64url"),
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      client_name: clientName,
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  issueAuthorizationCode(input: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string;
    code_challenge_method: "S256";
  }): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      code,
      ...input,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      consumed: false,
    });
    return code;
  }

  /** Consume (single-use) an authorization code, verifying PKCE. Returns undefined if invalid. */
  consumeAuthorizationCode(input: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
  }): AuthorizationCode | undefined {
    const record = this.codes.get(input.code);
    if (record === undefined) return undefined;
    this.codes.delete(input.code);
    if (record.consumed) return undefined;
    if (record.expiresAt < Date.now()) return undefined;
    if (record.client_id !== input.client_id) return undefined;
    if (record.redirect_uri !== input.redirect_uri) return undefined;

    const expectedChallenge = createHash("sha256").update(input.code_verifier).digest("base64url");
    if (expectedChallenge !== record.code_challenge) return undefined;

    return record;
  }

  issueRefreshToken(clientId: string, scope: string): string {
    const token = randomBytes(32).toString("base64url");
    this.refreshTokens.set(token, { token, client_id: clientId, scope });
    return token;
  }

  consumeRefreshToken(token: string, clientId: string): RefreshTokenRecord | undefined {
    const record = this.refreshTokens.get(token);
    if (record === undefined || record.client_id !== clientId) return undefined;
    this.refreshTokens.delete(token);
    return record;
  }
}
