---
title: "[M1-03] Tool: get_project"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "2h"
---

## Summary
Implement `get_project` — returns metadata for a single project; confirms the
`projectId` actually has design-system type (immutable at creation).

## Context
- Research report §3.1: `get_project({ projectId }): { id, name, type:
  "PROJECT_TYPE_DESIGN_SYSTEM", canEdit }`.

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__get_project`.
- [ ] AC2 — Input schema: `{ projectId: string }` (required).
- [ ] AC3 — Returns `{ id, name, type, canEdit, createdAt, updatedAt }` with
      `type` literal `"PROJECT_TYPE_DESIGN_SYSTEM"`.
- [ ] AC4 — Returns `ProjectNotFoundError` MCP error code `-32602` on unknown
      `projectId`.
- [ ] AC5 — Returns `WrongProjectTypeError` if the project exists but is not a
      design system (defensive — `LocalFsStore` only stores design systems,
      but `GiteaStore` shares the namespace with the user's other repos).

## Implementation Notes
- File: `packages/server/src/tools/get_project.ts`.
- Reuse `ProjectStore.getProject()`.

## Out of Scope
- Editing project metadata (no DesignSync verb for this).

## Dependencies
- Blocks: M1-04, M1-05, M1-06 (need to verify `projectId` before any other op).
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path + both error paths.
- [ ] Docs updated.
- [ ] Manual verification via MCP inspector.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
