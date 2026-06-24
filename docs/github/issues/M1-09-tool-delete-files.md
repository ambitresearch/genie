---
title: "[M1-09] Tool: delete_files"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `delete_files` — every path must be in the plan's `deletes`. Skill
copies these verbatim from a diff file's `upload.deletePaths`. One known-good
failure to silently retry past: deleting a path that doesn't exist remotely
(floor-card components have no `_preview/` files).

## Context
- Research report §3.1: `delete_files({ planId, paths: string[] }):
  { deletedPaths: string[] }`.
- §1.3 confirmed claim: "delete_files — every path must be in the plan's
  `deletes`. … One known-good failure to retry past: a path that doesn't
  exist remotely".

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__delete_files`.
- [ ] AC2 — Input: `{ planId: string, paths: string[] }`.
- [ ] AC3 — Each `path` must match a glob in the plan's `deletes`; else
      `PathOutsidePlanError`.
- [ ] AC4 — Returns `{ deletedPaths: string[] }` listing what was actually
      removed (excludes "did-not-exist" entries).
- [ ] AC5 — A missing path is treated as a non-error and recorded in
      `notFoundPaths` (returned alongside `deletedPaths`).
- [ ] AC6 — Other errors (permission denied, etc.) fail the whole call.

## Implementation Notes
- File: `packages/server/src/tools/delete_files.ts`.
- Sort paths longest-first so we delete files before their containing
  directories (avoids ENOTEMPTY).

## Out of Scope
- Recursive directory delete (paths must be files, not directories).

## Dependencies
- Blocks: M3-05.
- Blocked by: M1-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, missing path (silent retry), out-of-plan
      rejection.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
