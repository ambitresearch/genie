/**
 * M3-02 (DRO-258) — chokidar watcher for a project/kit's component tree.
 *
 * Watches the four glob groups a kit's on-disk layout defines: component
 * preview/source files, token files,
 * the import-closure root stylesheet, and the per-kit `meta.json`. On any
 * change it classifies the touched paths by which group they belong to,
 * debounces a 100 ms window PER classification (AC3), and hands the caller
 * one `{ type, paths }` batch per group per settled cycle (AC4).
 *
 * Deliberately a "dumb" event source: it does not itself invoke the M3-01
 * `@genie` marker validator or the M3-03 manifest compiler — those are
 * `onChange` callback concerns for whoever wires this up (M3-03 is the
 * planned first consumer). Keeping this module free of that dependency is
 * what lets `startWatcher`'s signature stay exactly `(projectRoot, onChange)`
 * (AC1) and keeps the watcher unit-testable in isolation.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import chokidar from "chokidar";
// micromatch is CJS-only and assigns its named helpers as properties on the
// exported function itself rather than separate `module.exports.foo = ...`
// assignments, so Node's cjs-module-lexer can't statically see them — a
// default import is the one shape that works both under esbuild (vitest)
// and real Node ESM. Same workaround, same reasoning, as `../plans/index.ts`.
import micromatch from "micromatch";

// ─── Public types ────────────────────────────────────────────────────────────

/** The three change classifications AC4 requires `onChange` to report. */
export type WatcherChangeType = "preview" | "tokens" | "manifest";

/** One debounced batch of same-type changes, handed to `onChange` (AC4). */
export interface WatcherChange {
  type: WatcherChangeType;
  paths: string[];
}

/** Optional tuning knobs beyond the AC3 default 100 ms debounce window. */
export interface StartWatcherOptions {
  /**
   * AC5 — force chokidar's polling backend on, the documented fallback for
   * filesystems (Docker bind/volume mounts, some network shares) where
   * native `inotify`/`FSEvents` events don't reliably propagate. When
   * omitted, defaults to `true` if the `GENIE_WATCH_USE_POLLING` env var is
   * set to a truthy value (`"1"`/`"true"`), else `false`. An explicit
   * `usePolling` here always wins over the env var, so callers/tests don't
   * need to mutate `process.env` to exercise the fallback path.
   */
  usePolling?: boolean;
  /** Polling interval in ms when `usePolling` is on. Defaults to 100. */
  pollInterval?: number;
  /**
   * Debounce window in ms (AC3 default 100). Exposed for tests that want a
   * tighter/looser window than the shipped default; production callers
   * should leave this at the default so the AC3 contract holds.
   */
  debounceMs?: number;
}

/** Handle returned by {@link startWatcher}. */
export interface WatcherHandle {
  /**
   * AC6 — stop the watcher: closes the underlying chokidar instance and
   * clears any pending (not-yet-flushed) debounce timers, so no further
   * `onChange` call can fire after this resolves. Idempotent — calling it
   * more than once is a harmless no-op (mirrors chokidar's own `close()`
   * idempotency).
   */
  stop: () => Promise<void>;
}

// ─── Env-driven polling default (AC5) ────────────────────────────────────────

const USE_POLLING_ENV = "GENIE_WATCH_USE_POLLING";

/** `true` for "1"/"true" (case-insensitive), `false` for anything else/unset. */
function envUsePolling(env: NodeJS.ProcessEnv): boolean {
  const raw = env[USE_POLLING_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// ─── Glob groups (AC2) ────────────────────────────────────────────────────────

interface GlobGroup {
  type: WatcherChangeType;
  pattern: string;
}

/**
 * Build the AC2 glob patterns for a given kit/project root, each tagged with
 * the {@link WatcherChangeType} it classifies as. `styles.css` and
 * `meta.json` are combined into ONE brace-expansion pattern rather than two
 * separate exact-file literals — see {@link ensureWatchTargetsExist} for why
 * this alone isn't sufficient and what the other half of the fix is.
 *
 * Both `styles.css` and `meta.json` remain exact root-level files, not a
 * `**` pattern — a same-named file nested under `components/` still must
 * NOT match, and the brace form preserves that (verified:
 * `{root}/components/meta.json` does not match `{root}/{styles.css,meta.json}`).
 */
function globGroups(projectRoot: string): GlobGroup[] {
  return [
    { type: "preview", pattern: `${projectRoot}/components/**/*.{html,tsx,d.ts,md}` },
    { type: "tokens", pattern: `${projectRoot}/tokens/**` },
    { type: "manifest", pattern: `${projectRoot}/{styles.css,meta.json}` },
  ];
}

/**
 * Defensively `mkdir -p` the two directory targets a fresh kit/project may
 * not have created yet (`components/`, `tokens/`) before handing patterns to
 * `chokidar.watch()`.
 *
 * This closes a real chokidar v3 gap a spike confirmed: when TWO OR MORE of
 * a single `watch()` call's targets are simultaneously missing from disk at
 * call time, only the FIRST one ever gets armed — any sibling target that
 * was ALSO missing at that instant can go permanently deaf, even after it's
 * created later, even under `usePolling`. (A single missing target, or a
 * missing target watched alongside only already-existing ones, recovers
 * fine — it's specifically the "≥2 simultaneously missing" combination that
 * breaks.) The brace-expansion fix in {@link globGroups} (one pattern
 * instead of two literals for `styles.css`/`meta.json`) only fixes that
 * ONE pair; `components/` and `tokens/` are still two independent
 * directory-rooted patterns, so the same failure mode applies to them.
 *
 * A brand-new kit is not a theoretical case: `LocalFsKitStore.createKit`
 * (`../store/local.ts`) only scaffolds the kit directory + `.kit.json` —
 * `components/`, `tokens/`, `styles.css`, and `meta.json` don't exist until
 * the first `write_files`/`conjure` call lands. A watcher started right
 * after `create_kit` (a realistic startup ordering) would otherwise go
 * deaf on every group but whichever pattern chokidar happens to arm first.
 *
 * `mkdirSync(..., { recursive: true })` is idempotent (a no-op if the
 * directory already exists) and, being recursive, also creates
 * `projectRoot` itself if that doesn't exist yet either — so this one call
 * covers the "entire root is missing" case too, not just its children.
 * Synchronous and best-effort: if `projectRoot`'s parent is unwritable or a
 * path segment collides with a non-directory file, this throws the
 * underlying `fs` error (e.g. `EACCES`/`ENOTDIR`) synchronously out of
 * `startWatcher` itself, before any chokidar instance is created — a clear,
 * immediate failure rather than a watcher that silently never sees half its
 * target groups.
 */
function ensureWatchTargetsExist(projectRoot: string): void {
  mkdirSync(join(projectRoot, "components"), { recursive: true });
  mkdirSync(join(projectRoot, "tokens"), { recursive: true });
}

/**
 * Classify an absolute path emitted by chokidar against the AC2 glob groups,
 * via the same `micromatch` matcher `../plans/index.ts`'s `pathMatchesGlobs`
 * already relies on elsewhere in this server, so a path's classification
 * here is consistent with how the rest of the codebase interprets these
 * patterns. Returns `undefined` for a path that matches none of the 4
 * groups (e.g. chokidar reporting a directory-add for `tokens/` itself is
 * still a legitimate `tokens` match — `tokens/**` covers the dir entry
 * too — but an unrelated sibling file is not).
 */
function classifyPath(path: string, groups: GlobGroup[]): WatcherChangeType | undefined {
  for (const group of groups) {
    if (micromatch.isMatch(path, group.pattern, { dot: true })) return group.type;
  }
  return undefined;
}

// ─── stderr logging (AC7) ────────────────────────────────────────────────────

/**
 * AC7 — one JSON line per flushed debounce cycle. MUST go to stderr, never
 * stdout: on the stdio transport (the default when a harness pipes
 * JSON-RPC — see `../transport.ts`), stdout *is* the protocol stream, and a
 * stray log line there corrupts every client's message framing (the same
 * rule `../tools/plan.ts`'s `plan.created` audit line and `../llm/retry.ts`'s
 * `logRetry` already follow).
 */
function logCycle(
  counts: { added: number; changed: number; deleted: number },
  type: WatcherChangeType,
): void {
  process.stderr.write(
    JSON.stringify({
      event: "watcher.cycle",
      added: counts.added,
      changed: counts.changed,
      deleted: counts.deleted,
      debouncedTo: type,
    }) + "\n",
  );
}

// ─── Per-type debounce accumulator ───────────────────────────────────────────

/** Raw per-path event kinds tracked while a debounce window is open. */
type RawKind = "add" | "change" | "unlink";

/** One in-flight accumulator per {@link WatcherChangeType}. */
interface PendingBatch {
  timer: NodeJS.Timeout;
  // path -> net kind for this cycle. See `schedule()` for the resolution
  // rule when the same path sees more than one raw event inside one window.
  kinds: Map<string, RawKind>;
}

/**
 * AC1/AC2/AC3/AC4/AC5/AC6/AC7 — watch a kit/project root's component tree.
 *
 * `onChange` fires once per {@link WatcherChangeType} per settled debounce
 * window (AC3's 100 ms default), never combining two types into one call
 * and never firing for a window that saw zero net paths.
 */
export function startWatcher(
  projectRoot: string,
  onChange: (change: WatcherChange) => void,
  options: StartWatcherOptions = {},
): WatcherHandle {
  const debounceMs = options.debounceMs ?? 100;
  const usePolling = options.usePolling ?? envUsePolling(process.env);
  const pollInterval = options.pollInterval ?? 100;

  ensureWatchTargetsExist(projectRoot);

  const groups = globGroups(projectRoot);
  const patterns = groups.map((g) => g.pattern);

  const watcher = chokidar.watch(patterns, {
    // Spec: "ignoreInitial: false so subscribers get current state on startup".
    ignoreInitial: false,
    usePolling,
    interval: pollInterval,
    // AC3 names ONE debounce authority: this module's own `debounceMs`
    // window. Chokidar's `atomic` option (on by default for native fs
    // events) runs its OWN independent ~100 ms delay before emitting an
    // `unlink` — to detect editor atomic-save patterns (temp-write +
    // rename-over) and fold them into a single `change`. Left on, that
    // timer races our own 100 ms debounce timer (confirmed by spike: with
    // both defaulting to 100 ms and starting at nearly the same instant, a
    // delete's `unlink` can land either just inside or just outside our
    // window, nondeterministically). Disabling it here removes the second,
    // competing debounce mechanism so AC3's window is the only one in
    // play — an atomic editor save still nets out fine: our own
    // last-event-wins accumulator (see `schedule` below) coalesces the
    // resulting unlink+add pair on the same path within one window anyway.
    atomic: false,
  });

  const pending = new Map<WatcherChangeType, PendingBatch>();
  let stopped = false;

  function flush(type: WatcherChangeType): void {
    const batch = pending.get(type);
    if (!batch) return;
    pending.delete(type);

    let added = 0;
    let changed = 0;
    let deleted = 0;
    const paths: string[] = [];
    for (const [path, kind] of batch.kinds) {
      paths.push(path);
      if (kind === "add") added++;
      else if (kind === "change") changed++;
      else deleted++;
    }

    // AC7 logs every settled cycle, even a degenerate one; AC4's onChange
    // only fires when there is something to report.
    logCycle({ added, changed, deleted }, type);
    if (paths.length > 0) {
      onChange({ type, paths });
    }
  }

  function schedule(type: WatcherChangeType, path: string, kind: RawKind): void {
    if (stopped) return;
    const existing = pending.get(type);
    const batch: PendingBatch = existing ?? {
      timer: undefined as unknown as NodeJS.Timeout,
      kinds: new Map(),
    };

    // Net-kind resolution when the same path gets more than one raw event
    // inside a still-open window: last-event-wins. AC4's `onChange` payload
    // doesn't carry a per-path kind at all (just `paths: string[]`) — the
    // classification here only feeds AC7's aggregate added/changed/deleted
    // log counts, so "what actually happened most recently to this path" is
    // both the simplest rule and the one a human reading the log would
    // expect. (An earlier "sticky add" draft — keep it `add` through a
    // same-window `change`, but let a same-window `unlink` win outright —
    // had a real bug: `previous ?? kind` only falls through on
    // `null`/`undefined`, never on the truthy string `"unlink"`, so a path
    // unlinked then re-added inside one window would have stayed stuck
    // reporting `"unlink"` forever. Last-event-wins has no such asymmetry.)
    batch.kinds.set(path, kind);

    if (existing) clearTimeout(existing.timer);
    batch.timer = setTimeout(() => flush(type), debounceMs);
    pending.set(type, batch);
  }

  function dispatch(path: string, kind: RawKind): void {
    const type = classifyPath(path, groups);
    if (type === undefined) return;
    schedule(type, path, kind);
  }

  watcher.on("add", (path: string) => dispatch(path, "add"));
  watcher.on("change", (path: string) => dispatch(path, "change"));
  watcher.on("unlink", (path: string) => dispatch(path, "unlink"));

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const batch of pending.values()) {
      clearTimeout(batch.timer);
    }
    pending.clear();
    await watcher.close();
  }

  return { stop };
}
