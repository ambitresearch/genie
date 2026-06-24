---
title: "[M4-09] Viewer accessibility audit (axe-core)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:a11y", "area:viewer", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Audit the viewer chrome (the grid wrapper, not the per-card iframes) for
WCAG 2.2 AA conformance with axe-core. Component authors own their own
preview accessibility; the viewer must not block it.

## Context
- Research report §M4 exit criterion: viewer accessibility audit (axe-core)
  passes.

## Acceptance Criteria
- [ ] AC1 — `pnpm --filter @genie/viewer test:a11y` runs axe-core
      against the viewer shell.
- [ ] AC2 — Zero critical or serious violations (only `moderate` or `minor`
      acceptable, with a justification doc per case).
- [ ] AC3 — Keyboard navigation: Tab focuses the search input, then each
      card's `<article>` (focusable via `tabindex="0"`); Enter on a card
      opens its detail page (placeholder).
- [ ] AC4 — Search input has `aria-label`.
- [ ] AC5 — Each card's `<iframe>` has `title` set from `card.name`.
- [ ] AC6 — Colour contrast ≥ 4.5:1 for body text.
- [ ] AC7 — Dark mode toggle (`prefers-color-scheme`) supported.

## Implementation Notes
- File: `packages/viewer/test/a11y.test.ts` — uses `@axe-core/playwright`.

## Out of Scope
- Auditing inside iframes (component author's responsibility).

## Dependencies
- Blocks: M4 milestone close.
- Blocked by: M4-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`ref-foundations.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/ref-foundations.svg) — palette contrast + roles via axe-core.

**Supporting:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/02-preview-refine.svg).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — axe-core suite.
- [ ] Docs updated — `docs/04-tech-design-rfc.md` a11y section.
- [ ] Manual verification — keyboard walkthrough.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
