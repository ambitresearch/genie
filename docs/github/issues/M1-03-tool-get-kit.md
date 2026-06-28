---
title: "[M1-03] Tool: get_kit"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "2h"
---

## Summary
Implement `get_kit` — returns metadata for a single project; confirms the
`kitId` actually resolves to a UI kit (or to a mapped Claude Design project in interop mode).

## Context
- Research report §3.1: `get_kit({ kitId }): { id, name, type:
  "GENIE_KIT", canEdit }`.

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__get_kit`.
- [ ] AC2 — Input schema: `{ kitId: string }` (required).
- [ ] AC3 — Returns `{ id, name, type, canEdit, createdAt, updatedAt }` with
      `type` literal `"GENIE_KIT"`.
- [ ] AC4 — Returns `ProjectNotFoundError` MCP error code `-32602` on unknown
      `kitId`.
- [ ] AC5 — Returns `WrongProjectTypeError` if the project exists but is not a
      UI kit (defensive — `LocalFsStore` only stores UI kits,
      but `GitHostStore` shares the namespace with the user's other repos).

## Implementation Notes
- File: `packages/server/src/tools/get_kit.ts`.
- Reuse `KitStore.getKit()`.

## Out of Scope
- Editing project metadata (no DesignSync verb for this).

## Dependencies
- Blocks: M1-04, M1-05, M1-06 (need to verify `kitId` before any other op).
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
