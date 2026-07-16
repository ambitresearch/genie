import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { extractBearerToken, verifyToken } from "./auth/bearer.js";
import { tryCreateOAuthRouter } from "./auth/oauth/router.js";
import { tryCreateOidcVerifier, type OidcVerifier } from "./auth/oidc/verifier.js";
import { GroupAccessDeniedError } from "./auth/oidc/group-policy.js";

export type TransportKind = "stdio" | "http";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const unwrapped =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  const ipVersion = isIP(unwrapped);
  if (ipVersion === 4) return unwrapped.split(".")[0] === "127";
  if (ipVersion !== 6) return false;

  try {
    return new URL(`http://[${unwrapped}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

export function normalizeListenHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

export function formatHttpEndpoint(host: string, port: number): string {
  const normalized = normalizeListenHost(host);
  const urlHost = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return `http://${urlHost}:${port}/mcp`;
}

const serverTransportKinds = new WeakMap<McpServer, TransportKind>();
const serverDisposers = new WeakMap<McpServer, Set<() => void | Promise<void>>>();
const serverDisposerHooks = new WeakSet<McpServer>();

/** Register session-scoped resources that must close with their MCP server. */
export function registerServerDisposer(
  server: McpServer,
  disposer: () => void | Promise<void>,
): void {
  const disposers = serverDisposers.get(server) ?? new Set();
  disposers.add(disposer);
  serverDisposers.set(server, disposers);
  if (!serverDisposerHooks.has(server)) {
    serverDisposerHooks.add(server);
    const previousOnClose = server.server.onclose;
    server.server.onclose = () => {
      try {
        previousOnClose?.();
      } finally {
        void disposeServer(server);
      }
    };
  }
}

async function disposeServer(server: McpServer): Promise<void> {
  const disposers = serverDisposers.get(server);
  if (disposers === undefined) return;
  serverDisposers.delete(server);
  await Promise.allSettled([...disposers].map((dispose) => dispose()));
}

/** Return the transport selected for a started server, if startup has begun. */
export function getServerTransportKind(server: McpServer): TransportKind | undefined {
  return serverTransportKinds.get(server);
}

/**
 * Resolve which transport to use (RFC §5.2 transport multiplexer):
 *   1. explicit `kind` argument (from the --transport CLI flag), else
 *   2. MCP_TRANSPORT env var, else
 *   3. auto-detect: a TTY on stdin means a human launched us → HTTP;
 *      otherwise a harness is piping JSON-RPC over stdio → stdio.
 */
export function resolveTransport(kind?: string): TransportKind {
  const choice = (kind ?? process.env.MCP_TRANSPORT ?? "").toLowerCase();
  if (choice === "stdio" || choice === "http") return choice;
  if (choice) {
    throw new Error(`Unknown transport "${choice}". Use "stdio" or "http".`);
  }
  return process.stdin.isTTY ? "http" : "stdio";
}

/**
 * Resolve whether preview URLs are reachable from the MCP client. HTTP is
 * conservative by default because a loopback bind can still sit behind a
 * reverse proxy or tunnel; same-machine HTTP deployments must opt into local
 * URLs explicitly.
 */
export function resolvePreviewLocality(
  transportKind: TransportKind,
  locality?: string,
  env: NodeJS.ProcessEnv = process.env,
): "local" | "remote" {
  const choice = (locality ?? env.GENIE_PREVIEW_LOCALITY ?? "").trim().toLowerCase();
  if (choice === "local" || choice === "remote") return choice;
  if (choice) {
    throw new Error(`Unknown preview locality "${choice}". Use "local" or "remote".`);
  }
  return transportKind === "stdio" ? "local" : "remote";
}

/** Connect the server over stdio (the default for local harnesses). */
async function startStdio(
  server: McpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const transport = new StdioServerTransport(input, output);
  let closing = false;
  const closeOnEof = (): void => {
    if (closing) return;
    closing = true;
    void transport.close().catch((error: unknown) => {
      process.stderr.write(
        `genie: stdio close failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  const removeEofListeners = (): void => {
    input.off("end", closeOnEof);
    input.off("close", closeOnEof);
  };
  transport.onclose = removeEofListeners;
  input.once("end", closeOnEof);
  input.once("close", closeOnEof);
  try {
    await server.connect(transport);
  } catch (error) {
    removeEofListeners();
    throw error;
  }
  // No stdout logging on stdio — it would corrupt the JSON-RPC stream.
}

interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  activeRequests: number;
  disposed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface SessionLease {
  session: HttpSession;
  sessionId?: string;
  released: boolean;
}

const DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface StreamableHttpHandlerOptions {
  sessionIdleTimeoutMs?: number;
  /**
   * Enables static `Authorization: Bearer genie_<token>` authentication
   * (M5-02, DRO-274). When it is the only configured credential source, every
   * `/mcp` request must use one; when OAuth or OIDC is also configured, any
   * one enabled source may authenticate the request. `/health` is exempt.
   */
  requireBearerAuth?: boolean;
  /**
   * Public issuer URL for OAuth (DRO-273 / M5-01), e.g. `http://127.0.0.1:3000`.
   * When set and `OAUTH_HS256_KEY` is a valid signing key, the OAuth 2.0 +
   * DCR endpoints (`/.well-known/oauth-authorization-server`, `/register`,
   * `/authorize`, `/token`) are mounted on this HTTP server. OAuth is
   * opt-in: omit `oauthIssuer`, or leave `OAUTH_HS256_KEY` unset, to run
   * without it.
   */
  oauthIssuer?: string;
  /**
   * Pre-built OIDC relying-party verifier (M5-04, DRO-276). When supplied,
   * a bearer token issued by the configured EXTERNAL OIDC provider and
   * asserting membership in the required group can authenticate `/mcp` (see
   * `auth/oidc/verifier.ts`). Independent of the other credential sources: a
   * deployment can enable any combination, and acceptance by any one source
   * authorizes the request. A token invalid for all sources gets 401; a
   * valid OIDC token missing the required group gets 403 (AC6).
   */
  oidcVerifier?: OidcVerifier;
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function writeProtocolError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

function reportHttpFailure(res: ServerResponse, error: unknown): void {
  process.stderr.write(
    JSON.stringify({
      event: "transport.http.error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }) + "\n",
  );
  writeProtocolError(res, 500, "Internal server error");
}

/**
 * Create the stateful Streamable HTTP request handler. Each initialized client
 * receives its own MCP server + transport, keyed by Mcp-Session-Id, so
 * initialize-scoped capabilities never leak between clients.
 */
export function createStreamableHttpRequestHandler(
  serverFactory: () => McpServer,
  options: StreamableHttpHandlerOptions = {},
): RequestListener {
  const sessions = new Map<string, HttpSession>();
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(sessionIdleTimeoutMs) || sessionIdleTimeoutMs <= 0) {
    throw new Error("sessionIdleTimeoutMs must be a positive finite number.");
  }
  const oauthRouter = options.oauthIssuer
    ? tryCreateOAuthRouter({ issuer: options.oauthIssuer })
    : undefined;

  const refreshIdleTimer = (sessionId: string, session: HttpSession): void => {
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (sessions.get(sessionId) !== session) return;
      if (session.activeRequests > 0) return;
      session.idleTimer = undefined;
      sessions.delete(sessionId);
      void session.transport.close().finally(() => disposeServer(session.server));
    }, sessionIdleTimeoutMs);
    session.idleTimer.unref?.();
  };

  const disposeSession = (session: HttpSession): void => {
    if (session.disposed) return;
    session.disposed = true;
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    void disposeServer(session.server);
  };

  const acquireSession = (session: HttpSession, sessionId?: string): SessionLease => {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    session.activeRequests += 1;
    return { session, sessionId, released: false };
  };

  const releaseSession = (lease: SessionLease): void => {
    if (lease.released) return;
    lease.released = true;
    lease.session.activeRequests -= 1;
    const activeId = lease.sessionId ?? lease.session.transport.sessionId;
    if (
      activeId !== undefined &&
      lease.session.activeRequests === 0 &&
      sessions.get(activeId) === lease.session
    ) {
      refreshIdleTimer(activeId, lease.session);
    }
  };

  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
    acquiredLease?: SessionLease,
  ): Promise<void> => {
    const sessionId = sessionIdFrom(req);
    let session = acquiredLease?.session ?? sessions.get(sessionId ?? "");
    let createdSession = false;

    if (session === undefined) {
      if (sessionId !== undefined) {
        writeProtocolError(res, 404, "Unknown MCP session");
        return;
      }
      if (!isInitializeRequest(body)) {
        writeProtocolError(res, 400, "Missing MCP session ID");
        return;
      }

      const sessionServer = serverFactory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => {
          const initializedSession = session as HttpSession;
          sessions.set(initializedId, initializedSession);
        },
      });
      session = { server: sessionServer, transport, activeRequests: 0, disposed: false };
      createdSession = true;
      transport.onclose = () => {
        const closedId = transport.sessionId;
        if (closedId !== undefined) sessions.delete(closedId);
        disposeSession(session as HttpSession);
      };
      serverTransportKinds.set(sessionServer, "http");
      try {
        await sessionServer.connect(transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        disposeSession(session);
        throw error;
      }
    }

    const lease = acquiredLease ?? acquireSession(session, sessionId);
    try {
      await session.transport.handleRequest(req, res, body);
    } finally {
      releaseSession(lease);
      if (createdSession && session.transport.sessionId === undefined) {
        await session.transport.close().catch(() => undefined);
        disposeSession(session);
      }
    }
  };

  const requireBearerAuth = options.requireBearerAuth ?? false;
  const { oidcVerifier } = options;

  /**
   * Authenticate `/mcp` against every configured credential source. Sources
   * are alternatives: a token accepted by self-issued OAuth, static bearer
   * auth, OR external OIDC may proceed. An OIDC token that verifies but lacks
   * the required group gets 403 only after the other enabled sources also
   * reject it; a token invalid for every source gets 401.
   */
  const authorizeMcp = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const authEnabled =
      oauthRouter !== undefined || requireBearerAuth || oidcVerifier !== undefined;
    if (!authEnabled) return true;

    const authorizationHeader = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    const token = extractBearerToken(authorizationHeader);
    if (token === undefined) {
      writeUnauthorized(res, "Missing bearer token");
      return false;
    }

    if (oauthRouter !== undefined) {
      try {
        oauthRouter.verifyBearerToken(authorizationHeader);
        return true;
      } catch {
        // Try the remaining configured credential sources.
      }
    }

    if (requireBearerAuth && (await verifyToken(token)).ok) return true;

    let groupDenied: GroupAccessDeniedError | undefined;
    if (oidcVerifier !== undefined) {
      try {
        await oidcVerifier.verify(token);
        return true;
      } catch (error) {
        if (error instanceof GroupAccessDeniedError) groupDenied = error;
      }
    }

    if (groupDenied !== undefined) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "insufficient_group",
          message: `Caller is not a member of the "${groupDenied.requiredGroup}" group.`,
        }),
      );
      return false;
    }

    writeUnauthorized(res, "Invalid bearer token", "invalid_token");
    return false;
  };

  const writeUnauthorized = (
    res: ServerResponse,
    message: string,
    error?: "invalid_token",
  ): void => {
    if (oauthRouter === undefined) {
      const challenge = error === undefined ? "Bearer" : `Bearer error="${error}"`;
      writeProtocolError(res, 401, message, { "www-authenticate": challenge });
      return;
    }
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${options.oauthIssuer}/.well-known/oauth-authorization-server"`,
    });
    res.end(JSON.stringify({ error: "invalid_token" }));
  };

  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (oauthRouter?.handle(req, res, pathname)) return;

    if (pathname === "/mcp") {
      void authorizeMcp(req, res).then((authorized) => {
        if (!authorized) return;
        dispatchMcp(req, res, pathname);
      });
      return;
    }

    dispatchMcp(req, res, pathname);
  };

  function dispatchMcp(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method === "POST" && pathname === "/mcp") {
      const sessionId = sessionIdFrom(req);
      let lease: SessionLease | undefined;
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (session === undefined) {
          writeProtocolError(res, 404, "Unknown MCP session");
          return;
        }
        lease = acquireSession(session, sessionId);
      }
      let handedOff = false;
      const releaseBufferedRequest = (): void => {
        if (!handedOff && lease !== undefined) releaseSession(lease);
      };
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.once("aborted", releaseBufferedRequest);
      req.once("error", releaseBufferedRequest);
      req.on("end", () => {
        if (req.aborted) {
          releaseBufferedRequest();
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          releaseBufferedRequest();
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
        handedOff = true;
        void handleMcp(req, res, body, lease).catch((error: unknown) => {
          reportHttpFailure(res, error);
        });
      });
      return;
    }
    if ((req.method === "GET" || req.method === "DELETE") && pathname === "/mcp") {
      void handleMcp(req, res).catch((error: unknown) => {
        reportHttpFailure(res, error);
      });
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "genie" }));
      return;
    }
    res.writeHead(404).end();
  }
}

/** Connect the server over Streamable HTTP (for remote / multi-client use). */
async function startHttp(
  port: number,
  host: string,
  serverFactory?: () => McpServer,
  requireBearerAuth?: boolean,
): Promise<void> {
  if (serverFactory === undefined) {
    throw new Error(
      "HTTP transport requires an explicit serverFactory for per-client session isolation.",
    );
  }
  // OAuth is opt-in: only mounted when OAUTH_HS256_KEY is set (AC1-AC5). The
  // issuer is the externally-reachable endpoint clients will hit for DCR +
  // token exchange, so it must match how `claude mcp add` / `codex mcp
  // login` reach this process — override via GENIE_OAUTH_ISSUER for
  // reverse-proxy/tunnel deployments.
  const oauthIssuer =
    process.env.OAUTH_HS256_KEY !== undefined
      ? (process.env.GENIE_OAUTH_ISSUER ?? `http://${normalizeListenHost(host)}:${port}`)
      : undefined;
  // OIDC relying-party mode is opt-in: only engages when GENIE_OIDC_ISSUER +
  // GENIE_OIDC_AUDIENCE are set (M5-04, DRO-276). Independent of oauthIssuer.
  const oidcVerifier = await tryCreateOidcVerifier(process.env);
  const http = createHttpServer(
    createStreamableHttpRequestHandler(serverFactory, {
      requireBearerAuth,
      oauthIssuer,
      oidcVerifier,
    }),
  );

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  process.stderr.write(`genie MCP server listening on ${formatHttpEndpoint(host, port)}\n`);
  if (oauthIssuer) {
    process.stderr.write(`genie MCP server: OAuth 2.0 + DCR enabled (issuer ${oauthIssuer})\n`);
  }
  if (oidcVerifier) {
    process.stderr.write(
      `genie MCP server: OIDC relying-party mode enabled (issuer ${oidcVerifier.issuer}, ` +
        `required group "${oidcVerifier.requiredGroup}")\n`,
    );
  }
}

export interface StartOptions {
  kind?: string;
  port?: number;
  host?: string;
  /** Required for HTTP; must include every caller-added registration per session. */
  serverFactory?: () => McpServer;
  /** Injectable stdio streams for embedders and EOF lifecycle tests. */
  stdioInput?: Readable;
  stdioOutput?: Writable;
  /** HTTP only — enable static `Authorization: Bearer` tokens (M5-02, DRO-274). */
  requireBearerAuth?: boolean;
}

/** Start the server on the resolved transport. Returns the kind actually used. */
export async function startTransport(
  server: McpServer,
  opts: StartOptions = {},
): Promise<TransportKind> {
  const kind = resolveTransport(opts.kind);
  serverTransportKinds.set(server, kind);
  try {
    if (kind === "http") {
      await startHttp(
        opts.port ?? 3000,
        normalizeListenHost(opts.host ?? "127.0.0.1"),
        opts.serverFactory,
        opts.requireBearerAuth,
      );
    } else {
      await startStdio(server, opts.stdioInput, opts.stdioOutput);
    }
  } catch (error) {
    serverTransportKinds.delete(server);
    throw error;
  }
  return kind;
}
