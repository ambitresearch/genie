import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuthStore } from "./store.js";
import { buildAuthorizationServerMetadata } from "./metadata.js";
import { registerDynamicClient, DcrValidationError } from "./dcr.js";
import { renderConsentScreen, handleConsentDecision, AuthorizeError } from "./authorize.js";
import { handleTokenRequest, TokenError } from "./token.js";
import { verifyJwtHS256, JwtVerificationError, type JwtPayload } from "./jwt.js";
import { resolveOAuthSigningKey, MissingOAuthKeyError } from "./config.js";

export { MissingOAuthKeyError };

export interface OAuthHttpRouterOptions {
  /** Public base URL clients see this server at (issuer). */
  issuer: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Wires the OAuth 2.0 + DCR endpoints (RFC 7591 / RFC 8414) onto genie's
 * Streamable HTTP server (DRO-273 / M5-01):
 *   GET  /.well-known/oauth-authorization-server
 *   POST /register
 *   GET  /authorize   (consent screen)
 *   POST /authorize   (consent decision)
 *   POST /token
 *
 * Returns `undefined` (feature disabled) if `OAUTH_HS256_KEY` is unset or too
 * short — callers should refuse to start OAuth-protected routes in that case
 * per the issue's Implementation Notes, while still allowing unauthenticated
 * MCP transport to run (OAuth is opt-in).
 */
export function createOAuthRouter(
  opts: OAuthHttpRouterOptions,
): {
  signingKey: string;
  store: OAuthStore;
  handle: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;
  verifyBearerToken: (authorizationHeader: string | undefined) => JwtPayload;
} {
  const signingKey = resolveOAuthSigningKey(opts.env ?? process.env);
  const store = new OAuthStore();

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function parseBody(raw: Buffer, contentType: string | undefined): Record<string, unknown> {
    const text = raw.toString("utf8");
    if (!text) return {};
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function verifyBearerToken(authorizationHeader: string | undefined): JwtPayload {
    if (!authorizationHeader?.startsWith("Bearer ")) {
      throw new JwtVerificationError("Missing Bearer token.");
    }
    return verifyJwtHS256(authorizationHeader.slice("Bearer ".length), signingKey);
  }

  function handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const url = new URL(req.url ?? "/", opts.issuer);

    if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, buildAuthorizationServerMetadata({ issuer: opts.issuer }));
      return true;
    }

    if (req.method === "POST" && pathname === "/register") {
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
          const result = registerDynamicClient(store, body);
          json(res, 201, result);
        } catch (error) {
          if (error instanceof DcrValidationError) {
            json(res, 400, { error: "invalid_client_metadata", error_description: error.message });
          } else {
            json(res, 500, { error: "server_error" });
          }
        }
      });
      return true;
    }

    if (req.method === "GET" && pathname === "/authorize") {
      try {
        const query = Object.fromEntries(url.searchParams);
        const html = renderConsentScreen(store, query);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (error) {
        const status = error instanceof AuthorizeError ? error.status : 500;
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : "Internal error");
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/authorize") {
      void readBody(req).then((raw) => {
        try {
          const form = new URLSearchParams(raw.toString("utf8"));
          const params = new URLSearchParams(form.get("params") ?? "");
          const decision = form.get("decision") ?? "deny";
          const redirectUrl = handleConsentDecision(store, params, decision);
          res.writeHead(302, { location: redirectUrl });
          res.end();
        } catch (error) {
          const status = error instanceof AuthorizeError ? error.status : 500;
          res.writeHead(status, { "content-type": "text/plain" });
          res.end(error instanceof Error ? error.message : "Internal error");
        }
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/token") {
      void readBody(req).then((raw) => {
        try {
          const body = parseBody(raw, req.headers["content-type"]);
          const result = handleTokenRequest(store, signingKey, body);
          json(res, 200, result);
        } catch (error) {
          if (error instanceof TokenError) {
            json(res, 400, { error: error.error, error_description: error.message });
          } else {
            json(res, 500, { error: "server_error" });
          }
        }
      });
      return true;
    }

    return false;
  }

  return { signingKey, store, handle, verifyBearerToken };
}

export function tryCreateOAuthRouter(
  opts: OAuthHttpRouterOptions,
): ReturnType<typeof createOAuthRouter> | undefined {
  try {
    return createOAuthRouter(opts);
  } catch (error) {
    if (error instanceof MissingOAuthKeyError) return undefined;
    throw error;
  }
}
