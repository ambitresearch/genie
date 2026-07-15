import { describe, it, expect, afterEach } from "vitest";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStreamableHttpRequestHandler } from "./transport.js";
import { GroupAccessDeniedError } from "./auth/oidc/group-policy.js";
import type { OidcVerifier } from "./auth/oidc/verifier.js";

/**
 * Unit-level (no real IdP/network) coverage of the OIDC relying-party gate
 * wired into the Streamable HTTP transport (M5-04, DRO-276). The full,
 * real-provider walk (testcontainers + Playwright PKCE flow) lives in
 * `packages/e2e/test/m5-oidc.test.ts`; this file proves the transport-layer
 * plumbing (401 vs 403, `/health` exemption, pass-through when unconfigured)
 * fast and deterministically, with a stub `OidcVerifier`.
 */
describe("OIDC relying-party gate (DRO-276)", () => {
  let close: () => Promise<void>;

  afterEach(async () => {
    await close();
  });

  function createServer_stubMcpServer(): McpServer {
    return {
      server: { onclose: undefined },
      connect: async () => undefined,
    } as unknown as McpServer;
  }

  async function start(oidcVerifier?: OidcVerifier): Promise<string> {
    const handler: RequestListener = createStreamableHttpRequestHandler(
      () => createServer_stubMcpServer(),
      { oidcVerifier },
    );
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  it("passes requests through unchanged when no oidcVerifier is configured", async () => {
    const baseUrl = await start(undefined);
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
    const baseUrl = await start(verifier);
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
    const baseUrl = await start(verifier);
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
    const baseUrl = await start(verifier);
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
    const baseUrl = await start(verifier);
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});
