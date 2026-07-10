import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { getServerTransportKind, resolveTransport, startTransport } from "./transport.js";

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
});
