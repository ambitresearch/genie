---
title: "[M4-01] @ambitresearch/genie-viewer package scaffold"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:viewer", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Create the second pnpm workspace package `@ambitresearch/genie-viewer`. Owns
the static viewer assets (`index.html`, `viewer.js`, `viewer.css`), the Vite
config, and the CLI binary `genie-viewer`. M4-02 … M4-10 fill it
in.

## Context
- Research report §3.4: "Adopt the bundled-skill file layout verbatim … plus
  a tiny Vite-backed viewer (`@ambitresearch/genie-viewer`) watches the
  directory and renders the same files in a grid with HMR."
- §7 step 5: "Build the preview viewer … Vite multi-page entry, chokidar
  watch, iframe grid renderer, HMR-driven card refresh via `postMessage`."

## Acceptance Criteria
- [ ] AC1 — Directory `packages/viewer/` exists with its own
      `package.json` (`@ambitresearch/genie-viewer`, `version: 0.0.0`).
- [ ] AC2 — Listed in `pnpm-workspace.yaml`.
- [ ] AC3 — Declares `vite`, `chokidar`, `@types/node` as devDeps; `commander`
      as runtime dep.
- [ ] AC4 — `package.json` exports the `genie-viewer` bin.
- [ ] AC5 — `pnpm --filter @ambitresearch/genie-viewer build` produces
      `packages/viewer/dist/` containing the CLI + static assets.
- [ ] AC6 — Bin script greets with `Usage: genie-viewer <kit-dir>
      [--port N]`.

## Implementation Notes
- File: `packages/viewer/{package.json,src/cli.ts,src/index.ts}`.
- Bin shebang `#!/usr/bin/env node`, ESM (`"type": "module"`).

## Out of Scope
- Actual rendering (M4-03).
- HMR (M4-04).

## Dependencies
- Blocks: M4-02 … M4-10.
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg) — the surface everything renders into.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — placeholder.
- [ ] Docs updated — viewer README.
- [ ] Manual verification — `npx @ambitresearch/genie-viewer --help`.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
