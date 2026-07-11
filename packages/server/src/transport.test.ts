import { createServer as createNodeHttpServer, request as nodeHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "./server.js";
import {
  createStreamableHttpRequestHandler,
  getServerTransportKind,
  formatHttpEndpoint,
  isLoopbackHost,
  normalizeListenHost,
  resolvePreviewLocality,
  resolveTransport,
  registerServerDisposer,
  startTransport,
} from "./transport.js";

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.42.0.9",
    "localhost",
    "preview.localhost",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ])("recognizes local host %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.168.1.10", "mcp.example.com"])(
    "treats externally reachable host %s as remote",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe("normalizeListenHost", () => {
  it("unwraps bracketed IPv6 literals for node:http listen", () => {
    expect(normalizeListenHost("[::1]")).toBe("::1");
  });

  it("leaves ordinary hostnames and IPv4 literals unchanged", () => {
    expect(normalizeListenHost("localhost")).toBe("localhost");
    expect(normalizeListenHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("formatHttpEndpoint", () => {
  it("brackets IPv6 literals in user-facing URLs", () => {
    expect(formatHttpEndpoint("::1", 3000)).toBe("http://[::1]:3000/mcp");
  });

  it("leaves IPv4 and hostnames unbracketed", () => {
    expect(formatHttpEndpoint("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000/mcp");
    expect(formatHttpEndpoint("localhost", 3000)).toBe("http://localhost:3000/mcp");
  });
});

describe("resolveTransport", () => {
  const savedEnv = process.env.MCP_TRANSPORT;
  const savedTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MCP_TRANSPORT;
    else process.env.MCP_TRANSPORT = savedEnv;
    if (savedTty) Object.defineProperty(process.stdin, "isTTY", savedTty);
  });

  it("honors an explicit stdio argument", () => {
    expect(resolveTransport("stdio")).toBe("stdio");
  });

  it("honors an explicit http argument (case-insensitive)", () => {
    expect(resolveTransport("HTTP")).toBe("http");
  });

  it("falls back to MCP_TRANSPORT env var", () => {
    delete process.env.MCP_TRANSPORT;
    process.env.MCP_TRANSPORT = "http";
    expect(resolveTransport()).toBe("http");
  });

  it("auto-detects stdio when stdin is not a TTY (harness piping)", () => {
    delete process.env.MCP_TRANSPORT;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    expect(resolveTransport()).toBe("stdio");
  });

  it("auto-detects http when stdin is a TTY (human launch)", () => {
    delete process.env.MCP_TRANSPORT;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    expect(resolveTransport()).toBe("http");
  });

  it("throws on an unknown transport name", () => {
    expect(() => resolveTransport("carrier-pigeon")).toThrow(/Unknown transport/);
  });
});

describe("resolvePreviewLocality", () => {
  it("defaults stdio to local and HTTP to remote", () => {
    expect(resolvePreviewLocality("stdio", undefined, {})).toBe("local");
    expect(resolvePreviewLocality("http", undefined, {})).toBe("remote");
  });

  it("allows same-machine HTTP to opt into local viewer URLs", () => {
    expect(resolvePreviewLocality("http", "local", {})).toBe("local");
  });

  it("reads GENIE_PREVIEW_LOCALITY when no CLI value is provided", () => {
    expect(resolvePreviewLocality("http", undefined, { GENIE_PREVIEW_LOCALITY: "local" })).toBe(
      "local",
    );
  });

  it("prefers the CLI value over GENIE_PREVIEW_LOCALITY", () => {
    expect(resolvePreviewLocality("http", "remote", { GENIE_PREVIEW_LOCALITY: "local" })).toBe(
      "remote",
    );
  });

  it("rejects an unknown locality", () => {
    expect(() => resolvePreviewLocality("http", "nearby", {})).toThrow(/Unknown preview locality/);
  });
});

describe("startTransport", () => {
  it("records the resolved transport kind for request-time policy checks", async () => {
    const server = {
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpServer;

    await expect(startTransport(server, { kind: "stdio" })).resolves.toBe("stdio");
    expect(getServerTransportKind(server)).toBe("stdio");
  });

  it("clears the recorded kind and rethrows when connection startup fails", async () => {
    const server = {
      connect: vi.fn().mockRejectedValue(new Error("connect failed")),
    } as unknown as McpServer;

    await expect(startTransport(server, { kind: "stdio" })).rejects.toThrow("connect failed");
    expect(getServerTransportKind(server)).toBeUndefined();
  });

  it("requires an explicit HTTP server factory instead of silently cloning away caller tools", async () => {
    const server = createServer();
    server.registerTool("externally_added", { inputSchema: {} }, () => ({
      content: [{ type: "text", text: "present" }],
    }));

    await expect(startTransport(server, { kind: "http", port: -1 })).rejects.toThrow(
      /explicit serverFactory/,
    );
  });

  it("drains server resources when the stdio input reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new McpServer({ name: "stdio-eof-test", version: "0" });
    const dispose = vi.fn(async () => {});
    registerServerDisposer(server, dispose);

    try {
      await startTransport(server, {
        kind: "stdio",
        stdioInput: input,
        stdioOutput: output,
      });
      input.end();
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      await server.close();
    }
  });
});

describe("createStreamableHttpRequestHandler", () => {
  it("isolates initialize capabilities between concurrent HTTP client sessions", async () => {
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "capability-test", version: "0" });
      server.registerTool("capabilities", { inputSchema: {} }, () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(server.server.getClientCapabilities() ?? {}),
          },
        ],
      }));
      return server;
    };
    const http = createNodeHttpServer(createStreamableHttpRequestHandler(makeServer));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const uiClient = new Client(
      { name: "ui-client", version: "0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      },
    );
    const nonUiClient = new Client(
      { name: "tools-client", version: "0" },
      { capabilities: { extensions: {} } },
    );

    try {
      await uiClient.connect(new StreamableHTTPClientTransport(endpoint));
      await nonUiClient.connect(new StreamableHTTPClientTransport(endpoint));

      const uiResult = await uiClient.callTool({ name: "capabilities", arguments: {} });
      const nonUiResult = await nonUiClient.callTool({ name: "capabilities", arguments: {} });
      const text = (result: typeof uiResult): string =>
        (result.content?.[0] as { type?: string; text?: string } | undefined)?.text ?? "{}";

      expect(JSON.parse(text(uiResult))).toMatchObject({
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      });
      expect(JSON.parse(text(nonUiResult))).toMatchObject({ extensions: {} });
    } finally {
      await Promise.allSettled([uiClient.close(), nonUiClient.close()]);
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("evicts abandoned HTTP sessions after the idle timeout", async () => {
    const dispose = vi.fn(async () => {});
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "idle-test", version: "0" });
      registerServerDisposer(server, dispose);
      server.registerTool("ping", { inputSchema: {} }, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return server;
    };
    const http = createNodeHttpServer(
      createStreamableHttpRequestHandler(makeServer, { sessionIdleTimeoutMs: 25 }),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const transport = new StreamableHTTPClientTransport(endpoint);
    const client = new Client({ name: "abandoned-client", version: "0" });

    try {
      await client.connect(transport);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 75));

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId as string,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(404);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not expire a session while a request is active", async () => {
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "active-test", version: "0" });
      server.registerTool("slow", { inputSchema: {} }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { content: [{ type: "text", text: "done" }] };
      });
      server.registerTool("ping", { inputSchema: {} }, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return server;
    };
    const http = createNodeHttpServer(
      createStreamableHttpRequestHandler(makeServer, { sessionIdleTimeoutMs: 25 }),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const client = new Client({ name: "active-client", version: "0" });

    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      await expect(client.callTool({ name: "slow", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "done" }],
      });
      await expect(client.callTool({ name: "ping", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "pong" }],
      });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("disposes session resources on explicit HTTP termination", async () => {
    const dispose = vi.fn(async () => {});
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "terminate-test", version: "0" });
      registerServerDisposer(server, dispose);
      return server;
    };
    const http = createNodeHttpServer(createStreamableHttpRequestHandler(makeServer));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "terminating-client", version: "0" });

    try {
      await client.connect(transport);
      await transport.terminateSession();
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("counts a known-session POST as active while its body is still streaming", async () => {
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "slow-body-test", version: "0" });
      server.registerTool("ping", { inputSchema: {} }, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return server;
    };
    const http = createNodeHttpServer(
      createStreamableHttpRequestHandler(makeServer, { sessionIdleTimeoutMs: 25 }),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const transport = new StreamableHTTPClientTransport(endpoint);
    const client = new Client({ name: "slow-body-client", version: "0" });

    try {
      await client.connect(transport);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = nodeHttpRequest(
          endpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-session-id": transport.sessionId as string,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        const midpoint = Math.floor(body.length / 2);
        req.write(body.slice(0, midpoint));
        setTimeout(() => req.end(body.slice(midpoint)), 60);
      });

      expect(status).toBe(200);
      await transport.terminateSession();
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("disposes a session server when connection fails before initialization", async () => {
    const dispose = vi.fn(async () => {});
    const makeServer = (): McpServer => {
      const server = new McpServer({ name: "failed-init-test", version: "0" });
      registerServerDisposer(server, dispose);
      vi.spyOn(server, "connect").mockRejectedValue(new Error("connect failed"));
      return server;
    };
    const http = createNodeHttpServer(createStreamableHttpRequestHandler(makeServer));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "broken-client", version: "0" },
          },
        }),
      });

      expect(response.status).toBe(500);
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
