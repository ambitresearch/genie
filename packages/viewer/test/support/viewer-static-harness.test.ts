/**
 * Regression cover for {@link serveDir}'s containment guard.
 *
 * `serveDir` only ever hosts in-process fixture content, but it is still a real
 * HTTP server bound to loopback for the lifetime of a browser suite, so its
 * traversal guard has to actually hold. The original guard compared the joined
 * path against the root with `String.prototype.startsWith`, which is a *string*
 * prefix test rather than a *path segment* test: with a root of `…/kit-abc`, a
 * request that decodes to `/../kit-abc-sibling/secret.txt` joins to
 * `…/kit-abc-sibling/secret.txt`, which still starts with `…/kit-abc` and was
 * therefore served. These tests pin the segment-aware behaviour so that bug
 * cannot silently return.
 *
 * Requests are issued with `node:http` rather than `fetch` on purpose: `fetch`
 * may normalise the request target before it reaches the wire, and the whole
 * point here is to control the exact bytes of the request path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { serveDir, listen, closeServer } from "./viewer-static-harness.js";

interface RawResponse {
  status: number;
  body: string;
}

/** GET `path` verbatim — no URL normalisation between here and the server. */
function rawGet(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

const SECRET = "outside-the-root";

describe("viewer-static-harness serveDir containment", () => {
  let base = "";
  let root = "";
  let siblingName = "";
  let server: Server | undefined;
  let port = 0;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "genie-harness-guard-"));
    // `root` and `sibling` deliberately share a string prefix: `sibling` is
    // `<root>-sibling`, which is exactly the shape a `startsWith` guard misses.
    root = join(base, "kit");
    siblingName = `${basename(root)}-sibling`;
    const sibling = join(base, siblingName);
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html><title>ok</title>", "utf8");
    await writeFile(join(sibling, "secret.txt"), SECRET, "utf8");

    server = serveDir(root);
    port = await listen(server);
  }, 30_000);

  afterAll(async () => {
    if (server) await closeServer(server);
    if (base) await rm(base, { recursive: true, force: true });
  }, 30_000);

  it("serves a legitimate file from inside the root", async () => {
    const res = await rawGet(port, "/index.html");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>ok</title>");
  });

  it("maps / to index.html", async () => {
    const res = await rawGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>ok</title>");
  });

  it("refuses a percent-encoded escape into a prefix-sharing sibling directory", async () => {
    // Decodes to `/../kit-sibling/secret.txt`; `join` resolves it to a real
    // file that a `startsWith(root)` check would have happily served.
    const res = await rawGet(port, `/%2e%2e%2f${siblingName}/secret.txt`);
    expect(res.body).not.toContain(SECRET);
    expect(res.status).not.toBe(200);
  });

  it("refuses a plain relative escape", async () => {
    const res = await rawGet(port, `/../${siblingName}/secret.txt`);
    expect(res.body).not.toContain(SECRET);
    expect(res.status).not.toBe(200);
  });

  it("refuses a percent-encoded escape to an absolute path outside the root", async () => {
    const res = await rawGet(
      port,
      `/%2e%2e%2f%2e%2e%2f${basename(base)}/${siblingName}/secret.txt`,
    );
    expect(res.body).not.toContain(SECRET);
    expect(res.status).not.toBe(200);
  });
});
