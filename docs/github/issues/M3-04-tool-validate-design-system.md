---
title: "[M3-04] Tool: validate_design_system"
milestone: "M3 — @dsCard Validator + Manifest"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Expose a `validate_design_system` MCP tool that runs the @dsCard regex check
+ "thin render" check + "variants identical" check across the project and
returns structured findings the model can act on. The CLI / CI equivalent of
the bundled skill's `package-validate.mjs`.

## Context
- Research report §3.1: `validate_design_system({ projectId, planId? }):
  { dsCardMissing: string[], thin: string[], variantsIdentical: string[],
  total: number, bad: number }`.

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__validate_design_system`.
- [ ] AC2 — Input: `{ projectId: string, planId?: string }`.
- [ ] AC3 — `dsCardMissing`: array of paths where the first-line regex
      (M3-01) fails.
- [ ] AC4 — `thin`: array of paths whose rendered viewport bounding-box is <
      `meta.json.renderCheck.minHeight` (default 80 px).
- [ ] AC5 — `variantsIdentical`: array of pairs of paths whose
      perceptual hash (`pHash`) matches within tolerance — catches "model
      generated 3 buttons that all look the same".
- [ ] AC6 — `total` = total `.html` files inspected; `bad` =
      `dsCardMissing.length + thin.length + variantsIdentical.length`.
- [ ] AC7 — Runs in < 5 s for a 50-component kit (uses Playwright with
      `headless: true`).
- [ ] AC8 — On success, callers typically chain into `report_validate`
      (M1-12) to ship the counts upstream.

## Implementation Notes
- File: `packages/server/src/tools/validate_design_system.ts`.
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

**Primary mock:** [`ref-dscard.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/ref-dscard.svg) — the 4 @dsCard validation states.

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — golden fixtures for all three failure modes.
- [ ] Docs updated.
- [ ] Manual verification — run against M2's generated kit.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
