import { describe, it, expect, afterEach } from "vitest";
import { resolveTransport } from "./transport.js";

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
