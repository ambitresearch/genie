---
title: "[M6-02] Load test (100 concurrent plans, k6)"
milestone: "M6 — GA Hardening"
labels: ["type:perf", "area:mcp-server", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Run a k6 load test against the server (Docker image from M5-07) at 100
concurrent plans for 5 minutes. Asserts no OOM, p95 latency < 500 ms,
error rate < 0.1 %. Publishes a perf report.

## Context
- M6 milestone exit: "Load test report: server handles 100 concurrent
  plans without OOM".

## Acceptance Criteria
- [ ] AC1 — File `perf/k6/concurrent-plans.js` defines the scenario.
- [ ] AC2 — Scenario walks: `create_project → finalize_plan → write_files
      (10 files) → validate_design_system → report_validate`.
- [ ] AC3 — Ramp: 0 → 100 VUs over 30 s; hold 5 min; ramp down 30 s.
- [ ] AC4 — Asserts: no failed HTTP requests, p95 < 500 ms (read verbs) /
      < 2 s (write_files), no container OOM (monitored via cAdvisor).
- [ ] AC5 — Report saved to `perf/reports/<git-sha>.html`.
- [ ] AC6 — Runs nightly in CI against the latest Docker image.

## Implementation Notes
- File: `perf/k6/concurrent-plans.js`, `.github/workflows/perf.yml`.
- LiteLLM calls stubbed out (we're testing the server, not the LLM).

## Out of Scope
- Stress test beyond 100 VUs (v2).

## Dependencies
- Blocks: nothing.
- Blocked by: M5-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — the k6 script.
- [ ] Docs updated — perf report linked from README.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
