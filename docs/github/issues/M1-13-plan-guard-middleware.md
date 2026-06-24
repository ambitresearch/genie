---
title: "[M1-13] Plan-vs-write guard middleware"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-server", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Centralise the plan-vs-write guard into one middleware so every write/delete/
register/unregister call funnels through identical validation. Without this,
the four verbs reimplement the same checks four times and the contract drifts.

## Context
- Research report §1.3 confirmed claim: "Calling write, delete, register, or
  unregister without a valid `planId`, or with paths outside the plan, is
  rejected."

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/middleware/plan-guard.ts` exports a
      `withPlanGuard(handler)` higher-order function.
- [ ] AC2 — Guard checks: (a) `planId` present, (b) `planId` exists, (c)
      `planId` not expired, (d) every input `path` matches a glob in the
      plan's `writes` (or `deletes` for delete_files).
- [ ] AC3 — On failure, returns MCP error `-32602` with a structured
      `data.reason` field for client introspection.
- [ ] AC4 — M1-08, M1-09, M1-10, M1-11 all wrap their handlers with this
      middleware (refactor commit).
- [ ] AC5 — Guard tests live alongside the middleware
      (`plan-guard.test.ts`).
- [ ] AC6 — Logs a structured `plan.guard.reject` event with `{ planId,
      reason, path? }` on every rejection (no contents leaked).

## Implementation Notes
- File: `packages/server/src/middleware/plan-guard.ts`.
- Use the existing plan registry from M1-07.

## Out of Scope
- Cross-plan deduplication (orthogonal concern).

## Dependencies
- Blocks: nothing (refactor).
- Blocked by: M1-08, M1-09, M1-10, M1-11.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — guard middleware unit tests cover all rejection paths.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
