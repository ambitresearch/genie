---
title: "[M4-04] HMR via postMessage (per-card refresh, no full reload)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:viewer", "priority:P1-high", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Wire chokidar (running in the viewer's Vite dev server) to post a `{type:
"refresh", id}` message to the parent window, which targets the matching
iframe and reloads only that card. Prevents the "save → whole grid reflows"
anti-pattern and beats Storybook's cold-rebuild story.

## Context
- Research report §3.4 viewer sketch: HMR-driven card refresh via
  `postMessage`.
- §7 step 5 mentions chokidar-driven HMR explicitly.

## Acceptance Criteria
- [ ] AC1 — Vite plugin in `packages/viewer/vite.config.ts` registers a
      WebSocket on `/__genie_hmr` that pushes
      `{ event: "card.changed", path: string }` on chokidar events.
- [ ] AC2 — `viewer.js` opens a WebSocket on the same path; on each event,
      identifies the matching iframe by `data-path` attribute and `reload`s
      its `contentWindow`.
- [ ] AC3 — Sub-100 ms reload latency on a 50-card kit (measured: save →
      iframe `load` event).
- [ ] AC4 — Falls back to a polling check every 2 s if WebSocket fails.
- [ ] AC5 — Tokens / styles.css changes trigger ALL iframes to reload.
- [ ] AC6 — Reload count shown in viewer header for debugging
      (collapsible).

## Implementation Notes
- File: `packages/viewer/src/hmr-plugin.ts`.
- Reuse the M3-02 watcher's event shape.

## Out of Scope
- HMR for the viewer itself (Vite handles that already).

## Dependencies
- Blocks: M4-10 (e2e needs HMR working).
- Blocked by: M4-03, M3-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/design/02-preview-refine.svg) — a single card re-rendering in place on HMR.

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — manual + automated reload-latency benchmark.
- [ ] Docs updated.
- [ ] Manual verification — modify a preview's first line, watch only that
      card reload.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
