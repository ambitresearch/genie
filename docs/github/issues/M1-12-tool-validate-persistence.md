---
title: "[M1-12] Tool: validate — counter-persistence facet"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement the **counter-persistence facet** of genie's single `validate` verb
(D-A merges the inherited `report_validate` + `validate_design_system` into one
verb). This facet accepts aggregate counts after an upload and persists them
for telemetry. The full-scan validator facet is M3-04.

## Context
- D-A (`00-decisions.md`): `report_validate` + `validate_design_system` →
  one `validate` verb. This issue is the lightweight counter-push facet;
  M3-04 is the full validator suite. Both are the same MCP verb.
- Shape: `validate({ kitId, counts: { total, bad, thin,
  variantsIdentical, iterations } })` — the advisory, telemetry-shaped path
  (no `planId` required).

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__validate`.
- [ ] AC2 — Input: `{ kitId: string, counts: { total: number, bad:
      number, thin: number, variantsIdentical: number, iterations: number } }`.
- [ ] AC3 — Persists the report to
      `<projectRoot>/.genie/reports/<ISO-timestamp>.json`.
- [ ] AC4 — Emits a Prometheus-shaped metric line per count
      (`genie_validate_<field>{kitId="…"} N`).
- [ ] AC5 — Returns `{}`.
- [ ] AC6 — Does NOT require a `planId` (read-side telemetry, not write).

## Implementation Notes
- File: `packages/server/src/tools/validate.ts` (shared with M3-04's facet).
- Metrics emission via `prom-client` (registry exposed by M6-01).

## Out of Scope
- Visualisation (Grafana dashboard is M6-01).

## Dependencies
- Blocks: nothing.
- Blocked by: M1-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`ref-genie-card.svg`](https://github.com/ambitresearch/genie/blob/main/docs/designs/design-6/ref-genie-card.svg) — advisory telemetry on validation states.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — happy path; metric values increment.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
