---
title: "[M3-04] Tool: validate — full-scan facet"
milestone: "M3 — @genie Validator + Manifest"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Implement the **full-scan facet** of genie's single `validate` verb (D-A): run
the `@genie` regex check + "thin render" check + "variants identical" check
across the project and return structured findings the model can act on. The
counter-persistence facet is M1-12 — both are the same MCP verb.

## Context
- D-A (`00-decisions.md`): `report_validate` + `validate_design_system` →
  one `validate` verb. This issue is the heavyweight full-scan facet.
- Shape: `validate({ kitId, planId? }):
  { markerMissing: string[], thin: string[], variantsIdentical: string[],
  total: number, bad: number }`.

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__validate`.
- [ ] AC2 — Input: `{ kitId: string, planId?: string }`.
- [ ] AC3 — `markerMissing`: array of paths where the first-line regex
      (M3-01) fails.
- [ ] AC4 — `thin`: array of paths whose rendered viewport bounding-box is <
      `meta.json.renderCheck.minHeight` (default 80 px).
- [ ] AC5 — `variantsIdentical`: array of pairs of paths whose
      perceptual hash (`pHash`) matches within tolerance — catches "model
      generated 3 buttons that all look the same".
- [ ] AC6 — `total` = total `.html` files inspected; `bad` =
      `markerMissing.length + thin.length + variantsIdentical.length`.
- [ ] AC7 — Runs in < 5 s for a 50-component kit (uses Playwright with
      `headless: true`).
- [ ] AC8 — Persists run counters via the same `validate.ts` module as the
      M1-12 facet (one verb, one persistence path).

## Implementation Notes
- File: `packages/server/src/tools/validate.ts` (shared with M1-12's facet).
- Reuse Playwright instance from M2-04's region cropper.
- Perceptual hash via `sharp` + `phash-im` or `imghash` (research the
  best maintained option).

## Out of Scope
- Auto-fixing (model's job).
- Cross-component coherence checks (style guide, etc.).

## Dependencies
- Blocks: nothing critical.
- Blocked by: M3-01, M3-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`ref-genie-card.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/ref-genie-card.svg) — the 4 @genie validation states.

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — golden fixtures for all three failure modes.
- [ ] Docs updated.
- [ ] Manual verification — run against M2's generated kit.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
