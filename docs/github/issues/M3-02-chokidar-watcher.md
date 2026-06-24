---
title: "[M3-02] chokidar watcher for component tree"
milestone: "M3 — @dsCard Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Watch the project's `components/**/*.html`, `tokens/`, and `styles.css` with
chokidar. On any change, debounce 100 ms then re-run the @dsCard validator
(M3-01) and the manifest compiler (M3-03). Emits a `manifest.updated` event
the viewer (M4) subscribes to.

## Context
- Research report §3.4: "chokidar-driven HMR on preview.html saves".
- §7 step 5: "200-LOC dev server whose only job is to render those same
  artifacts in a grid with hot reload".

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/watch/watcher.ts` exports
      `startWatcher(projectRoot, onChange)`.
- [ ] AC2 — Watches `${projectRoot}/components/**/*.{html,tsx,d.ts,md}`,
      `${projectRoot}/tokens/**`, `${projectRoot}/styles.css`,
      `${projectRoot}/meta.json`.
- [ ] AC3 — Debounces back-to-back events (100 ms window).
- [ ] AC4 — Emits `{ type: "preview" | "tokens" | "manifest", paths: string[] }`
      on `onChange`.
- [ ] AC5 — Gracefully degrades to polling when running on Docker volumes
      (chokidar's `usePolling: true` fallback).
- [ ] AC6 — Stopped via returned `stop()` function.
- [ ] AC7 — Logs `{ added, changed, deleted, debouncedTo }` per cycle.

## Implementation Notes
- File: `packages/server/src/watch/watcher.ts`.
- `chokidar` v3+, `ignoreInitial: false` so subscribers get the current state
  on startup.

## Out of Scope
- HMR over WebSocket / postMessage (M4-04).

## Dependencies
- Blocks: M3-03, M4-04.
- Blocked by: M3-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — create/modify/delete events, debounce window, polling
      fallback.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
