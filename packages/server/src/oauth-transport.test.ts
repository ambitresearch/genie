import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStreamableHttpRequestHandler } from "./transport.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { JwtVerificationError, signJwtHS256, verifyJwtHS256 } from "./auth/oauth/jwt.js";
import { createOAuthRouter } from "./auth/oauth/router.js";

/**
 * Integration test for DRO-273 (M5-01): OAuth 2.0 + Dynamic Client
 * Registration end-to-end against a real HTTP server, exercising the exact
 * flow Claude Code / Codex CLI drive: DCR -> authorize (consent) -> token
 * (with PKCE) -> bearer-protected /mcp -> refresh.
 */
describe("OAuth 2.0 + Dynamic Client Registration (DRO-273)", () => {
  const SIGNING_KEY = "a".repeat(32);
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    process.env.OAUTH_HS256_KEY = SIGNING_KEY;
    const handler = createStreamableHttpRequestHandler(() => createServer_stubMcpServer(), {
      oauthIssuer: "http://127.0.0.1:0",
    });
    const server = createNodeHttpServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await close();
  });

  function createNodeHttpServer(handler: RequestListener) {
    return createServer(handler);
  }

  // Minimal stub matching the McpServer surface transport.ts touches for a session-created factory.
  function createServer_stubMcpServer(): McpServer {
    return {
      server: { onclose: undefined },
      connect: async () => undefined,
    } as unknown as McpServer;
  }

  it("AC1: serves RFC 8414 metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registration_endpoint).toContain("/register");
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/token");
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["read", "write"]));
  });

  it("AC2: DCR /register returns client_id/client_secret", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeTruthy();
    expect(body.client_secret_expires_at).toBe(0);
  });

  it("AC3-AC5: full authorize + PKCE token round trip issues a valid HS256 JWT", async () => {
    const redirectUri = "http://127.0.0.1:9999/callback";
    const dcrRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    const { client_id, client_secret } = await dcrRes.json();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirectUri,
      scope: "read write",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const consentRes = await fetch(`${baseUrl}/authorize?${authorizeParams.toString()}`);
    expect(consentRes.status).toBe(200);
    const html = await consentRes.text();
    expect(html).toContain("read");
    expect(html).toContain("write");

    const decisionRes = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        decision: "allow",
        params: authorizeParams.toString(),
      }).toString(),
    });
    expect(decisionRes.status).toBe(302);
    const location = new URL(decisionRes.headers.get("location")!);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id,
        client_secret,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.refresh_token).toBeTruthy();

    const payload = verifyJwtHS256(tokenBody.access_token, SIGNING_KEY);
    expect(payload.scope).toBe("read write");
    expect(payload.client_id).toBe(client_id);

    // refresh_token grant round-trips too
    const refreshRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
        client_id,
        client_secret,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);

    const replayedRefreshRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
        client_id,
        client_secret,
      }).toString(),
    });
    expect(replayedRefreshRes.status).toBe(400);
  });

  it.each(["javascript:alert(1)", "data:text/html,hello"])(
    "rejects unsafe DCR redirect URI %s",
    async (redirectUri) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_client_metadata" });
    },
  );

  it("rejects a correctly signed JWT with a non-HS256 algorithm header", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtHS256(
      { sub: "user", client_id: "client", scope: "read", iat: now, exp: now + 60 },
      SIGNING_KEY,
    );
    const [, encodedPayload] = token.split(".");
    const encodedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = createHmac("sha256", SIGNING_KEY).update(signingInput).digest("base64url");

    expect(() => verifyJwtHS256(`${signingInput}.${signature}`, SIGNING_KEY)).toThrow(
      JwtVerificationError,
    );
  });

  it.each(["/register", "/authorize", "/token"])(
    "returns 500 when reading the %s request body fails",
    async (pathname) => {
      const router = createOAuthRouter({
        issuer: "http://127.0.0.1:9999",
        env: { OAUTH_HS256_KEY: SIGNING_KEY },
      });
      const request = new EventEmitter() as IncomingMessage;
      Object.assign(request, {
        method: "POST",
        url: pathname,
        headers: { "content-type": "application/json" },
      });
      let statusCode: number | undefined;
      let ended = false;
      const response = {
        headersSent: false,
        writeHead(status: number) {
          statusCode = status;
          this.headersSent = true;
          return this;
        },
        end() {
          ended = true;
          return this;
        },
      } as unknown as ServerResponse;

      expect(router.handle(request, response, pathname)).toBe(true);
      request.emit("error", new Error("socket closed"));
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusCode).toBe(500);
      expect(ended).toBe(true);
    },
  );

  it("rejects a reused authorization code (single-use)", async () => {
    const redirectUri = "http://127.0.0.1:9999/callback";
    const dcrRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    const { client_id, client_secret } = await dcrRes.json();
    const verifier = "verifier";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const decisionRes = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        decision: "allow",
        params: authorizeParams.toString(),
      }).toString(),
    });
    const location = new URL(decisionRes.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    const tokenBody = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id,
      client_secret,
      code_verifier: verifier,
    };
    const first = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenBody).toString(),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenBody).toString(),
    });
    expect(second.status).toBe(400);
  });

  it("rejects /mcp without a bearer token when OAuth is enabled", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-authorization-server");
  });
});
