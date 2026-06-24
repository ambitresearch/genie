---
title: "[M1-12] Tool: report_validate (advisory telemetry)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `report_validate` — the only purely advisory DesignSync verb. Used
after an upload to ship aggregate counts from `.render-check.json` back to the
server for telemetry.

## Context
- Research report §3.1: `report_validate({ projectId, counts: { total, bad,
  thin, variantsIdentical, iterations } }): {}`.
- §1.3 confirmed claim: "report_validate — sent after upload with aggregate
  counts … This is the only DesignSync method that's purely advisory
  (telemetry-shaped, not capability-shaped)."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__report_validate`.
- [ ] AC2 — Input: `{ projectId: string, counts: { total: number, bad:
      number, thin: number, variantsIdentical: number, iterations: number } }`.
- [ ] AC3 — Persists the report to
      `<projectRoot>/.genie/reports/<ISO-timestamp>.json`.
- [ ] AC4 — Emits a Prometheus-shaped metric line per count
      (`genie_validate_<field>{projectId="…"} N`).
- [ ] AC5 — Returns `{}`.
- [ ] AC6 — Does NOT require a `planId` (read-side telemetry, not write).

## Implementation Notes
- File: `packages/server/src/tools/report_validate.ts`.
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

**Primary mock:** [`ref-dscard.svg`](https://github.com/roshangautam/genie/blob/main/docs/design/ref-dscard.svg) — advisory telemetry on validation states.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — happy path; metric values increment.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
