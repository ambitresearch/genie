/**
 * M4-04 (DRO-266) — HMR bridge: per-card refresh via a second, independent
 * WebSocket, no full-page reload.
 *
 * ── Why this can't just be Vite's `handleHotUpdate` plugin hook ─────────────
 * A spike (booting a real Vite 8.1.3 dev server against a fixture kit, before
 * writing this file) confirmed: `preview.html` is never `import`ed as an ES
 * module — it's only ever the `src` of a sandboxed `<iframe>` — so it's absent
 * from Vite's module graph. `handleHotUpdate` returning `[]` (the documented
 * "I handled this, suppress the default" contract) does NOT suppress Vite's
 * own `{type:"full-reload"}` broadcast for such a file: `updateModules` takes
 * its hard-coded "page reload" branch whenever `ctx.modules.length === 0`,
 * before a plugin's returned filter is even consulted. So per-card
 * suppression happens client-side (the multi-page HTML entries never load
 * `@vite/client` at all — see `viewer.js`'s own header), and the real signal
 * rides a SECOND, independent WebSocket on `/__genie_hmr`, exactly as AC1
 * specifies.
 *
 * ── Why this reuses `server.watcher`, not a second chokidar instance ───────
 * The same spike confirmed Vite's OWN internal chokidar instance
 * (`server.watcher`, already watching the kit root because `root` is one of
 * its watch targets) already fires `change`/`add`/`unlink` for every
 * `preview.html`/`tokens/**`/`styles.css` edit. Reusing it (via
 * `configureServer(server) { server.watcher.on(...) }`) avoids a redundant,
 * competing filesystem watcher — and sidesteps the M3-02 server-package
 * watcher entirely, which (confirmed before writing this) has zero
 * production call sites today; wiring THAT watcher in is out of scope for a
 * viewer-package issue that already has a file-change signal cheaply
 * available from Vite itself.
 *
 * ── Coexistence with Vite's own HMR WebSocket (empirically load-bearing) ───
 * Vite registers its OWN `upgrade` listener on the same `httpServer` before
 * any plugin's `configureServer` hook runs (confirmed by reading Vite's
 * `createWebSocketServer` call site, which happens ahead of the
 * `configureServer` hook loop). Node delivers a given `upgrade` event to
 * EVERY listener registered on that server, not just the first to act on it
 * — so a listener that unconditionally `socket.destroy()`s on a pathname
 * mismatch can tear down a socket a SIBLING listener already claimed.
 * Verified directly: pairing a naive destroy-on-mismatch listener with a
 * real Vite dev server's own `vite-hmr` WebSocket produced `open` followed
 * immediately by `close code=1006` on Vite's own client. The fix (and what
 * `createHmrPlugin` does below) is the `ws` README's own documented
 * "multiple servers sharing a single HTTP server" pattern: a mismatched
 * pathname is a silent no-op (`return`), never a `socket.destroy()`. Verified
 * this coexists cleanly against a real Vite dev server (this plugin's path
 * still opens and receives broadcasts; Vite's own `vite-hmr` subprotocol
 * connection is unaffected).
 *
 * ── Teardown (empirically load-bearing) ─────────────────────────────────────
 * `httpServer.close()` alone never closes an already-upgraded WebSocket:
 * once the `upgrade` event fires, Node detaches that socket from the http
 * server's ordinary connection tracking, so `close()`'s callback can hang
 * indefinitely waiting on a socket it no longer has any lever over (verified:
 * `close()` never resolved even after 5s; `closeAllConnections()` doesn't
 * reach it either). Vite's own `server.close()` sidesteps this by closing its
 * `ws` transport directly and separately rather than relying on
 * `httpServer.close()` to cascade into it. `createHmrPlugin` follows the same
 * shape by wrapping `httpServer.close` to `terminate()` every client this
 * plugin's own `wss` is tracking before delegating to the original `close`
 * (mirroring this package's own `noStoreHtmlPlugin` `res.setHeader`-wrapping
 * precedent in `config.ts`) — verified this resolves in low single-digit ms
 * with no dangling socket, and is a no-op-safe if a client already died via
 * some other path (e.g. Vite's own teardown destroying the raw socket first).
 *
 * ── Design: pure `wireWatcher` + a thin real-WebSocket `configureServer` ────
 * `wireWatcher(root, watcher, broadcast)` is the pure classification/
 * dispatch core — given anything duck-typing chokidar's `on(event, cb)`
 * surface and a `broadcast` callback, it wires the three raw fs events to
 * zero-or-one `HmrMessage` per change. `createHmrPlugin()` is a thin shell:
 * it creates the real `ws.WebSocketServer`, teaches it to claim only
 * `/__genie_hmr` upgrade requests, and calls `wireWatcher` with a `broadcast`
 * that fans a JSON message out to every connected client.
 *
 * AC coverage map (DRO-266):
 *   - AC1 — `createHmrPlugin()` registers a WebSocket server on `/__genie_hmr`
 *     that pushes `{ event: "card.changed", path }` on a
 *     `components/**\/preview.html` change.
 *   - AC5 — a `tokens/**` or root `styles.css` change instead broadcasts
 *     `{ event: "tokens.changed" }` (no single `path` — it means "every
 *     card", see `viewer.js`'s handling of this event).
 *   - Anything outside those two glob groups (e.g. `.genie/manifest.json`
 *     itself, or an unrelated root file) is NOT forwarded.
 *   - `path` is always kit-root-relative POSIX (forward slashes on every OS),
 *     matching `card.path` in `.genie/manifest.json` / the rendered grid's
 *     `data-path`, so `viewer.js` can match one against the other with a
 *     plain string comparison.
 */
import { posix } from "node:path";

import { WebSocketServer } from "ws";
import type { Plugin, ViteDevServer } from "vite";

/** AC1's exact required WebSocket endpoint path. */
export const GENIE_HMR_PATH = "/__genie_hmr";

/** The two broadcastable HMR events (AC1 + AC5). */
export type HmrMessage = { event: "card.changed"; path: string } | { event: "tokens.changed" };

/** Result of classifying a single changed path against the AC1/AC5 groups. */
export type HmrClassification = { kind: "card"; path: string } | { kind: "tokens" };

/**
 * Duck-typed subset of chokidar's `FSWatcher` this module actually needs:
 * `on("change"|"add"|"unlink", cb)`. Kept minimal (rather than importing
 * chokidar's own type) so {@link wireWatcher} can be driven by a plain
 * `EventEmitter` in tests without a real chokidar instance.
 */
export interface HmrWatcherLike {
  on(event: "change" | "add" | "unlink", listener: (path: string) => void): unknown;
}

const CARD_GLOB_RE = /(?:^|\/)components\/.+\/preview\.html$/;

/**
 * Classifies an absolute (or already-relative) changed path against the two
 * groups AC1/AC5 name, relative to `root`. Returns `undefined` for anything
 * outside both groups — including `.genie/manifest.json` (the COMPILED
 * artefact, not a source the developer edits) and a nested, non-root
 * `styles.css` (only the kit-root import-closure entry counts for AC5).
 *
 * `path` in a `"card"` result is always kit-root-relative POSIX (forward
 * slashes on every OS, backslashes normalised), matching `card.path` in
 * `.genie/manifest.json` and the grid's own `data-path` attribute — so
 * `viewer.js` can match one against the other with a plain `===`.
 */
export function classifyHmrPath(root: string, changedPath: string): HmrClassification | undefined {
  // Normalise BOTH sides to forward slashes before computing the relative
  // path: chokidar/Vite always report native-OS paths, and a test may also
  // feed in a Windows-style path on a POSIX host (or vice versa) — the
  // node:path "native" `relative()` would misinterpret a backslash-separated
  // input as a single path *segment* on POSIX, producing a bogus result. Using
  // `posix.relative` on two already-slash-normalised inputs sidesteps that
  // entirely, regardless of which OS this process is actually running on.
  const normalizedRoot = root.split("\\").join("/");
  const normalizedChanged = changedPath.split("\\").join("/");
  const rel = posix.relative(normalizedRoot, normalizedChanged);

  // A path outside root (relative() would start with "..") can't be any of
  // ours — defensive, not expected in practice since chokidar only ever
  // reports paths under what it was told to watch.
  if (rel.startsWith("..")) return undefined;

  if (rel === "styles.css") return { kind: "tokens" };
  if (rel === "tokens" || rel.startsWith("tokens/")) return { kind: "tokens" };
  if (CARD_GLOB_RE.test(rel)) return { kind: "card", path: rel };

  return undefined;
}

/**
 * AC1/AC5 — pure event-forwarding core. Wires `change`/`add`/`unlink` on
 * anything duck-typing chokidar's `on` surface to zero-or-one call to
 * `broadcast` per event, via {@link classifyHmrPath}. Exported standalone so
 * the classification/dispatch logic is testable without a real WebSocket or
 * a real chokidar instance.
 */
export function wireWatcher(
  root: string,
  watcher: HmrWatcherLike,
  broadcast: (message: HmrMessage) => void,
): void {
  function handle(path: string): void {
    const classified = classifyHmrPath(root, path);
    if (!classified) return;
    if (classified.kind === "card") {
      broadcast({ event: "card.changed", path: classified.path });
    } else {
      broadcast({ event: "tokens.changed" });
    }
  }

  watcher.on("change", handle);
  watcher.on("add", handle);
  watcher.on("unlink", handle);
}

/**
 * AC1 — the Vite plugin. Serve-only (never runs during `vite build`, which
 * has no dev server / watcher to hook). `configureServer` is a no-op when
 * `server.httpServer` is `null` (Vite's own middleware-mode contract — no
 * raw http server to attach a WebSocket upgrade listener to).
 *
 * Coexistence + teardown behavior are covered in this file's header; both are
 * empirically load-bearing, not stylistic choices.
 */
export function createHmrPlugin(): Plugin {
  return {
    name: "genie-viewer:hmr",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer;
      if (!httpServer) return; // middleware mode — nothing to attach an upgrade listener to.

      const wss = new WebSocketServer({ noServer: true });

      httpServer.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url ?? "", "http://localhost");
        // Not ours: a silent no-op, NEVER socket.destroy() — see this file's
        // header. Node hands this same event to every registered listener
        // (Vite's own included), so destroying here can tear down a
        // connection a sibling listener already claimed.
        if (pathname !== GENIE_HMR_PATH) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      // See this file's header ("Teardown"): httpServer.close() alone never
      // reaches an already-upgraded socket, so we fold our own clients'
      // teardown into the same call, mirroring config.ts's noStoreHtmlPlugin
      // res.setHeader-wrapping precedent. Guarded: a fake test double may
      // duck-type only the `on`/`upgrade` surface (no `close` at all), so
      // this wrap is skipped rather than throwing against such a double.
      if (typeof httpServer.close === "function") {
        const originalClose = httpServer.close.bind(httpServer);
        httpServer.close = function patchedClose(
          this: typeof httpServer,
          callback?: (err?: Error) => void,
        ): typeof httpServer {
          for (const client of wss.clients) client.terminate();
          return originalClose(callback);
        } as typeof httpServer.close;
      }

      function broadcast(message: HmrMessage): void {
        const payload = JSON.stringify(message);
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) client.send(payload);
        }
      }

      wireWatcher(server.config.root, server.watcher, broadcast);
    },
  };
}
