/**
 * Tests for M3-02's chokidar watcher (`packages/server/src/watch/watcher.ts`),
 * tracking issue DRO-258 (spec `docs/github/issues/M3-02-chokidar-watcher.md`).
 *
 * Covers every AC:
 *   - AC1 — `startWatcher(projectRoot, onChange)` is exported and callable.
 *   - AC2 — the 4 glob groups (`components/**\/*.{html,tsx,d.ts,md}`,
 *     `tokens/**`, `styles.css`, `meta.json`) are watched, and paths outside
 *     them are NOT reported.
 *   - AC3 — a burst of back-to-back events inside a 100 ms window collapses
 *     to a single `onChange` flush per type.
 *   - AC4 — `onChange` receives `{ type: "preview" | "tokens" | "manifest",
 *     paths: string[] }`.
 *   - AC5 — `usePolling` can be forced on (the Docker-volume fallback),
 *     verified by observing chokidar still detects a change under polling.
 *   - AC6 — the returned `stop()` tears the watcher down; no further
 *     `onChange` calls fire afterwards, and `stop()` is idempotent.
 *   - AC7 — each flushed cycle logs one JSON line to stderr shaped
 *     `{ event: "watcher.cycle", added, changed, deleted, debouncedTo }`.
 *
 * Uses real temp directories + real filesystem writes + real (short) timers —
 * matches this repo's existing convention (`list_files.test.ts`,
 * `write_files.test.ts`): chokidar's own internals need real timers to fire,
 * so `vi.useFakeTimers()` would not exercise the real debounce path.
 */
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWatcher, type WatcherChange } from "./watcher.js";

// Real debounce window per AC3; give assertions comfortable headroom above it
// so the suite isn't flaky on a loaded CI box, without waiting so long the
// suite becomes slow.
const DEBOUNCE_MS = 100;
const SETTLE_MS = DEBOUNCE_MS + 250;

async function tempProjectRoot(): Promise<string> {
  return import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "genie-watch-")));
}

/** Scaffold the directories the watcher's globs need to exist under. */
async function scaffold(root: string): Promise<void> {
  await mkdir(join(root, "components", "actions"), { recursive: true });
  await mkdir(join(root, "tokens"), { recursive: true });
}

describe("startWatcher", () => {
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(async () => {
    root = await tempProjectRoot();
    await scaffold(root);
    stderrLines = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (stop) {
      await stop();
      stop = undefined;
    }
    await rm(root, { recursive: true, force: true });
  });

  // ─── AC1 ─────────────────────────────────────────────────────────────────

  it("AC1: exports startWatcher and returns a handle with a stop() function", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    expect(typeof handle.stop).toBe("function");
  });

  // ─── AC2 / AC4 — classification into preview | tokens | manifest ─────────

  it("AC2/AC4: classifies a components/**/*.html change as type 'preview'", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150); // let the initial scan (ignoreInitial: false) settle first
    onChange.mockClear();

    await writeFile(join(root, "components", "actions", "Button.html"), "<div/>");
    await sleep(SETTLE_MS);

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCalls.length).toBe(1);
    expect(previewCalls[0]![0].paths).toEqual([join(root, "components", "actions", "Button.html")]);
  });

  it("AC2/AC4: classifies components/**/*.tsx, *.d.ts, and *.md as 'preview' too", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    await writeFile(join(root, "components", "actions", "Button.tsx"), "export {}");
    await writeFile(join(root, "components", "actions", "Button.d.ts"), "export {}");
    await writeFile(join(root, "components", "actions", "Button.prompt.md"), "# prompt");
    await sleep(SETTLE_MS);

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    // One burst covering all three adds -> one debounced flush.
    expect(previewCalls.length).toBe(1);
    expect(new Set(previewCalls[0]![0].paths)).toEqual(
      new Set([
        join(root, "components", "actions", "Button.tsx"),
        join(root, "components", "actions", "Button.d.ts"),
        join(root, "components", "actions", "Button.prompt.md"),
      ]),
    );
  });

  it("AC2/AC4: classifies a tokens/** change as type 'tokens'", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    await writeFile(join(root, "tokens", "colors.css"), ":root {}");
    await sleep(SETTLE_MS);

    const tokensCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "tokens");
    expect(tokensCalls.length).toBe(1);
    expect(tokensCalls[0]![0].paths).toEqual([join(root, "tokens", "colors.css")]);
  });

  it("AC2/AC4: classifies root styles.css and meta.json changes as type 'manifest'", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    await writeFile(join(root, "styles.css"), "body {}");
    await writeFile(join(root, "meta.json"), "{}");
    await sleep(SETTLE_MS);

    const manifestCalls = onChange.mock.calls.filter(
      ([c]: [WatcherChange]) => c.type === "manifest",
    );
    expect(manifestCalls.length).toBe(1);
    expect(new Set(manifestCalls[0]![0].paths)).toEqual(
      new Set([join(root, "styles.css"), join(root, "meta.json")]),
    );
  });

  it("AC2: does NOT report a file outside the 4 watched glob groups", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    // A sibling file at the project root that isn't styles.css/meta.json,
    // and a nested meta.json under a component dir (only the ROOT meta.json
    // is watched per AC2's literal `${projectRoot}/meta.json` glob).
    await writeFile(join(root, "random.txt"), "unwatched");
    await mkdir(join(root, "components", "actions", "Button"), { recursive: true });
    await writeFile(join(root, "components", "actions", "Button", "meta.json"), "{}");
    // Also an unlisted extension inside components/ (.jsx isn't in the AC2 set).
    await writeFile(join(root, "components", "actions", "Button.jsx"), "export {}");
    await sleep(SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  // ─── AC3 — debounce ────────────────────────────────────────────────────

  it("AC3: collapses a burst of back-to-back events within the 100ms window into one flush", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    // Fire 5 rapid writes well inside the debounce window.
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, "components", "actions", `Comp${i}.html`), `<div>${i}</div>`);
    }
    await sleep(SETTLE_MS);

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCalls.length).toBe(1);
    expect(previewCalls[0]![0].paths.length).toBe(5);
  });

  it("AC3: two bursts separated by more than the debounce window produce two flushes", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    await writeFile(join(root, "components", "actions", "First.html"), "<div/>");
    await sleep(SETTLE_MS);
    await writeFile(join(root, "components", "actions", "Second.html"), "<div/>");
    await sleep(SETTLE_MS);

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCalls.length).toBe(2);
  });

  it("AC3: independent debounce windows per type — a tokens burst doesn't hold back a ready preview flush", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    // Start a preview change first...
    await writeFile(join(root, "components", "actions", "Button.html"), "<div/>");
    // ...then, before the preview debounce window elapses, start a fresh
    // tokens burst that keeps re-arming ITS OWN window.
    await sleep(40);
    await writeFile(join(root, "tokens", "a.css"), "a");
    await sleep(40);
    await writeFile(join(root, "tokens", "b.css"), "b");
    // The preview window (armed at t=0) should have already flushed by
    // ~t=100; the tokens window (last armed at t=40, re-armed at t=80)
    // flushes around t=180. Sample at t=150: preview must be flushed,
    // tokens must NOT be flushed yet.
    await sleep(70); // total elapsed since first write ~150ms
    expect(onChange.mock.calls.some(([c]: [WatcherChange]) => c.type === "preview")).toBe(true);
    expect(onChange.mock.calls.some(([c]: [WatcherChange]) => c.type === "tokens")).toBe(false);

    // Now let the tokens window finish too.
    await sleep(SETTLE_MS);
    const tokensCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "tokens");
    expect(tokensCalls.length).toBe(1);
    expect(new Set(tokensCalls[0]![0].paths)).toEqual(
      new Set([join(root, "tokens", "a.css"), join(root, "tokens", "b.css")]),
    );
  });

  // ─── AC6 — stop() ──────────────────────────────────────────────────────

  it("AC6: stop() tears the watcher down so no further onChange fires", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    await sleep(150);
    onChange.mockClear();

    await handle.stop();

    await writeFile(join(root, "components", "actions", "AfterStop.html"), "<div/>");
    await sleep(SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("AC6: stop() is idempotent — calling it twice does not throw", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    await sleep(150);

    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("AC6: stop() clears a pending debounce timer (no orphaned flush after stop)", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    await sleep(150);
    onChange.mockClear();

    // Trigger a change, then stop IMMEDIATELY (before the 100ms debounce
    // window elapses) — the pending flush must never fire.
    await writeFile(join(root, "components", "actions", "RaceStop.html"), "<div/>");
    await handle.stop();
    await sleep(SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  // ─── AC7 — logging ─────────────────────────────────────────────────────

  it("AC7: logs { event: 'watcher.cycle', added, changed, deleted, debouncedTo } to stderr per cycle", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    stderrLines.length = 0;

    await writeFile(join(root, "components", "actions", "Button.html"), "<div/>");
    await sleep(SETTLE_MS);

    const parsed = stderrLines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(
        (l): l is Record<string, unknown> => l !== undefined && l["event"] === "watcher.cycle",
      );

    expect(parsed.length).toBeGreaterThanOrEqual(1);
    const line = parsed[0]!;
    expect(line).toHaveProperty("added");
    expect(line).toHaveProperty("changed");
    expect(line).toHaveProperty("deleted");
    expect(line).toHaveProperty("debouncedTo");
    expect(typeof line["debouncedTo"]).toBe("string"); // the classification type e.g. "preview"
  });

  it("AC7: log line never lands on stdout (stdio JSON-RPC framing safety)", async () => {
    const stdoutLines: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);

    await writeFile(join(root, "styles.css"), "body{}");
    await sleep(SETTLE_MS);

    stdoutSpy.mockRestore();
    expect(stdoutLines.join("")).not.toContain("watcher.cycle");
  });

  it("AC7: reports added/changed/deleted counts distinctly within one debounced cycle", async () => {
    // Seed one file that the burst below will "change" and one that it will
    // "delete", so a single debounce window covers all three kinds of event.
    await writeFile(join(root, "components", "actions", "ToChange.html"), "<div/>");
    await writeFile(join(root, "components", "actions", "ToDelete.html"), "<div/>");

    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    stderrLines.length = 0;
    onChange.mockClear();

    await writeFile(join(root, "components", "actions", "Freshly.html"), "<div/>"); // added
    await writeFile(join(root, "components", "actions", "ToChange.html"), "<div>x</div>"); // changed
    await unlink(join(root, "components", "actions", "ToDelete.html")); // deleted
    await sleep(SETTLE_MS);

    const previewCall = onChange.mock.calls.find(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCall).toBeDefined();
    expect(new Set(previewCall![0].paths)).toEqual(
      new Set([
        join(root, "components", "actions", "Freshly.html"),
        join(root, "components", "actions", "ToChange.html"),
        join(root, "components", "actions", "ToDelete.html"),
      ]),
    );

    const parsed = stderrLines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(
        (l): l is { added: number; changed: number; deleted: number; debouncedTo: string } =>
          l !== undefined && l["event"] === "watcher.cycle" && l["debouncedTo"] === "preview",
      );
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.added).toBe(1);
    expect(parsed[0]!.changed).toBe(1);
    expect(parsed[0]!.deleted).toBe(1);
  });

  // ─── AC5 — polling fallback ────────────────────────────────────────────

  it("AC5: an explicit usePolling override is honoured and still detects changes", async () => {
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange, { usePolling: true, pollInterval: 30 });
    stop = handle.stop;
    await sleep(200); // polling needs a bit more settle time than native events

    onChange.mockClear();
    await writeFile(join(root, "components", "actions", "Polled.html"), "<div/>");
    await sleep(SETTLE_MS + 300); // polling interval adds latency

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("AC5: defaults to usePolling=false (native events) when no override or Docker signal is present", async () => {
    // GENIE_WATCH_USE_POLLING is the opt-in env escape hatch for a Docker
    // volume host that can't rely on native fs events; absent it, and absent
    // an explicit options override, chokidar is configured with
    // usePolling:false. This is asserted indirectly: startWatcher must not
    // throw and must still successfully detect a native-event change (which
    // would still pass under polling, but a broken option pass-through that
    // e.g. always forced polling on would still pass this particular
    // assertion — the explicit-override tests above are what pin the actual
    // wiring; this test only pins the *default* is inert/non-throwing).
    delete process.env["GENIE_WATCH_USE_POLLING"];
    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    await writeFile(join(root, "meta.json"), "{}");
    await sleep(SETTLE_MS);

    expect(onChange.mock.calls.some(([c]: [WatcherChange]) => c.type === "manifest")).toBe(true);
  });

  it("AC5: GENIE_WATCH_USE_POLLING=1 env var enables the polling fallback without an explicit option", async () => {
    process.env["GENIE_WATCH_USE_POLLING"] = "1";
    try {
      const onChange = vi.fn();
      const handle = startWatcher(root, onChange);
      stop = handle.stop;
      await sleep(200);
      onChange.mockClear();

      await writeFile(join(root, "tokens", "env-polled.css"), ":root{}");
      await sleep(SETTLE_MS + 300);

      const tokensCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "tokens");
      expect(tokensCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env["GENIE_WATCH_USE_POLLING"];
    }
  });

  // ─── ignoreInitial: false — startup snapshot ──────────────────────────

  it("ignoreInitial:false — an onChange fires for pre-existing files already on disk at startup", async () => {
    await writeFile(join(root, "components", "actions", "Preexisting.html"), "<div/>");

    const onChange = vi.fn();
    const handle = startWatcher(root, onChange);
    stop = handle.stop;
    await sleep(SETTLE_MS + 150);

    const previewCalls = onChange.mock.calls.filter(([c]: [WatcherChange]) => c.type === "preview");
    expect(previewCalls.length).toBeGreaterThanOrEqual(1);
    const allPaths = previewCalls.flatMap(([c]: [WatcherChange]) => c.paths);
    expect(allPaths).toContain(join(root, "components", "actions", "Preexisting.html"));
  });

  // ─── Non-existent projectRoot at startup ──────────────────────────────

  it("does not throw when projectRoot does not yet exist on disk", async () => {
    const missingRoot = join(root, "does-not-exist-yet");
    const onChange = vi.fn();
    expect(() => {
      const handle = startWatcher(missingRoot, onChange);
      stop = handle.stop;
    }).not.toThrow();
    await sleep(150);
    expect(onChange).not.toHaveBeenCalled();
  });

  // ─── Brand-new kit: projectRoot exists, but none of its watched ────────
  // ─── subpaths do yet (the real `create_kit` scaffold, per            ────────
  // ─── `store/local.ts`, only creates the kit dir + `.kit.json` — NOT  ────────
  // ─── `components/`, `tokens/`, `styles.css`, or `meta.json`).        ────────

  it("recovers once components/, tokens/, styles.css, and meta.json are all created AFTER the watcher starts on an otherwise-empty root", async () => {
    // Start from a genuinely empty root (re-scaffold without the
    // `beforeEach` helper's pre-made components/tokens dirs), matching a
    // freshly `create_kit`'d directory with nothing but the kit root itself.
    const emptyRoot = join(root, "brand-new-kit");
    await mkdir(emptyRoot, { recursive: true });

    const onChange = vi.fn();
    const handle = startWatcher(emptyRoot, onChange);
    stop = handle.stop;
    await sleep(150);
    onChange.mockClear();

    // All four AC2 targets are created well after startWatcher() already
    // ran — this is the scenario a spike proved chokidar v3 mishandles when
    // 2+ of a watcher's targets are simultaneously missing at watch()-time
    // (confirmed: only the FIRST such target ever arms unless the watcher
    // defensively pre-creates its directory targets before calling
    // chokidar.watch()).
    await mkdir(join(emptyRoot, "components", "actions"), { recursive: true });
    await mkdir(join(emptyRoot, "tokens"), { recursive: true });
    await writeFile(join(emptyRoot, "components", "actions", "Late.html"), "<div/>");
    await writeFile(join(emptyRoot, "tokens", "colors.css"), ":root{}");
    await writeFile(join(emptyRoot, "styles.css"), "body{}");
    await writeFile(join(emptyRoot, "meta.json"), "{}");
    await sleep(SETTLE_MS + 200);

    const byType = new Map<WatcherChangeType, string[]>();
    for (const [change] of onChange.mock.calls as [WatcherChange][]) {
      byType.set(change.type, [...(byType.get(change.type) ?? []), ...change.paths]);
    }

    expect(byType.get("preview")).toContain(join(emptyRoot, "components", "actions", "Late.html"));
    expect(byType.get("tokens")).toContain(join(emptyRoot, "tokens", "colors.css"));
    expect(new Set(byType.get("manifest"))).toEqual(
      new Set([join(emptyRoot, "styles.css"), join(emptyRoot, "meta.json")]),
    );
  });
});
