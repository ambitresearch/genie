/**
 * Static Bearer token authentication (M5-02, DRO-274).
 *
 * Covers harnesses that don't implement OAuth Dynamic Client Registration
 * (VS Code Copilot, Cline, Continue.dev): they attach a static
 * `Authorization: Bearer <token>` header on every MCP-over-HTTP request.
 * Tokens are minted out-of-band via the admin CLI (`genie token create`),
 * never re-derived from a password, and stored **hashed** (SHA-256) at
 * `${GENIE_HOME}/auth/tokens.json` so the plaintext token exists only at
 * mint time (shown once) and in the client's own header.
 *
 * Token format: `genie_<32-char-base32>` — deliberately similar to a GitHub
 * PAT (`ghp_...`) so it visually reads as "a secret, handle carefully" and
 * is easy to grep/rotate/revoke by prefix.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type TokenScope = "read" | "write";

/** A single stored token record — hash only, never the plaintext. */
export interface StoredToken {
  /** SHA-256 hex digest of the plaintext token. Acts as the record's key. */
  hash: string;
  /** First 12 chars of the plaintext (`genie_xxxxxxxx`) — safe to display/log. */
  prefix: string;
  sub: string;
  scopes: TokenScope[];
  createdAt: string; // ISO-8601
  lastUsedAt: string | null; // ISO-8601, updated on each successful auth
}

interface TokenStoreFile {
  tokens: StoredToken[];
}

const TOKEN_PREFIX = "genie_";
/** Crockford-ish base32 alphabet (no padding, unambiguous glyphs). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_BODY_LENGTH = 32;
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}[${BASE32_ALPHABET}]{${BASE32_BODY_LENGTH}}$`);

/** Get the auth directory path from GENIE_HOME. */
function getAuthDir(): string {
  const home = process.env.GENIE_HOME || resolve(process.cwd(), ".genie");
  return resolve(home, "auth");
}

function getTokensPath(): string {
  return resolve(getAuthDir(), "tokens.json");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Encode raw bytes as unpadded base32 using BASE32_ALPHABET. */
function base32Encode(buf: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out.slice(0, length);
}

/** Generate a new plaintext token: `genie_<32-char-base32>`. */
export function generateToken(): string {
  // 32 base32 chars needs ceil(32*5/8) = 20 bytes of entropy.
  const body = base32Encode(randomBytes(20), BASE32_BODY_LENGTH);
  return `${TOKEN_PREFIX}${body}`;
}

/** True if `token` matches the expected `genie_<32-char-base32>` shape. */
export function isValidTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Read the token store from disk. Returns an empty store if missing/corrupt. */
async function loadStore(): Promise<TokenStoreFile> {
  try {
    const content = await readFile(getTokensPath(), "utf-8");
    const parsed = JSON.parse(content) as TokenStoreFile;
    if (!Array.isArray(parsed.tokens)) return { tokens: [] };
    return parsed;
  } catch {
    return { tokens: [] };
  }
}

async function saveStore(store: TokenStoreFile): Promise<void> {
  const dir = getAuthDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getTokensPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

export interface CreateTokenOptions {
  sub: string;
  scopes?: TokenScope[];
}

/**
 * Mint a new token, persist its hash, and return the plaintext.
 * The plaintext is returned exactly once — callers (the CLI) must print it
 * and never log/store it themselves.
 */
export async function createToken(options: CreateTokenOptions): Promise<{
  token: string;
  record: StoredToken;
}> {
  const scopes =
    options.scopes && options.scopes.length > 0 ? options.scopes : (["read"] as TokenScope[]);
  const token = generateToken();
  const record: StoredToken = {
    hash: sha256Hex(token),
    prefix: token.slice(0, 12),
    sub: options.sub,
    scopes,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const store = await loadStore();
  store.tokens.push(record);
  await saveStore(store);
  return { token, record };
}

/** List all stored token records (hashes only — never plaintext). */
export async function listTokens(): Promise<StoredToken[]> {
  const store = await loadStore();
  return store.tokens;
}

/**
 * Revoke every stored token whose prefix starts with `prefix`. Returns the
 * number of tokens removed.
 */
export async function revokeToken(prefix: string): Promise<number> {
  const store = await loadStore();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => !t.prefix.startsWith(prefix));
  const removed = before - store.tokens.length;
  if (removed > 0) await saveStore(store);
  return removed;
}

/** Constant-time compare of two hex digests (equal length required). */
function hexTimingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface TokenVerificationResult {
  ok: boolean;
  record?: StoredToken;
}

/**
 * Verify a presented plaintext token against the store. Constant-time per
 * candidate hash comparison (AC: "constant-time crypto.timingSafeEqual").
 * On success, updates `lastUsedAt` for that record (AC4).
 */
export async function verifyToken(token: string): Promise<TokenVerificationResult> {
  if (!isValidTokenFormat(token)) return { ok: false };
  const candidateHash = sha256Hex(token);
  const store = await loadStore();
  let matched: StoredToken | undefined;
  // Iterate every record rather than short-circuiting on a Map lookup, so
  // comparison time doesn't leak whether *some* token existed vs none.
  for (const record of store.tokens) {
    if (hexTimingSafeEqual(record.hash, candidateHash)) {
      matched = record;
    }
  }
  if (matched === undefined) return { ok: false };
  matched.lastUsedAt = new Date().toISOString();
  await saveStore(store);
  return { ok: true, record: matched };
}

/** Extract a bearer token from an `Authorization` header value, if present. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}
