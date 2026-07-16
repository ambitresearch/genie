/**
 * AC1-AC7 — OIDC provider integration test (DRO-276 / M5-04).
 *
 * Runs genie's OIDC relying-party gate (`packages/server/src/auth/oidc/*`,
 * wired into `transport.ts`) end-to-end against a REAL ephemeral OIDC
 * provider (a real `oidc-provider`-backed authorization server, booted in a
 * throwaway container — see `./support/oidc-fixture.ts`), driving the actual
 * auth-code + PKCE flow with a real headless Playwright browser. This is the
 * template the issue asks for: an adopter whose IdP issues JWT access tokens
 * with the configured issuer, resource audience, and mapped `groups` claim
 * gets the identical genie-side enforcement this test proves.
 *
 * ── What each AC maps to ─────────────────────────────────────────────────────
 *   AC1 — this file: packages/e2e/test/m5-oidc.test.ts.                    ✅
 *   AC2 — `./support/oidc-fixture.ts` boots a real provider via testcontainers. ✅
 *   AC3 — the fixture's sole client is `client_id: "genie-test"`.          ✅
 *   AC4 — a real headless Chromium (Playwright) fills the fixture's login
 *         form and drives the full authorization_code + PKCE flow.         ✅
 *   AC5 — the resulting bearer token is handed to genie's real HTTP
 *         transport (in-process, same code path production uses) and
 *         asserted to authorize a `mcp__genie__list_kits` tool call.       ✅
 *   AC6 — a second user (`mallory`), authenticated the same way but NOT a
 *         member of `genie-users`, gets HTTP 403 from the SAME /mcp
 *         endpoint.                                                        ✅
 *   AC7 — no artificial waits; the whole walk (container boot + two full
 *         PKCE flows) is asserted to complete well under the 3-minute CI
 *         budget via this suite's own wall-clock assertion.                ✅
 *
 * ── Docker-absent skip ───────────────────────────────────────────────────────
 * Gated behind `isDockerAvailable()` exactly like `gitea-conformance.test.ts`
 * — skips cleanly (with a visible console.info) when no container runtime is
 * reachable, and `GENIE_REQUIRE_DOCKER=1` (set by this suite's dedicated CI
 * job) makes a vacuous skip fail loudly instead.
 *
 * ── Container networking ─────────────────────────────────────────────────────
 * The fixture reserves an ephemeral host port, binds the provider container
 * to it, and bakes that exact URL into issuer/discovery/token claims. This
 * keeps strict issuer matching while working on Linux CI and Docker Desktop.
 */
import { createServer as createNodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { createServer as createGenieServer } from "../../server/src/server.js";
import { createStreamableHttpRequestHandler } from "../../server/src/transport.js";
import { createOidcVerifier } from "../../server/src/auth/oidc/verifier.js";

import {
  isDockerAvailable,
  startOidcProvider,
  OIDC_CLIENT_ID,
  OIDC_REQUIRED_GROUP,
  OIDC_TEST_USERS,
  type OidcFixture,
} from "./support/oidc-fixture.js";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.info(
    "[m5-oidc] no container runtime detected — skipping the OIDC provider walk " +
      "(set up Docker to run it locally; CI's dedicated oidc job runs it for real).",
  );
}

if (!dockerAvailable && process.env.GENIE_REQUIRE_DOCKER === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but no container runtime is reachable — the CI oidc " +
      "job must run this walk, not skip it.",
  );
}

/** base64url per RFC 7636 (PKCE). */
function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface AuthorizationCodeCatcher {
  promise: Promise<string>;
  cancel: () => Promise<void>;
}

async function startAuthorizationCodeCatcher(
  callbackPort: number,
  timeoutMs = 20_000,
): Promise<AuthorizationCodeCatcher> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Browser failures can cancel the catcher before runAuthCodeFlow awaits it.
  void promise.catch(() => undefined);

  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
  const catcher = createNodeHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${callbackPort}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    const code = url.searchParams.get("code");
    if (code) void settle(undefined, code);
    else void settle(new Error(`callback missing code: ${url.search}`));
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      catcher.close((error) => (error ? reject(error) : resolve()));
    });

  const settle = async (error?: Error, code?: string): Promise<void> => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      await close();
    } catch (closeError) {
      if (error === undefined) {
        error = closeError instanceof Error ? closeError : new Error(String(closeError));
      }
    }
    if (error !== undefined) rejectCode(error);
    else if (code !== undefined) resolveCode(code);
    else rejectCode(new Error("OAuth callback completed without an authorization code"));
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    catcher.once("error", onError);
    catcher.listen(callbackPort, "127.0.0.1", () => {
      catcher.off("error", onError);
      resolve();
    });
  }).catch((error: unknown) => {
    const listenError = error instanceof Error ? error : new Error(String(error));
    rejectCode(listenError);
    throw listenError;
  });

  catcher.once("error", (error) => {
    void settle(error);
  });
  if (!settled) {
    timeout = setTimeout(
      () => void settle(new Error("timed out waiting for OAuth callback")),
      timeoutMs,
    );
  }

  return {
    promise,
    cancel: async () => {
      await settle(new Error("OAuth callback catcher cancelled"));
      await promise.catch(() => undefined);
    },
  };
}

async function unusedPort(): Promise<number> {
  const server = createNodeHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("OIDC callback catcher", () => {
  it("releases its listener when the callback times out", async () => {
    const port = await unusedPort();
    const catcher = await startAuthorizationCodeCatcher(port, 10);
    await expect(catcher.promise).rejects.toThrow("timed out waiting for OAuth callback");

    const probe = createNodeHttpServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("rejects explicitly when its callback port is already occupied", async () => {
    const occupied = createNodeHttpServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const { port } = occupied.address() as AddressInfo;

    try {
      await expect(startAuthorizationCodeCatcher(port, 100)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("releases its listener when explicitly cancelled", async () => {
    const port = await unusedPort();
    const catcher = await startAuthorizationCodeCatcher(port);
    await catcher.cancel();

    const probe = createNodeHttpServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});

interface AccessTokenClaims {
  aud?: unknown;
  client_id?: unknown;
  groups?: unknown;
  iat?: unknown;
  jti?: unknown;
  sub?: unknown;
}

interface AccessTokenHeader {
  typ?: unknown;
}

function decodeAccessTokenHeader(token: string): AccessTokenHeader {
  const [header] = token.split(".");
  if (header === undefined) throw new Error("OIDC fixture JWT is missing its header segment");
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as AccessTokenHeader;
}

function decodeAccessTokenClaims(token: string): AccessTokenClaims {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new Error("OIDC fixture issued an opaque access token; expected a signed JWT");
  }
  const payload = segments[1];
  if (payload === undefined) throw new Error("OIDC fixture JWT is missing its payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
}

interface JsonRpcToolResponse {
  error?: unknown;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: { kits?: unknown };
  };
}

async function readJsonRpcToolResponse(response: Response): Promise<JsonRpcToolResponse> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) {
    return JSON.parse(text) as JsonRpcToolResponse;
  }
  const messages = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as JsonRpcToolResponse);
  const message = messages.at(-1);
  if (message === undefined) throw new Error(`MCP response contained no JSON-RPC message: ${text}`);
  return message;
}

/**
 * Drive a full authorization_code + PKCE flow against the real provider with
 * a real headless browser: navigate to /auth, fill the fixture's login form,
 * approve consent, and capture the resulting `code` off the redirect.
 */
async function runAuthCodeFlow(
  browser: Browser,
  oidc: OidcFixture,
  user: { username: string; password: string },
  challenge: string,
  callbackPort: number,
): Promise<string> {
  const page = await browser.newPage();
  let codeCatcher: AuthorizationCodeCatcher | undefined;
  try {
    codeCatcher = await startAuthorizationCodeCatcher(callbackPort);
    const authorizeUrl = new URL(`${oidc.issuer}/auth`);
    authorizeUrl.searchParams.set("client_id", OIDC_CLIENT_ID);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid profile groups");
    authorizeUrl.searchParams.set("redirect_uri", oidc.redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", oidc.resource);
    authorizeUrl.searchParams.set("state", "genie-e2e-state");

    // The catcher is started before navigation and explicitly cancelled in
    // `finally`, so any browser failure releases the callback port immediately.
    await page.goto(authorizeUrl.toString());
    await page.fill('input[name="username"]', user.username);
    await page.fill('input[name="password"]', user.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "commit" }).catch(() => undefined),
      page.click('button[type="submit"]'),
    ]);

    return await codeCatcher.promise;
  } finally {
    await codeCatcher?.cancel();
    await page.close();
  }
}

async function exchangeCodeForToken(
  oidc: OidcFixture,
  code: string,
  verifier: string,
): Promise<{ accessToken: string; idToken: string }> {
  const res = await fetch(`${oidc.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidc.redirectUri,
      client_id: OIDC_CLIENT_ID,
      code_verifier: verifier,
      resource: oidc.resource,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; id_token: string };
  if (typeof body.access_token !== "string" || typeof body.id_token !== "string") {
    throw new Error("token exchange response is missing access_token or id_token");
  }
  return { accessToken: body.access_token, idToken: body.id_token };
}

describe.skipIf(!dockerAvailable)("M5-04 — OIDC provider integration (DRO-276)", () => {
  const suiteStartedAt = Date.now();
  let oidc: OidcFixture;
  let browser: Browser;
  let callbackPort: number;
  let genieBaseUrl: string;
  let closeGenie: () => Promise<void>;
  let testRoot: string;

  beforeAll(async () => {
    callbackPort = await unusedPort();
    oidc = await startOidcProvider(`http://127.0.0.1:${callbackPort}/callback`);
    browser = await chromium.launch();
    testRoot = await mkdtemp(join(tmpdir(), "genie-oidc-e2e-"));

    // AC5/AC6 — genie's real HTTP transport, gated by a real OidcVerifier
    // pointed at the just-booted provider. Same createStreamableHttpRequestHandler
    // production uses (transport.ts's startHttp calls this too).
    const oidcVerifier = await createOidcVerifier({
      issuer: oidc.issuer,
      audience: OIDC_CLIENT_ID,
    });
    const handler = createStreamableHttpRequestHandler(
      () =>
        createGenieServer({
          kitsRoot: join(testRoot, "kits"),
          projectsRoot: join(testRoot, "projects"),
        }),
      { oidcVerifier },
    );
    const genieHttp = createNodeHttpServer(handler);
    await new Promise<void>((resolve) => genieHttp.listen(0, "127.0.0.1", resolve));
    const { port } = genieHttp.address() as AddressInfo;
    genieBaseUrl = `http://127.0.0.1:${port}`;
    closeGenie = () => new Promise((resolve) => genieHttp.close(() => resolve()));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await closeGenie?.();
    await oidc?.stop();
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  it("AC4/AC5 — a real PKCE auth-code flow for a genie-users member authorizes mcp__genie__list_kits", async () => {
    const { verifier, challenge } = pkcePair();
    const code = await runAuthCodeFlow(
      browser,
      oidc,
      OIDC_TEST_USERS.authorized,
      challenge,
      callbackPort,
    );
    const { accessToken, idToken } = await exchangeCodeForToken(oidc, code, verifier);
    expect(accessToken).toBeTruthy();
    expect(idToken).toBeTruthy();
    expect(decodeAccessTokenHeader(accessToken)).toMatchObject({ typ: "at+jwt" });
    const claims = decodeAccessTokenClaims(accessToken);
    expect(claims).toMatchObject({
      sub: OIDC_TEST_USERS.authorized.username,
      aud: OIDC_CLIENT_ID,
      client_id: OIDC_CLIENT_ID,
      iat: expect.any(Number),
      jti: expect.any(String),
    });
    expect(claims.groups).toEqual(expect.arrayContaining([OIDC_REQUIRED_GROUP]));

    // Drive one real MCP JSON-RPC round trip (initialize -> tools/call
    // list_kits) using the same Streamable HTTP transport a harness uses,
    // authenticated with the token this run's PKCE flow produced.
    const initRes = await fetch(`${genieBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "genie-e2e-oidc", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const listKitsRes = await fetch(`${genieBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mcp__genie__list_kits", arguments: {} },
      }),
    });
    expect(listKitsRes.status).toBe(200);
    const rpc = await readJsonRpcToolResponse(listKitsRes);
    expect(rpc.error).toBeUndefined();
    expect(rpc.result?.isError).not.toBe(true);
    const kits = rpc.result?.structuredContent?.kits;
    expect(kits).toEqual([]);
    const textResult = rpc.result?.content?.find((part) => part.type === "text")?.text;
    expect(textResult).toBeDefined();
    expect(JSON.parse(textResult ?? "null")).toEqual([]);

    const idTokenRes = await fetch(`${genieBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "genie-e2e-oidc-id-token", version: "0.0.0" },
        },
      }),
    });
    expect(idTokenRes.status).toBe(401);
  }, 30_000);

  it("AC6 — a real PKCE auth-code flow for a NON-genie-users user is rejected with HTTP 403", async () => {
    const { verifier, challenge } = pkcePair();
    const code = await runAuthCodeFlow(
      browser,
      oidc,
      OIDC_TEST_USERS.unauthorized,
      challenge,
      callbackPort,
    );
    const { accessToken } = await exchangeCodeForToken(oidc, code, verifier);
    expect(accessToken).toBeTruthy();
    const claims = decodeAccessTokenClaims(accessToken);
    expect(claims).toMatchObject({
      sub: OIDC_TEST_USERS.unauthorized.username,
      aud: OIDC_CLIENT_ID,
    });
    expect(claims.groups).toEqual(expect.any(Array));
    expect(claims.groups).not.toEqual(expect.arrayContaining([OIDC_REQUIRED_GROUP]));

    const res = await fetch(`${genieBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "genie-e2e-oidc", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(403);
  }, 30_000);

  it("AC7 — the whole walk (container boot + two full PKCE flows) completes well under 3 minutes", () => {
    expect(Date.now() - suiteStartedAt).toBeLessThan(3 * 60_000);
  });
});
