import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { parse } from "parse5";

/** Optional stable port for hosts that must advertise frame origins before a request. */
export const CARD_ASSET_PORT_ENV = "GENIE_CARD_ASSET_PORT";

const LOOPBACK_ADDRESS = "127.0.0.1" as const;
const OPAQUE_TOKEN_BYTES = 16;
const EMBEDDED_CARD_CSP_DIRECTIVES = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];
const NO_INLINE_CARD_CSP = [
  EMBEDDED_CARD_CSP_DIRECTIVES[0],
  "script-src 'self'",
  "style-src 'self'",
  ...EMBEDDED_CARD_CSP_DIRECTIVES.slice(1),
].join("; ");
const CARD_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export interface CardAssetBrokerOptions {
  /**
   * TCP port for the process-scoped asset listener. `0` asks the OS for an
   * ephemeral port. The explicit option wins over `GENIE_CARD_ASSET_PORT`.
   */
  port?: number;
  /** Injectable environment for deterministic composition and tests. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A kit-specific opaque route on the process-scoped loopback origin. */
export interface CardAssetKit {
  readonly kitId: string;
  readonly token: string;
  readonly routePrefix: string;
  readonly hostname: string;
  readonly authority: string;
  readonly origin: string;
  /** Build an absolute URL from a logical, kit-relative POSIX path. */
  urlFor(path: string): string;
}

/** One loopback listener intended to live for the MCP server process lifetime. */
export interface CardAssetBroker {
  readonly address: typeof LOOPBACK_ADDRESS;
  readonly port: number;
  registerKit(kitId: string, root: string): Promise<CardAssetKit>;
  getKit(kitId: string): CardAssetKit | undefined;
  /** Immutable snapshot for exact MCP App `frameDomains` composition. */
  frameOrigins(): readonly string[];
  close(): Promise<void>;
}

interface RegisteredKit {
  public: CardAssetKit;
  lexicalRoot: string;
  realRoot: string;
}

interface ParsedHtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedHtmlNode[];
}

const SAFE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return SAFE_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function cspSha256(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

function rawText(node: ParsedHtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(rawText).join("");
}

function inlineCspHashes(html: string): {
  scripts: string[];
  styles: string[];
  styleAttributes: string[];
} {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const styleAttributes = new Set<string>();
  const root = parse(html) as unknown as ParsedHtmlNode;

  function visit(node: ParsedHtmlNode): void {
    if (node.tagName === "script") {
      const hasSrc = node.attrs?.some((attr) => attr.name.toLowerCase() === "src") ?? false;
      const content = rawText(node);
      if (!hasSrc && content !== "") scripts.add(cspSha256(content));
    } else if (node.tagName === "style") {
      const content = rawText(node);
      if (content !== "") styles.add(cspSha256(content));
    }
    for (const attribute of node.attrs ?? []) {
      if (attribute.name.toLowerCase() === "style") {
        styleAttributes.add(cspSha256(attribute.value));
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  }

  visit(root);
  return {
    scripts: [...scripts],
    styles: [...styles],
    styleAttributes: [...styleAttributes],
  };
}

function cardCsp(html?: string): string {
  if (html === undefined) return NO_INLINE_CARD_CSP;
  const hashes = inlineCspHashes(html);
  const scriptSrc = ["script-src 'self'", ...hashes.scripts].join(" ");
  const styleSrc = [
    "style-src 'self'",
    ...(hashes.styleAttributes.length === 0 ? [] : ["'unsafe-hashes'"]),
    ...hashes.styles,
    ...hashes.styleAttributes,
  ].join(" ");
  return [
    EMBEDDED_CARD_CSP_DIRECTIVES[0],
    scriptSrc,
    styleSrc,
    ...EMBEDDED_CARD_CSP_DIRECTIVES.slice(1),
  ].join("; ");
}

function parsePort(value: number | string, source: string): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || String(value).trim() === "") {
    throw new Error(`${source} must be an integer port between 0 and 65535.`);
  }
  return port;
}

function requestedPort(options: CardAssetBrokerOptions): number {
  if (options.port !== undefined) return parsePort(options.port, "Card asset broker port");
  const envValue = (options.env ?? process.env)[CARD_ASSET_PORT_ENV];
  return envValue === undefined ? 0 : parsePort(envValue, CARD_ASSET_PORT_ENV);
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function logicalPathSegments(path: string): string[] {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")) {
    throw new Error("Card asset path must be a non-empty, safe POSIX path.");
  }
  const withoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
  const segments = withoutLeadingSlash.split("/");
  if (
    withoutLeadingSlash.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Card asset path must remain inside its registered kit root.");
  }
  return segments;
}

function encodeLogicalPath(path: string): string {
  return logicalPathSegments(path)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeRequestPath(rawUrl: string | undefined): string[] | null {
  if (rawUrl === undefined || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (rawPath.includes("\\") || rawPath.includes("\0")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;

  const segments = decoded.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments;
}

function authorityFor(hostname: string, port: number): string {
  return port === 80 ? hostname : `${hostname}:${port}`;
}

function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...CARD_RESPONSE_HEADERS,
    "content-security-policy": NO_INLINE_CARD_CSP,
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end();
}

function isExpectedFileError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES";
}

class LoopbackCardAssetBroker implements CardAssetBroker {
  readonly address = LOOPBACK_ADDRESS;
  #port = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #server: Server;
  readonly #kitsById = new Map<string, RegisteredKit>();
  readonly #kitsByToken = new Map<string, RegisteredKit>();
  #authority = "";
  #origin = "";
  #frameOrigins: readonly string[] = Object.freeze([]);

  constructor() {
    this.#server = createServer((req, res) => {
      void this.#serve(req, res).catch(() => {
        if (!res.headersSent) sendEmpty(res, 500);
        else res.destroy();
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  async start(port: number): Promise<void> {
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error);
      this.#server.once("error", onError);
      this.#server.listen(port, this.address, () => {
        this.#server.off("error", onError);
        resolveStart();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string" || address.address !== this.address) {
      await this.close();
      throw new Error("Card asset broker failed to bind the IPv4 loopback address.");
    }
    this.#port = address.port;
    this.#authority = authorityFor(this.address, this.#port);
    this.#origin = `http://${this.#authority}`;
    this.#frameOrigins = Object.freeze([this.#origin]);
  }

  async registerKit(kitId: string, root: string): Promise<CardAssetKit> {
    if (this.#closed) throw new Error("Card asset broker is closed.");
    if (typeof kitId !== "string" || kitId.length === 0) {
      throw new Error("Card asset kit id must be non-empty.");
    }

    const lexicalRoot = resolve(root);
    let lexicalRootStats;
    try {
      lexicalRootStats = await lstat(lexicalRoot);
    } catch (error) {
      throw new Error(`Card asset kit root does not exist: ${lexicalRoot}`, { cause: error });
    }
    if (lexicalRootStats.isSymbolicLink()) {
      throw new Error(`Card asset kit root must not be a symlink: ${lexicalRoot}`);
    }
    if (!lexicalRootStats.isDirectory()) {
      throw new Error(`Card asset kit root must be a directory: ${lexicalRoot}`);
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(lexicalRoot);
    } catch (error) {
      throw new Error(`Card asset kit root does not exist: ${lexicalRoot}`, { cause: error });
    }

    let revalidatedLexicalRootStats;
    try {
      revalidatedLexicalRootStats = await lstat(lexicalRoot);
    } catch (error) {
      throw new Error(`Card asset kit root changed during registration: ${lexicalRoot}`, {
        cause: error,
      });
    }
    if (revalidatedLexicalRootStats.isSymbolicLink()) {
      throw new Error(`Card asset kit root must not be a symlink: ${lexicalRoot}`);
    }
    if (
      !revalidatedLexicalRootStats.isDirectory() ||
      revalidatedLexicalRootStats.dev !== lexicalRootStats.dev ||
      revalidatedLexicalRootStats.ino !== lexicalRootStats.ino
    ) {
      throw new Error(`Card asset kit root changed during registration: ${lexicalRoot}`);
    }

    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new Error(`Card asset kit root must be a directory: ${lexicalRoot}`);
    }

    const existing = this.#kitsById.get(kitId);
    if (existing !== undefined) {
      if (existing.realRoot !== canonicalRoot) {
        throw new Error(`Card asset kit ${JSON.stringify(kitId)} is already registered.`);
      }
      return existing.public;
    }

    let token: string;
    do {
      token = randomBytes(OPAQUE_TOKEN_BYTES).toString("hex");
    } while (this.#kitsByToken.has(token));

    const routePrefix = `/k/${token}`;
    const publicKit: CardAssetKit = Object.freeze({
      kitId,
      token,
      routePrefix,
      hostname: this.address,
      authority: this.#authority,
      origin: this.#origin,
      urlFor: (path: string): string => `${this.#origin}${routePrefix}/${encodeLogicalPath(path)}`,
    });
    const registered: RegisteredKit = {
      public: publicKit,
      lexicalRoot,
      realRoot: canonicalRoot,
    };
    this.#kitsById.set(kitId, registered);
    this.#kitsByToken.set(token, registered);
    return publicKit;
  }

  getKit(kitId: string): CardAssetKit | undefined {
    return this.#kitsById.get(kitId)?.public;
  }

  frameOrigins(): readonly string[] {
    return this.#frameOrigins;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = new Promise<void>((resolveClose, rejectClose) => {
      if (!this.#server.listening) {
        resolveClose();
        return;
      }
      this.#server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
      this.#server.closeAllConnections();
    });
    return this.#closePromise;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authority = req.headers.host?.toLowerCase();
    if (authority !== this.#authority) {
      sendEmpty(res, 421);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendEmpty(res, 405, { allow: "GET, HEAD" });
      return;
    }

    const segments = decodeRequestPath(req.url);
    if (segments === null) {
      sendEmpty(res, 400);
      return;
    }
    if (segments.length < 3 || segments[0] !== "k") {
      sendEmpty(res, 404);
      return;
    }
    const kit = this.#kitsByToken.get(segments[1]!);
    if (kit === undefined) {
      sendEmpty(res, 404);
      return;
    }
    const assetSegments = segments.slice(2);

    const lexicalFile = resolve(kit.lexicalRoot, ...assetSegments);
    if (!isContained(kit.lexicalRoot, lexicalFile)) {
      sendEmpty(res, 400);
      return;
    }

    let canonicalFile: string;
    try {
      canonicalFile = await realpath(lexicalFile);
    } catch (error) {
      if (isExpectedFileError(error)) {
        sendEmpty(res, 404);
        return;
      }
      throw error;
    }
    if (!isContained(kit.realRoot, canonicalFile)) {
      sendEmpty(res, 404);
      return;
    }

    let file;
    try {
      file = await open(canonicalFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isExpectedFileError(error)) {
        sendEmpty(res, 404);
        return;
      }
      throw error;
    }

    try {
      const fileStats = await file.stat();
      if (!fileStats.isFile()) {
        sendEmpty(res, 404);
        return;
      }

      // Re-resolve the requested path after opening it and require that the
      // name still identifies the same regular file. This narrows the window
      // in which an intermediate directory or final path can be swapped
      // between the initial realpath check and the open operation.
      let postOpenCanonicalFile: string;
      let postOpenStats;
      try {
        postOpenCanonicalFile = await realpath(lexicalFile);
        if (!isContained(kit.realRoot, postOpenCanonicalFile)) {
          sendEmpty(res, 404);
          return;
        }
        postOpenStats = await stat(postOpenCanonicalFile);
      } catch (error) {
        if (isExpectedFileError(error)) {
          sendEmpty(res, 404);
          return;
        }
        throw error;
      }
      if (
        !postOpenStats.isFile() ||
        postOpenStats.dev !== fileStats.dev ||
        postOpenStats.ino !== fileStats.ino
      ) {
        sendEmpty(res, 404);
        return;
      }

      const contentType = contentTypeFor(lexicalFile);
      if (contentType.startsWith("text/html")) {
        const bytes = await file.readFile();
        const commonHeaders = {
          ...CARD_RESPONSE_HEADERS,
          "content-security-policy": cardCsp(bytes.toString("utf8")),
          "content-type": contentType,
          "content-length": String(bytes.length),
        };
        res.writeHead(200, commonHeaders);
        if (req.method === "HEAD") res.end();
        else res.end(bytes);
        return;
      }

      const commonHeaders = {
        ...CARD_RESPONSE_HEADERS,
        "content-security-policy": NO_INLINE_CARD_CSP,
        "content-type": contentType,
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...commonHeaders, "content-length": String(fileStats.size) });
        res.end();
        return;
      }

      res.writeHead(200, { ...commonHeaders, "content-length": String(fileStats.size) });
      await pipeline(file.createReadStream({ autoClose: false }), res);
    } finally {
      await file.close();
    }
  }
}

/**
 * Start a process-scoped, loopback-only card asset broker.
 *
 * The promise resolves only after the concrete port is known, so callers can
 * safely publish each registration's exact `origin` in MCP App CSP metadata.
 */
export async function startCardAssetBroker(
  options: CardAssetBrokerOptions = {},
): Promise<CardAssetBroker> {
  const broker = new LoopbackCardAssetBroker();
  await broker.start(requestedPort(options));
  return broker;
}
