// Ephemeral OIDC provider for genie's M5-04 (DRO-276) integration test.
//
// Boots a minimal `oidc-provider` instance with:
//   - a single client, client_id `genie-test` (AC3), public (PKCE-only, no
//     client_secret) so a browser-driven auth-code+PKCE flow (AC4) works
//     without a confidential-client secret leaking into the test fixture,
//   - a `groups` claim on the ID/access token, sourced from a fixed set of
//     in-memory "users" this file seeds — one user IS in `genie-users`, one
//     is NOT, so the integration test can assert both the AC5 (authorized)
//     and AC6 (403-rejected) paths against the SAME running provider,
//   - a trivial interaction view (a plain HTML login form, no styling) that
//     Playwright can drive headlessly — oidc-provider ships no default UI,
//     so this is the minimum viable one.
//
// This process is the sole ENTRYPOINT of the container image built by
// ../oidc-fixture.ts (GenericContainer.fromDockerfile) — see that file for
// how the container is started/stopped and how its exposed port is mapped
// back to the host for the test's Playwright browser + genie server to hit.
import { createServer } from "node:http";
import Provider from "oidc-provider";

const PORT = 9944;

// Deliberately plaintext/throwaway — this is a fixture credential for a
// container that lives for the duration of a single test file, never a real
// secret (CLAUDE.md hard rule #5 / AGENTS.md). Mirrors gitea-fixture.ts's
// ADMIN_PASSWORD posture.
const USERS = {
  alice: { password: "genie-e2e-alice-pw", groups: ["genie-users"] },
  mallory: { password: "genie-e2e-mallory-pw", groups: ["some-other-group"] },
};

const issuer = process.env.OIDC_ISSUER || `http://127.0.0.1:${PORT}`;
const resource = `${issuer}/mcp`;

const configuration = {
  clients: [
    {
      client_id: "genie-test",
      // Public client: PKCE-only, no client_secret (AC4's "headless browser
      // performs the auth code + PKCE flow" implies a browser-embeddable,
      // secret-less client — the standard SPA/native-app shape).
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: [process.env.OIDC_REDIRECT_URI || "http://127.0.0.1:4180/callback"],
    },
  ],
  pkce: { required: () => true },
  scopes: ["openid", "profile", "groups"],
  claims: {
    openid: ["sub"],
    groups: ["groups"],
  },
  features: {
    devInteractions: { enabled: false },
    // No refresh tokens / revocation surface needed for this walk — keep the
    // provider's own attack surface minimal (AC-scope: this test proves ONE
    // provider path, not a general OIDC conformance suite).
    revocation: { enabled: false },
    resourceIndicators: {
      enabled: true,
      getResourceServerInfo(_ctx, resourceIndicator) {
        if (resourceIndicator !== resource) throw new Error("unexpected resource indicator");
        return {
          scope: "openid profile groups",
          audience: "genie-test",
          accessTokenFormat: "jwt",
        };
      },
    },
  },
  extraTokenClaims(_ctx, token) {
    return { groups: USERS[token.accountId]?.groups ?? [] };
  },
  findAccount(ctx, sub) {
    const record = USERS[sub];
    if (!record) return undefined;
    return {
      accountId: sub,
      async claims() {
        return { sub, groups: record.groups };
      },
    };
  },
  ttl: {
    AccessToken: 3600,
    AuthorizationCode: 600,
    IdToken: 3600,
    Interaction: 3600,
    Session: 3600,
  },
};

const provider = new Provider(issuer, configuration);
// Trust the container's forwarded scheme (testcontainers maps a random host
// port; oidc-provider must not reject non-HTTPS in this throwaway fixture).
provider.proxy = true;

// Minimal login-then-consent interaction view. oidc-provider redirects here
// (its own /interaction/:uid) whenever a fresh authorization request needs a
// human decision; this plain form is what Playwright's headless browser
// fills in and submits (AC4).
const app = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/interaction/")) {
    const uid = req.url.split("/interaction/")[1].split("?")[0];
    const { prompt } = await provider.interactionDetails(req, res);
    if (prompt.name === "login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`
        <html><body>
          <form method="POST" action="/interaction/${uid}/login">
            <input name="username" />
            <input name="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </body></html>
      `);
      return;
    }
    if (prompt.name === "consent") {
      const grant = new provider.Grant({
        accountId:
          prompt.details.accountId ??
          (await provider.interactionDetails(req, res)).session?.accountId,
        clientId: "genie-test",
      });
      grant.addOIDCScope("openid profile groups");
      grant.addResourceScope(resource, "openid profile groups");
      const grantId = await grant.save();
      const result = { consent: { grantId } };
      const redirectTo = await provider.interactionResult(req, res, result, {
        mergeWithLastSubmission: true,
      });
      res.writeHead(302, { location: redirectTo });
      res.end();
      return;
    }
    res.writeHead(400).end("unsupported interaction prompt");
    return;
  }

  if (req.method === "POST" && req.url?.match(/^\/interaction\/[^/]+\/login$/)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const username = body.get("username");
    const password = body.get("password");
    const record = USERS[username];
    if (!record || record.password !== password) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("invalid credentials");
      return;
    }
    const result = {
      login: { accountId: username },
    };
    const redirectTo = await provider.interactionResult(req, res, result, {
      mergeWithLastSubmission: false,
    });
    res.writeHead(302, { location: redirectTo });
    res.end();
    return;
  }

  provider.callback()(req, res);
});

app.listen(PORT, () => {
  console.log(`oidc-fixture listening on ${PORT}, issuer ${issuer}`);
});
