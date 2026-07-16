import { describe, it, expect, afterEach } from "vitest";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createStreamableHttpRequestHandler,
  type StreamableHttpHandlerOptions,
} from "./transport.js";
import { GroupAccessDeniedError } from "./auth/oidc/group-policy.js";
import type { OidcVerifier } from "./auth/oidc/verifier.js";
import { createToken } from "./auth/bearer.js";
import { signJwtHS256 } from "./auth/oauth/jwt.js";

/**
 * Unit-level (no real IdP/network) coverage of the OIDC relying-party gate
 * wired into the Streamable HTTP transport (M5-04, DRO-276). The full,
 * real-provider walk (testcontainers + Playwright PKCE flow) lives in
 * `packages/e2e/test/m5-oidc.test.ts`; this file proves the transport-layer
 * plumbing (401 vs 403, `/health` exemption, pass-through when unconfigured)
 * fast and deterministically, with a stub `OidcVerifier`.
 */
describe("OIDC relying-party gate (DRO-276)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  function createTestMcpServer(): McpServer {
    const server = new McpServer({ name: "oidc-transport-test", version: "0" });
    server.registerTool("ping", { inputSchema: {} }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  }

  async function start(options: StreamableHttpHandlerOptions = {}): Promise<string> {
    const handler: RequestListener = createStreamableHttpRequestHandler(
      () => createTestMcpServer(),
      options,
    );
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  function initialize(baseUrl: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oidc-transport-test", version: "0" },
        },
      }),
    });
  }

  it("passes requests through unchanged when no oidcVerifier is configured", async () => {
    const baseUrl = await start();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("401s a /mcp request with no bearer token when oidcVerifier is configured", async () => {
    const verifier: OidcVerifier = {
      issuer: "https://idp.example.test",
      audience: "genie-test",
      requiredGroup: "genie-users",
      verify: async () => {
        throw new Error("should not be called without a token");
      },
    };
    const baseUrl = await start({ oidcVerifier: verifier });
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("401s a /mcp request whose token fails OIDC verification", async () => {
    const verifier: OidcVerifier = {
      issuer: "https://idp.example.test",
      audience: "genie-test",
      requiredGroup: "genie-users",
      verify: async () => {
        throw new Error("bad signature");
      },
    };
    const baseUrl = await start({ oidcVerifier: verifier });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("AC6 — 403s a /mcp request whose token is valid but lacks the required group", async () => {
    const verifier: OidcVerifier = {
      issuer: "https://idp.example.test",
      audience: "genie-test",
      requiredGroup: "genie-users",
      verify: async () => {
        throw new GroupAccessDeniedError("genie-users");
      },
    };
    const baseUrl = await start({ oidcVerifier: verifier });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer valid-but-ungrouped" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const responseBody = await res.json();
    expect(responseBody.error).toBe("insufficient_group");
  });

  it("leaves /health exempt from OIDC enforcement", async () => {
    const verifier: OidcVerifier = {
      issuer: "https://idp.example.test",
      audience: "genie-test",
      requiredGroup: "genie-users",
      verify: async () => {
        throw new Error("should never be called for /health");
      },
    };
    const baseUrl = await start({ oidcVerifier: verifier });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("treats self-issued OAuth, static bearer, and external OIDC as alternative credential sources", async () => {
    const signingKey = "o".repeat(32);
    const previousSigningKey = process.env.OAUTH_HS256_KEY;
    const previousGenieHome = process.env.GENIE_HOME;
    const genieHome = await mkdtemp(join(tmpdir(), "genie-oidc-transport-"));
    process.env.OAUTH_HS256_KEY = signingKey;
    process.env.GENIE_HOME = genieHome;

    try {
      const oidcVerifier: OidcVerifier = {
        issuer: "https://idp.example.test",
        audience: "genie-test",
        requiredGroup: "genie-users",
        verify: async (token) => {
          if (token === "valid-oidc-token") {
            return { sub: "alice", groups: ["genie-users"] };
          }
          if (token === "valid-oidc-token-without-group") {
            throw new GroupAccessDeniedError("genie-users");
          }
          throw new Error("not an OIDC token");
        },
      };
      const { token: staticToken } = await createToken({ sub: "static-client" });
      const now = Math.floor(Date.now() / 1000);
      const oauthToken = signJwtHS256(
        { sub: "oauth-client", client_id: "client", scope: "read", iat: now, exp: now + 60 },
        signingKey,
      );
      const baseUrl = await start({
        oauthIssuer: "http://127.0.0.1:0",
        requireBearerAuth: true,
        oidcVerifier,
      });

      await expect(initialize(baseUrl, "valid-oidc-token")).resolves.toMatchObject({ status: 200 });
      await expect(initialize(baseUrl, oauthToken)).resolves.toMatchObject({ status: 200 });
      await expect(initialize(baseUrl, staticToken)).resolves.toMatchObject({ status: 200 });
      await expect(initialize(baseUrl, "valid-oidc-token-without-group")).resolves.toMatchObject({
        status: 403,
      });
      await expect(initialize(baseUrl, "invalid-for-every-source")).resolves.toMatchObject({
        status: 401,
      });
    } finally {
      if (previousSigningKey === undefined) delete process.env.OAUTH_HS256_KEY;
      else process.env.OAUTH_HS256_KEY = previousSigningKey;
      if (previousGenieHome === undefined) delete process.env.GENIE_HOME;
      else process.env.GENIE_HOME = previousGenieHome;
      await rm(genieHome, { recursive: true, force: true });
    }
  });
});
