---
title: "[M2-09] M2 integration tests (real LiteLLM round-trip)"
milestone: "M2 — LiteLLM Generation Surface"
labels: ["type:test", "area:litellm", "priority:P0-critical", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
End-to-end test that calls `generate_component` against the real LiteLLM
gateway with a 5 USD per-run budget cap, asserts the response validates
against `COMPONENT_SCHEMA`, and asserts the produced `<Name>.html` passes the
`@dsCard` regex. Runs only on `main` (not every PR) to keep CI cheap.

## Context
- This is the canary for the entire generation pipeline. If this is green,
  the foundation works.

## Acceptance Criteria
- [ ] AC1 — File `packages/e2e/test/m2-generation.test.ts`.
- [ ] AC2 — Runs only when `LITELLM_MASTER_KEY` env is set (skipped
      otherwise).
- [ ] AC3 — Generates 5 components (primary button, secondary button, card,
      modal, nav bar) against `design-default`.
- [ ] AC4 — Asserts schema validation passes for all 5.
- [ ] AC5 — Asserts `@dsCard` regex matches first line of every produced
      `.html`.
- [ ] AC6 — Aggregates `promptTokens + completionTokens * pricing` and fails
      if > 5 USD.
- [ ] AC7 — Test report and per-component sample uploaded as CI artefact.
- [ ] AC8 — Refine round-trip: generate, then refine with "make it dark
      mode", assert diff non-empty.

## Implementation Notes
- Gate behind `if (!process.env.LITELLM_MASTER_KEY) ctx.skip()`.
- Pricing table for cost-assert maintained in `packages/e2e/src/pricing.ts`.

## Out of Scope
- Viewer end-to-end (M4-10).

## Dependencies
- Blocks: M2 milestone close.
- Blocked by: M2-03, M2-04, M2-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — the suite is the deliverable.
- [ ] Docs updated.
- [ ] Manual verification — run locally with master key.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
