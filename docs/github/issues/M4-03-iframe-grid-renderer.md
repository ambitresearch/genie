---
title: "[M4-03] Iframe grid renderer (index.html + viewer.js)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:viewer", "priority:P0-critical", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Implement the viewer's `index.html` + `viewer.js`. Fetches `.genie/manifest.json`,
groups by `card.group`, renders each card as `<iframe sandbox="allow-scripts"
loading="lazy" src="components/.../preview.html">` sized per
`card.viewport`.

## Context
- Research report §3.4 viewer sketch (verbatim):
  ```js
  const m = await fetch("./manifest.json").then(r => r.json());
  const grid = document.getElementById("grid");
  for (const card of m.cards) {
    const article = document.createElement("article");
    article.className = "ds-card";
    article.innerHTML = `…<iframe src="${card.path}" sandbox="allow-scripts" …>`;
    grid.appendChild(article);
  }
  ```

## Acceptance Criteria
- [ ] AC1 — File `packages/viewer/static/index.html` contains a `<header>`,
      a search input `#q`, and a `<main id="grid">`.
- [ ] AC2 — File `packages/viewer/static/viewer.js` `fetch('./manifest.json')`,
      groups by `card.group`, renders cards with viewport sizing.
- [ ] AC3 — Each iframe is `sandbox="allow-scripts"` (no `allow-same-origin`
      → defence in depth).
- [ ] AC4 — `loading="lazy"` on every iframe.
- [ ] AC5 — Search input filters cards client-side by `name` substring
      (case-insensitive).
- [ ] AC6 — Empty-state message when manifest has zero cards.
- [ ] AC7 — Responsive grid (CSS grid `repeat(auto-fill, minmax(320px,
      1fr))`).

## Implementation Notes
- Path: `packages/viewer/static/{index.html,viewer.js,viewer.css}`.
- CSS uses `@layer` for cascade hygiene.

## Out of Scope
- HMR (M4-04).
- Inline manifest mode (M4-05).

## Dependencies
- Blocks: M4-04, M4-09.
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

**Primary mock:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg) — the card grid + card anatomy.

**Supporting:** [`ref-genie-card.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/ref-genie-card.svg).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — DOM snapshot test via Vitest + jsdom.
- [ ] Docs updated.
- [ ] Manual verification — open in browser against fixture kit.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
