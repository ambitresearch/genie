---
title: "[M2-04] Tool: refine (with optional region rect)"
milestone: "M2 — LLM Generation Surface"
labels: ["type:feature", "area:mcp-tools", "area:llm", "priority:P1-high", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
Implement `refine` — the iterate-on-an-existing-component verb.
Takes an `instruction` (free-form text like "make the border radius softer")
and an optional `region: { x, y, w, h }` rect for canvas-style "fix this
specific element" edits. Returns a unified diff plus the updated files.

## Context
- Research report §3.1: `refine({ kitId, componentName,
  instruction, region?: { x, y, w, h } }): { diff: string, files: { path,
  content }[] }`.
- §6 substitute for "canvas-side generation loop": "Build your own surface
  from scratch — start with a single `refine` tool that takes an
  `instruction` + optional `region` rect, returns a diff."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__refine`.
- [ ] AC2 — Input schema: see Summary.
- [ ] AC3 — Loads the current files for `componentName` via
      `KitStore.getFile` (one call per file in the manifestEntry).
- [ ] AC4 — Builds a prompt that includes: original `<Name>.tsx`, original
      `<Name>.html`, the `instruction`, and (if `region`) a rendered crop of
      the preview at those coords.
- [ ] AC5 — Output: a unified diff in `{ diff }` plus the full updated files
      in `{ files }`. Diff is informational; files are the source of truth.
- [ ] AC6 — Validated against `COMPONENT_SCHEMA` (M2-02) — same retry-once
      pattern as M2-03.
- [ ] AC7 — Region cropping uses headless Chromium via Playwright (M3-02's
      validator setup is a peer dependency).
- [ ] AC8 — Logs `{ componentName, hasRegion, model, promptTokens,
      completionTokens, latencyMs }`.

## Implementation Notes
- File: `packages/server/src/tools/refine.ts`.
- Region crop is implemented as a tiny helper that renders the preview HTML
  in Playwright, screenshots the rect, and base64-encodes for vision input.
- Use `diff` package for the unified-diff output.

## Out of Scope
- Multi-region edits (single region for v1).
- Voice / sketch inputs.

## Dependencies
- Blocks: nothing critical.
- Blocked by: M2-03 (shares the system prompt scaffolding).

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg) — the REFINE moment — sliders + region rect.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — unit + integration with region.
- [ ] Docs updated.
- [ ] Manual verification — refine an existing button's border radius.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
