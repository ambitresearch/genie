/**
 * M4-04 (DRO-266) — tests for the server-side HMR bridge
 * (`packages/viewer/src/hmr-plugin.ts`).
 *
 * ── Why this can't just be Vite's `handleHotUpdate` plugin hook ─────────────
 * A spike (booting a real Vite 8.1.3 dev server against a fixture kit, before
 * writing this suite) confirmed: `preview.html` is never `import`ed as an ES
 * module — it's only ever the `src` of a sandboxed `<iframe>` — so it's absent
 * from Vite's module graph. `handleHotUpdate` returning `[]` (the documented
 * "I handled this, suppress the default" contract) does NOT suppress Vite's
 * own `{type:"full-reload"}` broadcast for such a file: `updateModules` takes
 * its hard-coded "page reload" branch whenever `ctx.modules.length === 0`,
 * before a plugin's returned filter is even consulted. So per-card
 * suppression has to happen client-side (the multi-page HTML entries never
 * load `@vite/client` at all — see `viewer.js`'s own header), and the real
 * signal rides a SECOND, independent WebSocket on `/__genie_hmr`, exactly as
 * AC1 specifies.
 *
 * ── Why this reuses `server.watcher`, not a second chokidar instance ───────
 * The same spike confirmed Vite's OWN internal chokidar instance
 * (`server.watcher`, already watching the kit root because `root` is one of
 * its watch targets — see vite's `_createServer`) already fires `change`/
 * `add`/`unlink` for every `preview.html`/`tokens/**`/`styles.css` edit.
 * Reusing it (via `configureServer(server) { server.watcher.on(...) }`)
 * avoids a redundant, competing filesystem watcher — and sidesteps the M3-02
 * server-package watcher entirely, which (confirmed before writing this) has
 * zero production call sites today; wiring THAT watcher in is out of scope
 * for a viewer-package issue that already has a file-change signal cheaply
 * available from Vite itself.
 *
 * ── Design: pure `wireWatcher` + a thin real-WebSocket `configureServer` ────
 * `wireWatcher(root, watcher, broadcast)` is the pure classification/
 * dispatch core — given anything duck-typing chokidar's `on(event, cb)`
 * surface and a `broadcast` callback, it wires the three raw fs events to
 * zero-or-one `HmrMessage` per change. `createHmrPlugin()` is a thin shell:
 * it creates the real `ws.WebSocketServer`, teaches it to claim only
 * `/__genie_hmr` upgrade requests (co-existing with Vite's own `vite-hmr`
 * listener on the same `httpServer` — verified in the earlier spike that two
 * independent `upgrade` listeners, each filtering by pathname, don't fight),
 * and calls `wireWatcher` with a `broadcast` that fans a JSON message out to
 * every connected client. This mirrors this very package's own `cli.ts`
 * seam pattern (`BootDeps`/`ShutdownDeps` — real IO behind an injectable
 * interface) and `viewer.js`'s "pure functions + guarded auto-boot" split.
 *
 * AC coverage map (DRO-266):
 *   - AC1 — `createHmrPlugin()` registers a WebSocket server on `/__genie_hmr`
 *     that pushes `{ event: "card.changed", path }` on a
 *     `components/**\/preview.html` change.
 *   - AC5 — a `tokens/**` or root `styles.css` change instead broadcasts
 *     `{ event: "tokens.changed" }` (no single `path` — it means "every card",
 *     see `viewer.js`'s handling of this event).
 *   - Anything outside those two glob groups (e.g. `.genie/manifest.json`
 *     itself, or an unrelated root file) is NOT forwarded.
 *   - `path` is always kit-root-relative POSIX (forward slashes on every OS),
 *     matching `card.path` in `.genie/manifest.json` / the rendered grid's
 *     `data-path`, so `viewer.js` can match one against the other with a
 *     plain string comparison.
 */
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";

import { classifyHmrPath, createHmrPlugin, GENIE_HMR_PATH, wireWatcher } from "./hmr-plugin.js";
import type { HmrMessage } from "./hmr-plugin.js";

const ROOT = "/kits/acme";

// ── classifyHmrPath (pure glob classification) ──────────────────────────────

describe("classifyHmrPath", () => {
  it("classifies a components/**/preview.html change as 'card' with a kit-relative POSIX path", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/components/actions/Button/preview.html`)).toEqual({
      kind: "card",
      path: "components/actions/Button/preview.html",
    });
  });

  it("classifies a nested multi-group preview.html correctly", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/components/surfaces/PricingCard/preview.html`)).toEqual({
      kind: "card",
      path: "components/surfaces/PricingCard/preview.html",
    });
  });

  it("classifies a tokens/** change as 'tokens' (AC5)", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/tokens/colors.css`)).toEqual({ kind: "tokens" });
  });

  it("classifies a nested tokens/ subdirectory change as 'tokens' too", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/tokens/nested/deep.css`)).toEqual({ kind: "tokens" });
  });

  it("classifies the root styles.css change as 'tokens' (AC5 — import-closure root)", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/styles.css`)).toEqual({ kind: "tokens" });
  });

  it("does NOT classify a nested styles.css (only the root one is the import-closure entry)", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/components/actions/Button/styles.css`)).toBeUndefined();
  });

  it("does NOT classify .genie/manifest.json itself (the compiled artefact, not a source)", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/.genie/manifest.json`)).toBeUndefined();
  });

  it("does NOT classify an unrelated root file", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}/README.md`)).toBeUndefined();
    expect(classifyHmrPath(ROOT, `${ROOT}/meta.json`)).toBeUndefined();
  });

  it("does NOT classify a non-preview.html file inside components/ (e.g. a .tsx source)", () => {
    // The manifest compiler's own source watches .tsx/.d.ts/.md too, but the
    // VIEWER only ever renders preview.html as an iframe src — reloading a
    // card on an unrelated .tsx save (which the iframe doesn't even fetch)
    // would be a spurious reload with no visible effect.
    expect(classifyHmrPath(ROOT, `${ROOT}/components/actions/Button/Button.tsx`)).toBeUndefined();
  });

  it("normalises a Windows-style backslash path to forward slashes in the output", () => {
    expect(classifyHmrPath(ROOT, `${ROOT}\\components\\actions\\Button\\preview.html`)).toEqual({
      kind: "card",
      path: "components/actions/Button/preview.html",
    });
  });

  it("GENIE_HMR_PATH is the exact AC1 endpoint path", () => {
    expect(GENIE_HMR_PATH).toBe("/__genie_hmr");
  });
});

// ── wireWatcher (pure event-forwarding core) ────────────────────────────────

describe("wireWatcher (AC1/AC5) — event forwarding", () => {
  it("registers change/add/unlink listeners on the watcher", () => {
    const watcher = new EventEmitter();
    wireWatcher(ROOT, watcher, () => {});
    expect(watcher.listenerCount("change")).toBeGreaterThan(0);
    expect(watcher.listenerCount("add")).toBeGreaterThan(0);
    expect(watcher.listenerCount("unlink")).toBeGreaterThan(0);
  });

  it("broadcasts { event: 'card.changed', path } when a preview.html changes", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("change", `${ROOT}/components/actions/Button/preview.html`);

    expect(sent).toEqual([
      { event: "card.changed", path: "components/actions/Button/preview.html" },
    ]);
  });

  it("broadcasts { event: 'card.changed', path } on an 'add' too (a brand-new preview.html)", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("add", `${ROOT}/components/surfaces/Card/preview.html`);

    expect(sent).toEqual([
      { event: "card.changed", path: "components/surfaces/Card/preview.html" },
    ]);
  });

  it("broadcasts { event: 'card.changed', path } on an 'unlink' too (card removed)", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("unlink", `${ROOT}/components/actions/Button/preview.html`);

    expect(sent).toEqual([
      { event: "card.changed", path: "components/actions/Button/preview.html" },
    ]);
  });

  it("broadcasts { event: 'tokens.changed' } (AC5) for a tokens/ change, without a path", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("change", `${ROOT}/tokens/colors.css`);

    expect(sent).toEqual([{ event: "tokens.changed" }]);
  });

  it("broadcasts { event: 'tokens.changed' } for the root styles.css (AC5)", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("change", `${ROOT}/styles.css`);

    expect(sent).toEqual([{ event: "tokens.changed" }]);
  });

  it("does not broadcast anything for an unrelated file change", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("change", `${ROOT}/.genie/manifest.json`);
    watcher.emit("change", `${ROOT}/README.md`);

    expect(sent).toEqual([]);
  });

  it("forwards multiple distinct card changes as separate messages, in order", () => {
    const watcher = new EventEmitter();
    const sent: HmrMessage[] = [];
    wireWatcher(ROOT, watcher, (msg) => sent.push(msg));

    watcher.emit("change", `${ROOT}/components/actions/Button/preview.html`);
    watcher.emit("change", `${ROOT}/components/surfaces/Card/preview.html`);

    expect(sent).toEqual([
      { event: "card.changed", path: "components/actions/Button/preview.html" },
      { event: "card.changed", path: "components/surfaces/Card/preview.html" },
    ]);
  });
});

// ── createHmrPlugin — the real Vite plugin shell (AC1) ──────────────────────

/** A minimal fake ViteDevServer good enough for configureServer's needs. */
function fakeServer(root: string): {
  server: ViteDevServer;
  watcher: EventEmitter;
  httpServer: EventEmitter & { listening: boolean };
} {
  const watcher = new EventEmitter();
  const httpServer = Object.assign(new EventEmitter(), { listening: true });
  const server = {
    config: { root },
    watcher,
    httpServer,
  } as unknown as ViteDevServer;
  return { server, watcher, httpServer };
}

describe("createHmrPlugin", () => {
  it("has the expected Vite plugin name", () => {
    const plugin = createHmrPlugin();
    expect(plugin.name).toBe("genie-viewer:hmr");
  });

  it("applies only in serve (dev) mode, never during build", () => {
    const plugin = createHmrPlugin();
    expect(plugin.apply).toBe("serve");
  });

  it("wires server.watcher via configureServer", () => {
    const plugin = createHmrPlugin();
    const { server, watcher } = fakeServer(ROOT);
    (plugin.configureServer as (s: ViteDevServer) => void)(server);
    expect(watcher.listenerCount("change")).toBeGreaterThan(0);
  });

  it("does nothing (no throw) when server.httpServer is null (middleware mode)", () => {
    const plugin = createHmrPlugin();
    const { server } = fakeServer(ROOT);
    (server as unknown as { httpServer: null }).httpServer = null;
    expect(() => (plugin.configureServer as (s: ViteDevServer) => void)(server)).not.toThrow();
  });
});

// ── Real WebSocket integration (upgrade handshake + broadcast end-to-end) ───

describe("createHmrPlugin — real WebSocket upgrade + broadcast (integration)", () => {
  let httpServer: HttpServer | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    // terminate() (forceful), not close(): a socket still mid-handshake (the
    // /other-path non-claim case) ignores a polite close, and we want teardown
    // deterministic regardless of each socket's state.
    for (const ws of sockets) ws.terminate();
    sockets = [];
    if (httpServer) {
      const server = httpServer;
      httpServer = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Force-drop any lingering raw socket the ordinary close() would wait on
        // — notably a foreign-path `upgrade` socket the plugin correctly left
        // unclaimed (no sibling listener adopts it in this isolated unit test,
        // so nothing else would ever close it). Available since Node 18.2.
        server.closeAllConnections?.();
      });
    }
  });

  async function bootRealServer(root: string): Promise<{ port: number; watcher: EventEmitter }> {
    const watcher = new EventEmitter();
    httpServer = createHttpServer((_req, res) => res.end("ok"));
    const server = {
      config: { root },
      watcher,
      httpServer,
    } as unknown as ViteDevServer;

    const plugin = createHmrPlugin();
    (plugin.configureServer as (s: ViteDevServer) => void)(server);

    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP port");
    }
    return { port: address.port, watcher };
  }

  it("a real WebSocket client connects to /__genie_hmr and receives a card.changed broadcast", async () => {
    const { port, watcher } = await bootRealServer(ROOT);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${GENIE_HMR_PATH}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const messageP = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });

    watcher.emit("change", `${ROOT}/components/actions/Button/preview.html`);

    await expect(messageP).resolves.toEqual({
      event: "card.changed",
      path: "components/actions/Button/preview.html",
    });
  });

  it("broadcasts to ALL connected clients, not just the first", async () => {
    const { port, watcher } = await bootRealServer(ROOT);

    const wsA = new WebSocket(`ws://127.0.0.1:${port}${GENIE_HMR_PATH}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${port}${GENIE_HMR_PATH}`);
    sockets.push(wsA, wsB);
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        wsA.on("open", () => resolve());
        wsA.on("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        wsB.on("open", () => resolve());
        wsB.on("error", reject);
      }),
    ]);

    const gotA = new Promise<unknown>((resolve) =>
      wsA.on("message", (d) => resolve(JSON.parse(d.toString()))),
    );
    const gotB = new Promise<unknown>((resolve) =>
      wsB.on("message", (d) => resolve(JSON.parse(d.toString()))),
    );

    watcher.emit("change", `${ROOT}/tokens/colors.css`);

    await expect(gotA).resolves.toEqual({ event: "tokens.changed" });
    await expect(gotB).resolves.toEqual({ event: "tokens.changed" });
  });

  it("closing the underlying http server also closes the genie HMR websocket clients", async () => {
    const { port } = await bootRealServer(ROOT);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${GENIE_HMR_PATH}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.on("close", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

// ── Upgrade routing — silent no-op on a foreign path (coexistence contract) ─
//
// Driven at the LISTENER level (not via a real TCP client) on purpose. The
// plugin's whole coexistence design is that a pathname mismatch is a SILENT
// no-op — never `socket.destroy()` — so it can share one httpServer with
// Vite's own `upgrade` listener (Node fans each `upgrade` event out to EVERY
// listener; destroying here would tear down a socket a sibling already
// claimed — see hmr-plugin.ts header, "Coexistence"). Asserting that against a
// REAL server is a trap: the unclaimed raw socket is, by Node's own design,
// detached from the http server on `upgrade` and thus unreachable by
// `close()`/`closeAllConnections()`, so it wedges teardown (the plugin header
// documents exactly this). Emitting a synthetic `upgrade` with a spy socket
// proves the real contract — "not mine → don't touch it" — deterministically
// and with nothing to tear down.

describe("createHmrPlugin — upgrade routing (silent no-op on a foreign path)", () => {
  /** Registers the plugin on a fake server and returns its `upgrade` handler. */
  function upgradeHandlerFor(root: string): (req: unknown, socket: unknown, head: unknown) => void {
    const plugin = createHmrPlugin();
    const { server, httpServer } = fakeServer(root);
    (plugin.configureServer as (s: ViteDevServer) => void)(server);
    const listeners = httpServer.listeners("upgrade") as Array<
      (req: unknown, socket: unknown, head: unknown) => void
    >;
    expect(listeners).toHaveLength(1);
    return listeners[0]!;
  }

  /** A socket double that records whether the plugin tried to tear it down. */
  function spySocket(): { socket: unknown; destroyed: () => boolean; wrote: () => boolean } {
    let destroyed = false;
    let wrote = false;
    const socket = {
      destroy() {
        destroyed = true;
      },
      write() {
        wrote = true;
        return true;
      },
      end() {
        wrote = true;
      },
    };
    return { socket, destroyed: () => destroyed, wrote: () => wrote };
  }

  it("does NOT destroy (or write to) a socket whose upgrade path is not /__genie_hmr", () => {
    const handler = upgradeHandlerFor(ROOT);
    const spy = spySocket();
    handler({ url: "/other-path" }, spy.socket, Buffer.alloc(0));
    // The core of the coexistence contract: a foreign path is untouched — no
    // destroy (which would kill a sibling listener's socket), no handshake
    // write (which would wrongly claim it).
    expect(spy.destroyed()).toBe(false);
    expect(spy.wrote()).toBe(false);
  });

  it("also leaves Vite's own vite-hmr upgrade path untouched (never claims it)", () => {
    const handler = upgradeHandlerFor(ROOT);
    const spy = spySocket();
    // Vite's own HMR socket upgrades on the server root path; the genie plugin
    // must not destroy or answer it.
    handler({ url: "/" }, spy.socket, Buffer.alloc(0));
    expect(spy.destroyed()).toBe(false);
    expect(spy.wrote()).toBe(false);
  });

  it("tolerates a missing request url (defensive: no throw, no destroy)", () => {
    const handler = upgradeHandlerFor(ROOT);
    const spy = spySocket();
    expect(() => handler({}, spy.socket, Buffer.alloc(0))).not.toThrow();
    expect(spy.destroyed()).toBe(false);
  });
});
