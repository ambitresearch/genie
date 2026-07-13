import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

let beforeRealpath: ((path: string) => Promise<void>) | undefined;

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const realpath = async (path: Parameters<typeof actual.realpath>[0]): Promise<string> => {
    await beforeRealpath?.(path.toString());
    return actual.realpath(path);
  };
  return { ...actual, realpath };
});

import {
  CARD_ASSET_PORT_ENV,
  startCardAssetBroker,
  type CardAssetBroker,
  type CardAssetKit,
} from "./card-asset-broker.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const brokers: CardAssetBroker[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  beforeRealpath = undefined;
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function kitWithFiles(files: Record<string, string | Buffer>): Promise<string> {
  const kitRoot = await tempDirectory("genie-card-assets-");
  for (const [path, bytes] of Object.entries(files)) {
    const absolute = join(kitRoot, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, bytes);
  }
  return kitRoot;
}

async function start(
  options: Parameters<typeof startCardAssetBroker>[0] = {},
): Promise<CardAssetBroker> {
  const broker = await startCardAssetBroker(options);
  brokers.push(broker);
  return broker;
}

function fetchFromBroker(
  broker: CardAssetBroker,
  kit: CardAssetKit,
  path: string,
  options: { method?: string; authority?: string; rawPath?: boolean } = {},
): Promise<HttpResult> {
  let requestPath = path;
  if (!options.rawPath) {
    const [pathname = "", query] = path.split("?", 2);
    const routed = new URL(kit.urlFor(pathname));
    if (query !== undefined) routed.search = query;
    requestPath = `${routed.pathname}${routed.search}`;
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: broker.address,
        port: broker.port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: { host: options.authority ?? kit.authority },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function cspHash(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

describe("card asset broker origins", () => {
  it("binds only 127.0.0.1 and exposes the concrete ephemeral port after startup", async () => {
    const broker = await start({ port: 0, env: {} });

    expect(broker.address).toBe("127.0.0.1");
    expect(broker.port).toBeGreaterThan(0);
    expect(Number.isInteger(broker.port)).toBe(true);
  });

  it("honours an explicit port, with the option taking precedence over the environment", async () => {
    const probe = await start({ port: 0, env: {} });
    const port = probe.port;
    await probe.close();

    const broker = await start({ port, env: { [CARD_ASSET_PORT_ENV]: "1" } });
    expect(broker.port).toBe(port);
  });

  it("accepts a stable port from GENIE_CARD_ASSET_PORT and rejects invalid values", async () => {
    const probe = await start({ port: 0, env: {} });
    const port = probe.port;
    await probe.close();

    const broker = await start({ env: { [CARD_ASSET_PORT_ENV]: String(port) } });
    expect(broker.port).toBe(port);

    await expect(startCardAssetBroker({ env: { [CARD_ASSET_PORT_ENV]: "nope" } })).rejects.toThrow(
      CARD_ASSET_PORT_ENV,
    );
    await expect(startCardAssetBroker({ port: -1, env: {} })).rejects.toThrow("port");
  });

  it("uses one stable loopback origin and opaque, distinct route tokens for every kit", async () => {
    const broker = await start({ env: {} });
    const rootA = await kitWithFiles({ "card.html": "A" });
    const rootB = await kitWithFiles({ "card.html": "B" });

    const a = await broker.registerKit("customer-dashboard", rootA);
    const again = await broker.registerKit("customer-dashboard", rootA);
    const b = await broker.registerKit("marketing-site", rootB);

    expect(again).toBe(a);
    expect(a.hostname).toBe("127.0.0.1");
    expect(a.authority).toBe(`127.0.0.1:${broker.port}`);
    expect(a.origin).toBe(`http://127.0.0.1:${broker.port}`);
    expect(b.origin).toBe(a.origin);
    expect(a.token).toMatch(/^[a-f0-9]{32}$/);
    expect(b.token).toMatch(/^[a-f0-9]{32}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.routePrefix).toBe(`/k/${a.token}`);
    expect(b.routePrefix).toBe(`/k/${b.token}`);
    expect(a.routePrefix).not.toContain("customer-dashboard");
    expect(b.routePrefix).not.toContain("marketing-site");
    expect(broker.getKit("customer-dashboard")).toBe(a);
  });

  it("returns the same frozen origin tuple before and after registrations", async () => {
    const broker = await start({ env: {} });
    const rootA = await kitWithFiles({ "card.html": "A" });
    const rootB = await kitWithFiles({ "card.html": "B" });

    const before = broker.frameOrigins();
    await broker.registerKit("a", rootA);
    const afterA = broker.frameOrigins();
    await broker.registerKit("b", rootB);
    const afterB = broker.frameOrigins();

    expect(before).toEqual([`http://127.0.0.1:${broker.port}`]);
    expect(Object.isFrozen(before)).toBe(true);
    expect(afterA).toBe(before);
    expect(afterB).toBe(before);
  });

  it("keeps one root per kit id instead of silently repointing an established origin", async () => {
    const broker = await start({ env: {} });
    const rootA = await kitWithFiles({ "card.html": "A" });
    const rootB = await kitWithFiles({ "card.html": "B" });
    await broker.registerKit("kit", rootA);

    await expect(broker.registerKit("kit", rootB)).rejects.toThrow("already registered");
  });

  it("builds encoded card URLs and rejects unsafe logical paths", async () => {
    const broker = await start({ env: {} });
    const root = await kitWithFiles({ "components/My Badge/card.html": "ok" });
    const kit = await broker.registerKit("kit", root);

    expect(kit.urlFor("components/My Badge/card.html")).toBe(
      `${kit.origin}${kit.routePrefix}/components/My%20Badge/card.html`,
    );
    expect(kit.urlFor("/components/My Badge/card.html")).toBe(
      `${kit.origin}${kit.routePrefix}/components/My%20Badge/card.html`,
    );
    expect(() => kit.urlFor("../outside.html")).toThrow("path");
    expect(() => kit.urlFor("dir\\outside.html")).toThrow("path");
    expect(() => kit.urlFor("bad\0name.html")).toThrow("path");
  });
});

describe("card asset serving", () => {
  it("hash-allows each inline script/style without enabling inline event handlers", async () => {
    const scriptA = "globalThis.a = 1;";
    const scriptB = "globalThis.b = 2;";
    const styleA = ".a { color: red; }";
    const styleB = ".b { color: blue; }";
    const root = await kitWithFiles({
      "components/StatusBadge/card.html": [
        `<style>${styleA}</style>`,
        `<style media="screen">${styleB}</style>`,
        `<script>${scriptA}</script>`,
        `<script type="module">${scriptB}</script>`,
        '<script src="../../../assets/card.js"></script>',
        '<button onclick="globalThis.clicked = true">Unsafe handler</button>',
      ].join(""),
    });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("status", root);

    const response = await fetchFromBroker(broker, kit, "/components/StatusBadge/card.html");
    const policy = response.headers["content-security-policy"];

    expect(policy).toBeTypeOf("string");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("font-src 'none'");
    expect(policy).toContain(`script-src 'self' ${cspHash(scriptA)} ${cspHash(scriptB)}`);
    expect(policy).toContain(`style-src 'self' ${cspHash(styleA)} ${cspHash(styleB)}`);
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-hashes'");
  });

  it("hash-allows exact style attributes without weakening script attributes", async () => {
    const inlineStyle = "color: rgb(12, 34, 56); display: inline-block";
    const root = await kitWithFiles({
      "components/StatusBadge/card.html":
        `<button style="${inlineStyle}" onclick="globalThis.clicked = true">` +
        "Styled safely</button>",
    });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("status", root);

    const response = await fetchFromBroker(broker, kit, "/components/StatusBadge/card.html");
    const policy = String(response.headers["content-security-policy"]);
    const scriptDirective = policy.split("; ").find((part) => part.startsWith("script-src"));
    const styleDirective = policy.split("; ").find((part) => part.startsWith("style-src"));

    expect(styleDirective).toContain("'unsafe-hashes'");
    expect(styleDirective).toContain(cspHash(inlineStyle));
    expect(scriptDirective).not.toContain("'unsafe-hashes'");
    expect(scriptDirective).not.toContain(cspHash("globalThis.clicked = true"));
    expect(policy).not.toContain("'unsafe-inline'");
  });

  it("uses a strict no-inline CSP for non-HTML assets", async () => {
    const root = await kitWithFiles({ "assets/card.js": "globalThis.ready = true;" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("status", root);

    const response = await fetchFromBroker(broker, kit, "/assets/card.js");
    const policy = response.headers["content-security-policy"];

    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toMatch(/sha256-/);
    expect(policy).not.toContain("unsafe");
  });

  it("serves GET bytes unchanged with exact lengths and safe MIME headers", async () => {
    const binary = Buffer.from([0x00, 0xff, 0x13, 0x0a, 0x80]);
    const html = "<!doctype html>\n<script>globalThis.cardRan = true</script>\n";
    const root = await kitWithFiles({
      "components/StatusBadge/card.html": html,
      "assets/pixels.unknown": binary,
      "assets/runtime.js": "globalThis.ready = true;",
    });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("status", root);

    const htmlResponse = await fetchFromBroker(
      broker,
      kit,
      "/components/StatusBadge/card.html?cache=bust",
    );
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.body).toEqual(Buffer.from(html));
    expect(htmlResponse.headers["content-length"]).toBe(String(Buffer.byteLength(html)));
    expect(htmlResponse.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(htmlResponse.headers["x-content-type-options"]).toBe("nosniff");

    const binaryResponse = await fetchFromBroker(broker, kit, "/assets/pixels.unknown");
    expect(binaryResponse.status).toBe(200);
    expect(binaryResponse.body).toEqual(binary);
    expect(binaryResponse.headers["content-type"]).toBe("application/octet-stream");

    const scriptResponse = await fetchFromBroker(broker, kit, "/assets/runtime.js");
    expect(scriptResponse.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  it("prevents referrer disclosure on successful and rejected responses", async () => {
    const root = await kitWithFiles({ "card.html": "safe" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const [served, rejected] = await Promise.all([
      fetchFromBroker(broker, kit, "/card.html"),
      fetchFromBroker(broker, kit, "/card.html", {
        authority: `localhost:${broker.port}`,
      }),
    ]);

    expect(served.status).toBe(200);
    expect(served.headers["referrer-policy"]).toBe("no-referrer");
    expect(rejected.status).toBe(421);
    expect(rejected.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("streams GET bodies instead of buffering them with FileHandle.readFile", async () => {
    const bytes = Buffer.alloc(128 * 1024, 0x5a);
    const root = await kitWithFiles({ "assets/large.bin": bytes });
    const probe = await open(join(root, "assets/large.bin"));
    const readFile = vi
      .spyOn(Object.getPrototypeOf(probe) as { readFile: () => Promise<Buffer> }, "readFile")
      .mockRejectedValue(new Error("whole-file reads are forbidden"));
    await probe.close();
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    try {
      const response = await fetchFromBroker(broker, kit, "/assets/large.bin");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(bytes);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it("serves HEAD with the GET headers and no body", async () => {
    const bytes = "body { color: rebeccapurple; }";
    const root = await kitWithFiles({ "tokens/theme.css": bytes });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const response = await fetchFromBroker(broker, kit, "/tokens/theme.css", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(0);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(bytes)));
    expect(response.headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("uses opaque routes to isolate identical paths in different kits", async () => {
    const rootA = await kitWithFiles({ "tokens/theme.css": "--brand: red" });
    const rootB = await kitWithFiles({ "tokens/theme.css": "--brand: blue" });
    const broker = await start({ env: {} });
    const a = await broker.registerKit("a", rootA);
    const b = await broker.registerKit("b", rootB);

    const [responseA, responseB] = await Promise.all([
      fetchFromBroker(broker, a, "/tokens/theme.css"),
      fetchFromBroker(broker, b, "/tokens/theme.css"),
    ]);

    expect(responseA.body.toString()).toBe("--brand: red");
    expect(responseB.body.toString()).toBe("--brand: blue");

    const crossKit = await fetchFromBroker(broker, a, `${b.routePrefix}/tokens/theme.css`, {
      rawPath: true,
    });
    expect(crossKit.body.toString()).toBe("--brand: blue");
    expect(crossKit.body.toString()).not.toBe("--brand: red");
  });

  it("returns no bytes for unknown tokens or paths that omit a token", async () => {
    const root = await kitWithFiles({ "secret.html": "do not leak" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const [unknown, missing] = await Promise.all([
      fetchFromBroker(broker, kit, `/k/${"0".repeat(32)}/secret.html`, { rawPath: true }),
      fetchFromBroker(broker, kit, "/secret.html", { rawPath: true }),
    ]);

    expect(unknown.status).toBe(404);
    expect(unknown.body).not.toContain(Buffer.from("do not leak"));
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain(Buffer.from("do not leak"));
  });

  it("does not mistake a safe filename beginning with two dots for parent traversal", async () => {
    const root = await kitWithFiles({ "..theme.css": "--safe: true" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const response = await fetchFromBroker(broker, kit, "/..theme.css");

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("--safe: true");
  });

  it("rejects unknown or incorrectly ported Host authorities", async () => {
    const root = await kitWithFiles({ "secret.html": "do not leak" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const unknown = await fetchFromBroker(broker, kit, "/secret.html", {
      authority: `localhost:${broker.port}`,
    });
    const wrongPort = await fetchFromBroker(broker, kit, "/secret.html", {
      authority: `${broker.address}:${broker.port + 1}`,
    });

    expect(unknown.status).toBe(421);
    expect(unknown.body).not.toContain(Buffer.from("do not leak"));
    expect(wrongPort.status).toBe(421);
  });

  it.each([
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/safe/%2E%2E%2Fsecret.txt",
    "/safe%5c..%5csecret.txt",
    "/safe\\..\\secret.txt",
    "/bad%00name.txt",
    "/bad%ZZname.txt",
    "/bad%E0%A4%Aname.txt",
  ])("rejects malformed or traversal request target %s", async (path) => {
    const root = await kitWithFiles({ "safe/file.txt": "safe" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const response = await fetchFromBroker(broker, kit, `${kit.routePrefix}${path}`, {
      rawPath: true,
    });

    expect(response.status).toBe(400);
  });

  it("enforces both lexical and realpath containment, including symlinked directories", async () => {
    const root = await kitWithFiles({ "inside.txt": "inside" });
    const outside = await tempDirectory("genie-card-outside-");
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(outside, "secret.txt"), join(root, "file-link.txt"));
    await symlink(outside, join(root, "directory-link"));
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const [fileLink, directoryLink] = await Promise.all([
      fetchFromBroker(broker, kit, "/file-link.txt"),
      fetchFromBroker(broker, kit, "/directory-link/secret.txt"),
    ]);

    expect(fileLink.status).toBe(404);
    expect(fileLink.body).not.toContain(Buffer.from("outside secret"));
    expect(directoryLink.status).toBe(404);
    expect(directoryLink.body).not.toContain(Buffer.from("outside secret"));
  });

  it("rejects an opened file when its post-open path resolves to a different inode", async () => {
    const root = await kitWithFiles({ "components/card.html": "opened original" });
    const cardPath = join(root, "components/card.html");
    const displacedPath = join(root, "components/card.original.html");
    const probe = await open(cardPath);
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: () => ReturnType<typeof probe.stat>;
    };
    const originalStat = fileHandlePrototype.stat;
    await probe.close();
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);
    let swapped = false;
    const statSpy = vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function () {
      if (!swapped) {
        swapped = true;
        await rename(cardPath, displacedPath);
        await writeFile(cardPath, "replacement bytes");
      }
      return originalStat.call(this);
    });

    try {
      const response = await fetchFromBroker(broker, kit, "/components/card.html");

      expect(swapped).toBe(true);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(Buffer.from("opened original"));
      expect(response.body).not.toContain(Buffer.from("replacement bytes"));
    } finally {
      statSpy.mockRestore();
    }
  });

  it("returns 404 for missing files/directories and 405 for unsupported methods", async () => {
    const root = await kitWithFiles({ "nested/file.txt": "hello" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const [missing, directory, post] = await Promise.all([
      fetchFromBroker(broker, kit, "/missing.txt"),
      fetchFromBroker(broker, kit, "/nested"),
      fetchFromBroker(broker, kit, "/nested/file.txt", { method: "POST" }),
    ]);

    expect(missing.status).toBe(404);
    expect(directory.status).toBe(404);
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });
});

describe("card asset broker lifecycle", () => {
  it("closes idempotently and refuses new registrations after close", async () => {
    const root = await kitWithFiles({ "card.html": "ok" });
    const broker = await start({ env: {} });
    const kit = await broker.registerKit("kit", root);

    const first = broker.close();
    const second = broker.close();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(broker.registerKit("new-kit", root)).rejects.toThrow("closed");
    await expect(fetchFromBroker(broker, kit, "/card.html")).rejects.toThrow();
  });

  it("rejects missing and non-directory kit roots at registration", async () => {
    const dir = await tempDirectory("genie-card-root-");
    const file = join(dir, "file.txt");
    await writeFile(file, "not a directory");
    const broker = await start({ env: {} });

    await expect(broker.registerKit("missing", join(dir, "missing"))).rejects.toThrow();
    await expect(broker.registerKit("file", file)).rejects.toThrow("directory");
  });

  it("rejects a symlink used as the registered kit root", async () => {
    const realRoot = await kitWithFiles({ "card.html": "secret" });
    const parent = await tempDirectory("genie-card-root-link-");
    const linkedRoot = join(parent, "kit");
    await symlink(realRoot, linkedRoot);
    const broker = await start({ env: {} });

    await expect(broker.registerKit("linked", linkedRoot)).rejects.toThrow(/symlink/i);
    expect(broker.getKit("linked")).toBeUndefined();
  });

  it("rejects a kit root swapped to a symlink between lstat and realpath", async () => {
    const parent = await tempDirectory("genie-card-root-race-");
    const lexicalRoot = join(parent, "kit");
    const displacedRoot = join(parent, "kit.original");
    await mkdir(lexicalRoot);
    await writeFile(join(lexicalRoot, "card.html"), "secret");
    const broker = await start({ env: {} });
    let swapped = false;
    beforeRealpath = async (path) => {
      if (path !== lexicalRoot || swapped) return;
      swapped = true;
      await rename(lexicalRoot, displacedRoot);
      await symlink(displacedRoot, lexicalRoot);
    };

    await expect(broker.registerKit("swapped", lexicalRoot)).rejects.toThrow(/symlink|changed/i);
    expect(swapped).toBe(true);
    expect(broker.getKit("swapped")).toBeUndefined();
  });
});
