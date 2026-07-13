import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createToken,
  extractBearerToken,
  generateToken,
  isValidTokenFormat,
  listTokens,
  revokeToken,
  verifyToken,
} from "./bearer.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("bearer token auth", () => {
  let genieHome: string;

  beforeEach(async () => {
    genieHome = await tempDir("genie-auth-home-");
    process.env["GENIE_HOME"] = genieHome;
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    await rm(genieHome, { recursive: true, force: true });
  });

  it("generates tokens matching genie_<32-char-base32>", () => {
    const token = generateToken();
    expect(isValidTokenFormat(token)).toBe(true);
    expect(token.startsWith("genie_")).toBe(true);
    expect(token.length).toBe("genie_".length + 32);
  });

  it("creates a token, stores only the hash, and returns plaintext once", async () => {
    const { token, record } = await createToken({ sub: "user-1", scopes: ["read", "write"] });
    expect(isValidTokenFormat(token)).toBe(true);
    expect(record.hash).not.toBe(token);
    expect(record.prefix).toBe(token.slice(0, 12));
    expect(record.sub).toBe("user-1");
    expect(record.scopes).toEqual(["read", "write"]);
    expect(record.lastUsedAt).toBeNull();

    const raw = await readFile(join(genieHome, "auth", "tokens.json"), "utf-8");
    expect(raw).not.toContain(token);

    const info = await stat(join(genieHome, "auth", "tokens.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("defaults to read scope when none is given", async () => {
    const { record } = await createToken({ sub: "user-2" });
    expect(record.scopes).toEqual(["read"]);
  });

  it("verifies a valid token and updates lastUsedAt", async () => {
    const { token } = await createToken({ sub: "user-3" });
    const result = await verifyToken(token);
    expect(result.ok).toBe(true);
    expect(result.record?.sub).toBe("user-3");
    expect(result.record?.lastUsedAt).not.toBeNull();
  });

  it("rejects a well-formed but unknown token", async () => {
    await createToken({ sub: "user-4" });
    const result = await verifyToken(generateToken());
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed token without touching the store", async () => {
    const result = await verifyToken("not-a-real-token");
    expect(result.ok).toBe(false);
  });

  it("lists tokens without plaintext", async () => {
    await createToken({ sub: "user-5" });
    const tokens = await listTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].sub).toBe("user-5");
    expect(Object.keys(tokens[0])).not.toContain("token");
  });

  it("revokes a token by prefix and refuses it afterward", async () => {
    const { token, record } = await createToken({ sub: "user-6" });
    const removed = await revokeToken(record.prefix);
    expect(removed).toBe(1);
    const result = await verifyToken(token);
    expect(result.ok).toBe(false);
  });

  it("revoke is a no-op for an unknown prefix", async () => {
    const removed = await revokeToken("genie_doesnotexist");
    expect(removed).toBe(0);
  });

  it("extracts a bearer token from an Authorization header", () => {
    expect(extractBearerToken("Bearer genie_abc")).toBe("genie_abc");
    expect(extractBearerToken("bearer genie_abc")).toBe("genie_abc");
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic xyz")).toBeUndefined();
    expect(extractBearerToken("")).toBeUndefined();
  });
});
