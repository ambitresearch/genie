---
title: "[M0-01] Research report sign-off and traceability matrix"
milestone: "M0 — Discovery & Scaffold"
labels: ["type:docs", "area:docs", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Walk the validated research report (19/20 claims confirmed, 1 killed) and
produce a one-page traceability matrix mapping each load-bearing claim to the
roadmap milestone(s) that depend on it. Without this, M1–M5 acceptance criteria
are unmoored from primary sources.

## Context
- Research report: `.deliverables/research-report.json` — `result.report` is the
  authoritative spec; `result.claimVerdicts` is the audit trail.
- INDEX.md §"Source-of-truth facts" must not be contradicted by anything
  downstream.

## Acceptance Criteria
- [ ] AC1 — Given the report, when I open `docs/traceability.md`, then I see a
      table with columns: claim · status (confirmed/killed) · source URL ·
      milestone(s) it backs.
- [ ] AC2 — Every confirmed claim has at least one downstream milestone or an
      explicit "out of scope" note.
- [ ] AC3 — The one killed claim ("Anthropic Labs" framing) is called out with
      the corrected wording from the verifier vote.
- [ ] AC4 — The five honest uncertainties from INDEX.md §"Honest uncertainties"
      are listed with the empirical step needed to settle each.
- [ ] AC5 — Document is reviewed and signed off by the project owner.

## Implementation Notes
- Path: `docs/traceability.md` (new).
- Cross-link every row to the issue number that owns the resulting work item.
- Format: GitHub-flavoured Markdown, no JS-rendered tables.

## Out of Scope
- Re-running the research (the 46-agent run is the input, not the deliverable).
- Updating the report JSON.

## Dependencies
- Blocks: every other M0 issue.
- Blocked by: none.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added (unit + integration as relevant) — N/A (doc only).
- [ ] Docs updated — this issue **is** the doc.
- [ ] Manual verification step run — owner sign-off comment on the PR.
- [ ] No new ESLint/TS errors — N/A.
- [ ] Reviewed by 1 maintainer.
