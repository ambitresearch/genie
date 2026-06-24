---
title: "[M4-08] CLI: genie-viewer <kit> [--port N]"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:viewer", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Polish the CLI binary `genie-viewer`. Boots Vite against the
given kit directory, prints the URL, opens the system browser (unless
`--no-open`), exits cleanly on Ctrl-C.

## Context
- Research report §3.4 + §7 step 5: `npx genie-viewer
  ui_kits/<kit>`.

## Acceptance Criteria
- [ ] AC1 — `genie-viewer <kit-dir>` boots Vite, prints
      `Preview: http://127.0.0.1:5173`.
- [ ] AC2 — `--port N` overrides the default port; if in use, picks the next
      free port and warns.
- [ ] AC3 — `--open` (default true) opens the URL in the system browser via
      `open` (npm package).
- [ ] AC4 — `--no-open` suppresses auto-open.
- [ ] AC5 — Ctrl-C stops the watcher + closes the server within 1 s.
- [ ] AC6 — `--help` prints usage; `--version` prints package version.
- [ ] AC7 — Exits non-zero if `<kit-dir>` doesn't exist or has no
      `manifest.json` (suggests running the MCP server first).

## Implementation Notes
- File: `packages/viewer/src/cli.ts`.
- Use `commander` for arg parsing.

## Out of Scope
- LAN exposure / TLS (v2).

## Dependencies
- Blocks: M4-10.
- Blocked by: M4-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/02-preview-refine.svg) — the booted viewer + empty state.

**Supporting:** [`00-front-door.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/00-front-door.svg).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — CLI boot + port fallback.
- [ ] Docs updated — README quickstart.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
