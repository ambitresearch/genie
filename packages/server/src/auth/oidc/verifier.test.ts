import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  createOidcVerifier,
  MissingOidcConfigError,
  resolveOidcConfig,
  tryCreateOidcVerifier,
} from "./verifier.js";
import { GroupAccessDeniedError } from "./group-policy.js";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "genie-test";

describe("resolveOidcConfig / tryCreateOidcVerifier (opt-in config, DRO-276)", () => {
  it("throws MissingOidcConfigError when GENIE_OIDC_ISSUER/AUDIENCE are unset", () => {
    expect(() => resolveOidcConfig({})).toThrow(MissingOidcConfigError);
  });

  it("resolves issuer/audience/requiredGroup from env, defaulting requiredGroup to genie-users", () => {
    const config = resolveOidcConfig({
      GENIE_OIDC_ISSUER: ISSUER,
      GENIE_OIDC_AUDIENCE: AUDIENCE,
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({ issuer: ISSUER, audience: AUDIENCE, requiredGroup: "genie-users" });
  });

  it("tryCreateOidcVerifier returns undefined (feature disabled) when unconfigured — never throws", async () => {
    await expect(tryCreateOidcVerifier({} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
  });

  it.each([
    { GENIE_OIDC_ISSUER: ISSUER },
    { GENIE_OIDC_AUDIENCE: AUDIENCE },
    { GENIE_OIDC_ISSUER: "" },
    { GENIE_OIDC_AUDIENCE: "" },
    { GENIE_OIDC_ISSUER: "", GENIE_OIDC_AUDIENCE: "" },
  ])("fails closed when OIDC is only partially configured: %o", async (env) => {
    await expect(tryCreateOidcVerifier(env as NodeJS.ProcessEnv)).rejects.toBeInstanceOf(
      MissingOidcConfigError,
    );
  });
});

describe("createOidcVerifier (real RS256 JWT + JWKS round-trip, no network)", () => {
  let publicJwk: Record<string, unknown>;
  let signToken: (
    claims: Record<string, unknown>,
    options?: { issuer?: string; audience?: string; omitExpiration?: boolean; typ?: string },
  ) => Promise<string>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "test-key-1" };

    signToken = (claims, options = {}) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1", typ: options.typ ?? "at+jwt" })
        .setIssuedAt()
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? AUDIENCE);
      if (!options.omitExpiration) jwt.setExpirationTime("5m");
      return jwt.sign(privateKey);
    };

    // Stub `fetch` so discovery + JWKS resolve against our in-memory keypair
    // instead of a real network call — this proves the module's discovery +
    // verification logic without needing a live IdP.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${ISSUER}/jwks`) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("verifies a real RS256 token signed by the (stubbed) IdP and returns its claims", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken({ sub: "alice", groups: ["genie-users"] });

    const claims = await verifier.verify(token);
    expect(claims.sub).toBe("alice");
  });

  it("fails startup with the discovery status when the provider returns non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    await expect(createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      `OIDC discovery failed: GET ${ISSUER}/.well-known/openid-configuration -> 503`,
    );
  });

  it("fails startup when the discovery document omits jwks_uri", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer: ISSUER }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      `OIDC discovery document at ${ISSUER}/.well-known/openid-configuration is missing jwks_uri.`,
    );
  });

  it("fails startup when the discovery document issuer is not an exact match", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: "https://attacker.example.test",
          jwks_uri: "https://attacker.example.test/jwks",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      `OIDC discovery issuer mismatch: expected ${ISSUER}, received https://attacker.example.test.`,
    );
  });

  it("fails startup when the discovery document omits issuer", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ jwks_uri: `${ISSUER}/jwks` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      `OIDC discovery issuer mismatch: expected ${ISSUER}, received undefined.`,
    );
  });

  it("preserves a trailing slash in the configured issuer when validating claims", async () => {
    const issuer = `${ISSUER}/`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer, jwks_uri: `${ISSUER}/jwks` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const verifier = await createOidcVerifier({ issuer, audience: AUDIENCE });
    const token = await signToken({ sub: "alice", groups: ["genie-users"] }, { issuer });

    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: "alice" });
    expect(verifier.issuer).toBe(issuer);
  });

  it("enforces GENIE_OIDC_REQUIRED_GROUP from resolved environment config", async () => {
    const verifier = await createOidcVerifier(
      resolveOidcConfig({
        GENIE_OIDC_ISSUER: ISSUER,
        GENIE_OIDC_AUDIENCE: AUDIENCE,
        GENIE_OIDC_REQUIRED_GROUP: "platform-team",
      } as NodeJS.ProcessEnv),
    );
    const member = await signToken({ sub: "alice", groups: ["platform-team"] });
    const defaultGroupOnly = await signToken({ sub: "bob", groups: ["genie-users"] });

    await expect(verifier.verify(member)).resolves.toMatchObject({ sub: "alice" });
    await expect(verifier.verify(defaultGroupOnly)).rejects.toMatchObject({
      requiredGroup: "platform-team",
    });
  });

  it("AC6 — rejects (throws GroupAccessDeniedError) a validly-signed token whose groups lack genie-users", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken({ sub: "mallory", groups: ["some-other-group"] });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(GroupAccessDeniedError);
  });

  it("rejects a correctly signed token with an unexpected audience", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const wrongAudienceToken = await signToken(
      { sub: "alice", groups: ["genie-users"] },
      { audience: "some-other-api" },
    );

    await expect(verifier.verify(wrongAudienceToken)).rejects.toThrow();
  });

  it("rejects a correctly signed token with an unexpected issuer", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const wrongIssuerToken = await signToken(
      { sub: "alice", groups: ["genie-users"] },
      { issuer: "https://other-idp.example.test" },
    );

    await expect(verifier.verify(wrongIssuerToken)).rejects.toThrow();
  });

  it("rejects a token signed by a key outside the provider JWKS", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const { privateKey } = await generateKeyPair("RS256");
    const invalidSignatureToken = await new SignJWT({
      sub: "alice",
      groups: ["genie-users"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1", typ: "at+jwt" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verify(invalidSignatureToken)).rejects.toThrow();
  });

  it("rejects a correctly signed token without an exp claim", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const nonExpiringToken = await signToken(
      { sub: "alice", groups: ["genie-users"] },
      { omitExpiration: true },
    );

    await expect(verifier.verify(nonExpiringToken)).rejects.toThrow();
  });

  it("rejects a correctly signed OIDC ID token used as a bearer access token", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const idToken = await signToken({ sub: "alice", groups: ["genie-users"] }, { typ: "JWT" });

    await expect(verifier.verify(idToken)).rejects.toThrow();
  });

  it("rejects an expired token signed by the correct key", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const kid = "expired-key";
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${ISSUER}/jwks`) {
        const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid };
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const expired = await new SignJWT({ sub: "alice", groups: ["genie-users"] })
      .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);

    await expect(verifier.verify(expired)).rejects.toThrow();
  });
});
