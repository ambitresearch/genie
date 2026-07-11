import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

const serverTransportKinds = new WeakMap<McpServer, TransportKind>();

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

/** Connect the server over stdio (the default for local harnesses). */
async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No stdout logging on stdio — it would corrupt the JSON-RPC stream.
}

/** Connect the server over Streamable HTTP (for remote / multi-client use). */
async function startHttp(server: McpServer, port: number, host: string): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    // Stateless: a fresh transport per request keeps M0 simple. Session
    // management (and auth) arrive with M5.
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const http = createHttpServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
        void transport.handleRequest(req, res, body);
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "genie" }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  process.stderr.write(`genie MCP server listening on http://${host}:${port}/mcp\n`);
}

export interface StartOptions {
  kind?: string;
  port?: number;
  host?: string;
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
      await startHttp(server, opts.port ?? 3000, normalizeListenHost(opts.host ?? "127.0.0.1"));
    } else {
      await startStdio(server);
    }
  } catch (error) {
    serverTransportKinds.delete(server);
    throw error;
  }
  return kind;
}
