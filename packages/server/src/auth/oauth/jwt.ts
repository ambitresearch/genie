import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT sign/verify — no external deps (RFC 7519 subset used by genie's OAuth). */

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function base64urlToBuffer(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export interface JwtPayload {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  client_id: string;
  [key: string]: unknown;
}

export function signJwtHS256(payload: JwtPayload, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

export class JwtVerificationError extends Error {}

export function verifyJwtHS256(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError("Malformed JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64urlToBuffer(encodedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtVerificationError("Invalid signature");
  }
  const payload = JSON.parse(base64urlToBuffer(encodedPayload).toString("utf8")) as JwtPayload;
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
    throw new JwtVerificationError("Token expired");
  }
  return payload;
}
