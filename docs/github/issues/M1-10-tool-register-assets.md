---
title: "[M1-10] Tool: register_assets (legacy)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P2-medium", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `register_assets` — legacy verb for hand-authored projects without
`@dsCard` markers. New projects should use the first-line marker mechanism
(M3-01) instead; this verb stays for backward-compat with any existing
DesignSync consumer.

## Context
- Research report §3.1: `register_assets({ planId, assets }): {}`.
- §1.3 confirmed claim: "register_assets / unregister_assets — **legacy.** …
  Use only for hand-authored projects without `@dsCard` markers. Each asset
  takes `name`, `path` (must be in plan's writes), `viewport`, and `group`."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__register_assets`.
- [ ] AC2 — Input: `{ planId: string, assets: { name: string, path: string,
      viewport: { width: number, height: number }, group: string }[] }`.
- [ ] AC3 — Each asset's `path` must match a glob in the plan's `writes`.
- [ ] AC4 — Persists registrations to the project's
      `_ds_registry.json` (separate from `manifest.json` because legacy).
- [ ] AC5 — Description explicitly marks the verb as legacy and points users
      at `@dsCard` markers (research report §2.2).
- [ ] AC6 — Returns `{}` (DesignSync schema returns empty object).

## Implementation Notes
- File: `packages/server/src/tools/register_assets.ts`.
- Keep description ≤ 2 KB; lead with the deprecation note.

## Out of Scope
- Auto-migration from `_ds_registry.json` to `@dsCard` markers (separate
  tool, not in v1).

## Dependencies
- Blocks: nothing critical; M1-13 (tests) covers it.
- Blocked by: M1-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, out-of-plan rejection.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
