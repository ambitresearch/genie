import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTokenCli } from "./token-cli.js";
import { isValidTokenFormat, verifyToken } from "./bearer.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("genie token CLI", () => {
  let genieHome: string;

  beforeEach(async () => {
    genieHome = await tempDir("genie-token-cli-home-");
    process.env["GENIE_HOME"] = genieHome;
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(genieHome, { recursive: true, force: true });
  });

  it("shows help with no subcommand", async () => {
    const result = await runTokenCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("genie token");
  });

  it("creates a token and prints the plaintext exactly once", async () => {
    const result = await runTokenCli(["create", "--sub", "alice", "--scope", "write"]);
    expect(result.exitCode).toBe(0);
    const match = /genie_[A-Z2-7]{32}/.exec(result.output);
    expect(match).not.toBeNull();
    const token = match?.[0] as string;
    expect(isValidTokenFormat(token)).toBe(true);
    const verified = await verifyToken(token);
    expect(verified.ok).toBe(true);
    expect(verified.record?.sub).toBe("alice");
    expect(verified.record?.scopes).toEqual(["write"]);
  });

  it("defaults sub to 'default' and scope to read", async () => {
    const result = await runTokenCli(["create"]);
    expect(result.output).toContain("sub:    default");
    expect(result.output).toContain("scopes: read");
  });

  it("rejects an invalid --scope value", async () => {
    await expect(runTokenCli(["create", "--scope", "admin"])).rejects.toThrow();
  });

  it("lists tokens with metadata, no plaintext", async () => {
    await runTokenCli(["create", "--sub", "bob"]);
    const result = await runTokenCli(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("sub=bob");
    expect(result.output).toMatch(/hash=[a-f0-9]{64}/);
    expect(result.output).not.toMatch(/genie_[A-Z2-7]{32}/);
  });

  it("reports no tokens when store is empty", async () => {
    const result = await runTokenCli(["list"]);
    expect(result.output).toContain("No tokens.");
  });

  it("revokes a token by prefix", async () => {
    const created = await runTokenCli(["create", "--sub", "carol"]);
    const prefixMatch = /prefix: (\S+)/.exec(created.output);
    const prefix = prefixMatch?.[1] as string;
    const result = await runTokenCli(["revoke", prefix]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Revoked 1 token(s)");
  });

  it("revoke with unknown prefix exits nonzero", async () => {
    const result = await runTokenCli(["revoke", "genie_doesnotexist"]);
    expect(result.exitCode).toBe(1);
  });

  it("revoke with missing prefix exits nonzero", async () => {
    const result = await runTokenCli(["revoke"]);
    expect(result.exitCode).toBe(1);
  });

  it("unknown subcommand exits nonzero", async () => {
    const result = await runTokenCli(["bogus"]);
    expect(result.exitCode).toBe(1);
  });
});
