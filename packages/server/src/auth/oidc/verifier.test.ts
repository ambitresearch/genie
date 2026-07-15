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
});

describe("createOidcVerifier (real RS256 JWT + JWKS round-trip, no network)", () => {
  let publicJwk: Record<string, unknown>;
  let signToken: (claims: Record<string, unknown>) => Promise<string>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "test-key-1" };

    signToken = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("5m")
        .sign(privateKey);

    // Stub `fetch` so discovery + JWKS resolve against our in-memory keypair
    // instead of a real network call — this proves the module's discovery +
    // verification logic without needing a live IdP.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ jwks_uri: `${ISSUER}/jwks` }), {
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

  it("AC6 — rejects (throws GroupAccessDeniedError) a validly-signed token whose groups lack genie-users", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken({ sub: "mallory", groups: ["some-other-group"] });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(GroupAccessDeniedError);
  });

  it("rejects a token from an unexpected issuer/audience (signature/claims mismatch)", async () => {
    const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const wrongAudienceToken = await new SignJWT({ sub: "alice", groups: ["genie-users"] })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience("some-other-client")
      .setExpirationTime("5m")
      .sign((await generateKeyPair("RS256")).privateKey);

    await expect(verifier.verify(wrongAudienceToken)).rejects.toThrow();
  });

  it("rejects an expired token signed by the correct key", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const kid = "expired-key";
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ jwks_uri: `${ISSUER}/jwks` }), {
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
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);

    await expect(verifier.verify(expired)).rejects.toThrow();
  });
});
