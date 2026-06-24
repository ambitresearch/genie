---
title: "[M5-16] CHANGELOG honesty matrix (what works in each harness)"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "area:docs", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Compile the empirical results of all 7 harness smoke tests (M5-09 …
M5-15) into a single honest matrix at the top of CHANGELOG.md. For each
harness × tier-{0,1,2} combination, mark works / degraded / broken with a
link to the smoke-test screenshot.

## Context
- Research report §7 step 11: "Honest matrix in CHANGELOG".

## Acceptance Criteria
- [ ] AC1 — CHANGELOG.md `## v0.1.0 Harness Matrix` section.
- [ ] AC2 — 7 rows (one per harness), 3 columns (Tier 0/1/2).
- [ ] AC3 — Each cell is "✅ works" / "⚠️ degraded" / "❌ broken" linked
      to a screenshot.
- [ ] AC4 — Below the table, a "Known limitations" list pulls from each
      harness doc's gotcha notes.
- [ ] AC5 — Updated automatically by the smoke-test CI workflow (post-run
      job re-generates the table).

## Implementation Notes
- File: `CHANGELOG.md`, `scripts/update-harness-matrix.mjs`.

## Out of Scope
- Per-tool granularity (the matrix is per-tier).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M5-09 … M5-15.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A.
- [ ] Docs updated.
- [ ] Manual verification — table matches reality.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
