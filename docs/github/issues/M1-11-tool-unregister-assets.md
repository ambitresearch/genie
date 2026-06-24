---
title: "[M1-11] Tool: unregister_assets (legacy)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P2-medium", "size:XS"]
assignees: []
estimate: "1h"
---

## Summary
Implement `unregister_assets` — pair of `register_assets`. Removes entries
from `_ds_registry.json`. Same legacy disclaimer applies.

## Context
- Research report §3.1: `unregister_assets({ planId, paths }): {}`.

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__unregister_assets`.
- [ ] AC2 — Input: `{ planId: string, paths: string[] }`.
- [ ] AC3 — Each path must be present in `_ds_registry.json`; missing entries
      are silently ignored.
- [ ] AC4 — Returns `{}`.
- [ ] AC5 — Description marks the verb as legacy (same wording as M1-10).

## Implementation Notes
- File: `packages/server/src/tools/unregister_assets.ts`.

## Out of Scope
- Anything beyond mirror behaviour for M1-10.

## Dependencies
- Blocks: nothing.
- Blocked by: M1-10.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, missing-path silent skip.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
