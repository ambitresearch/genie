/**
 * Shared plumbing for viewer suites that need the REAL shipped `static/` shell
 * served over http:// to a real browser.
 *
 * Extracted for #247 (`browse-contrast.test.ts`) rather than copy-pasted: the
 * "serve a temp root containing the real viewer + the fixture kit" recipe is
 * the only honest way to read *computed* colours, and a second inline copy of
 * it would be the exact kind of drift this repo's review loop rejects.
 *
 * `a11y.test.ts` still carries its own inline equivalents. That is deliberate:
 * #247's scope is Browse E2E + contrast pinning, and rewiring a 1,100-line
 * audit suite with a known co-scheduling flake is not a change this PR should
 * smuggle in. The two are equivalent in behaviour; deduping `a11y.test.ts`
 * onto this module is a clean, isolated follow-up.
 *
 * Why http:// and not `file://`: `viewer.js`'s non-inline boot path calls
 * `fetch("./.genie/manifest.json")`, which a `file://` origin rejects. This is
 * the same reasoning `a11y.test.ts` documents.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile, mkdtemp, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The real shipped viewer assets — the artefact under test, never a copy. */
export const STATIC_DIR = resolve(HERE, "../../static");
/** The two-group fixture kit already used by grid-renderer/static-index/a11y. */
export const FIXTURE_KIT_DIR = resolve(HERE, "../fixtures/kit");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * True when `candidate` resolves to `root` itself or something beneath it.
 *
 * Segment-aware by construction: `relative()` yields a `..`-leading path (or an
 * absolute one, e.g. across Windows drives) exactly when `candidate` escapes,
 * which a string-prefix comparison cannot detect.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** Serve `root` read-only over plain http — no Vite, no bundler, no mocks. */
export function serveDir(root: string): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let relPath = decodeURIComponent(url.pathname);
        if (relPath === "/") relPath = "/index.html";
        const filePath = join(root, relPath);
        // Only ever serves in-process fixture content, but there is no reason
        // to skip a traversal guard.
        //
        // This must be segment-aware, not a `startsWith` prefix test: the
        // pathname is percent-decoded above, so `/%2e%2e%2f<root>-sibling/x`
        // joins to a real sibling directory that shares the root's string
        // prefix and would otherwise be served. Mirrors the containment check
        // in `packages/server/src/plans/index.ts` (`isPathInsideLocalDir`).
        if (!isInsideRoot(root, filePath)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    })();
  });
}

/** Bind to an ephemeral loopback port and resolve to it. */
export function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
      else reject(new Error("server.address() did not yield a port"));
    });
  });
}

/** Close a server started by {@link listen}. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

/**
 * Build a temp root holding the real `static/` shell plus the fixture kit's
 * manifest, previews and tokens, so `fetch("./.genie/manifest.json")` and each
 * card iframe `src` resolve exactly as they do in a shipped kit.
 *
 * @param prefix — mkdtemp prefix, so concurrent suites get distinct roots.
 * @returns absolute path to the temp root (caller owns cleanup).
 */
export async function buildViewerRoot(prefix = "genie-viewer-static-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await cp(join(STATIC_DIR, "index.html"), join(dir, "index.html"));
  await cp(join(STATIC_DIR, "viewer-browse.js"), join(dir, "viewer-browse.js"));
  await cp(join(STATIC_DIR, "viewer.js"), join(dir, "viewer.js"));
  await cp(join(STATIC_DIR, "viewer.css"), join(dir, "viewer.css"));
  await mkdir(join(dir, ".genie"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, ".genie/manifest.json"), join(dir, ".genie/manifest.json"));
  await cp(join(FIXTURE_KIT_DIR, "components"), join(dir, "components"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, "tokens"), join(dir, "tokens"), { recursive: true });
  return dir;
}
