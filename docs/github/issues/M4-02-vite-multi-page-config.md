---
title: "[M4-02] Vite multi-page config (each preview.html as entry point)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:viewer", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Configure Vite to serve `<kit-dir>` with each `components/**/preview.html`
as a multi-page entry point. Vite supports this natively: "Vite also
supports multi-page apps with multiple `.html` entry points… each
`index.html` is treated as source code and part of the module graph"
([vite.dev/guide](https://vite.dev/guide/)).

## Context
- Research report §3.4 + §7 step 5.
- The viewer's `index.html` is the root; each component preview is a
  per-card entry that Vite hot-reloads independently.

## Acceptance Criteria
- [ ] AC1 — File `packages/viewer/vite.config.ts` exports a Vite config
      whose `rollupOptions.input` is dynamically populated by globbing
      `<kit-dir>/components/**/preview.html`.
- [ ] AC2 — Root `index.html` is the always-present entry.
- [ ] AC3 — Dev server: port 5173 (configurable via `--port`); host
      `127.0.0.1` (no LAN exposure by default).
- [ ] AC4 — Build target ES2022.
- [ ] AC5 — Serves static `tokens/`, `styles.css`, `_vendor/` from the kit
      dir at the same paths.
- [ ] AC6 — Adds `Cache-Control: no-store` for HTML responses in dev to
      avoid stale-card surprises.

## Implementation Notes
- File: `packages/viewer/vite.config.ts`.
- Use `fast-glob` for the input enumeration.

## Out of Scope
- Production build optimisation (the viewer is dev-only in v1).

## Dependencies
- Blocks: M4-03, M4-04.
- Blocked by: M4-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg) — each preview.html as a card entry point.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — config snapshot test.
- [ ] Docs updated.
- [ ] Manual verification — `pnpm dev` in viewer + a fixture kit, observe
      every `preview.html` reachable.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
