---
title: "[M4-10] Viewer end-to-end test (Playwright vs Vite vs ui://)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:test", "area:viewer", "area:mcp-ui", "priority:P0-critical", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
End-to-end test that exercises three delivery vehicles for the same kit
artefacts: (a) `file://<root>/index.html`, (b) `http://localhost:5173`,
(c) `ui://genie/grid` rendered headless. Asserts the same cards
appear with the same viewport sizes in each. This is the M4 acceptance gate.

## Context
- Research report §3.4 + §7 step 6 explicitly call out tests against VS
  Code Insiders + Claude Code.

## Acceptance Criteria
- [ ] AC1 — File `packages/e2e/test/m4-viewer.test.ts`.
- [ ] AC2 — Uses Playwright headed Chromium.
- [ ] AC3 — Loads a 12-component fixture kit; asserts 12 cards visible in
      all three vehicles.
- [ ] AC4 — Asserts the same `data-path` attribute on each card across
      vehicles (canonical identity check).
- [ ] AC5 — Triggers an HMR event (modifies a preview's first line) and
      asserts only the matching iframe reloads in vehicle (b).
- [ ] AC6 — For vehicle (c), spins up an MCP-Apps test host
      (`@modelcontextprotocol/ext-apps/test-host`) and asserts the iframe
      renders the same DOM.
- [ ] AC7 — Test report includes screenshots of all three vehicles.
- [ ] AC8 — Runs in < 90 s.

## Implementation Notes
- File: `packages/e2e/test/m4-viewer.test.ts`.

## Out of Scope
- Cross-harness manual smoke (that's M5-09 … M5-15).

## Dependencies
- Blocks: M4 milestone close.
- Blocked by: M4-04, M4-06, M4-07, M4-08, M4-09.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`03-embedded-modes.svg`](https://github.com/ambitresearch/genie/blob/main/docs/designs/design-6/03-embedded-modes.svg) — all 3 vehicles render byte-identical cards (G-5).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — the suite is the deliverable.
- [ ] Docs updated.
- [ ] Manual verification — run with `--headed` and inspect.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
