---
title: "[M1-19] Tool: delete_project"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `delete_project`, the explicit removal tool for workspace and blueprint project targets.

## Context
- Projects are first-class targets with their own `.genie/project.json`.
- Deleting a blueprint must not delete workspaces that were previously instantiated from it.
- PRD DS-024 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__delete_project`.
- [ ] AC2 — Input: `{ projectId: string }`.
- [ ] AC3 — Given an editable project, deletes it and returns `{ deletedProjectId }`.
- [ ] AC4 — Given a missing project, succeeds idempotently and reports the missing id in `_meta.warnings`.
- [ ] AC5 — Given a read-only project, raises `ERR_PROJECT_READONLY`.
- [ ] AC6 — Given a blueprint with derived workspaces, only the blueprint is deleted.

## Implementation Notes
- File: `packages/server/src/tools/delete_project.ts`.
- Backed by `ProjectStore.deleteProject(projectId)`.
- Match `delete_files` idempotency style for missing targets.

## Out of Scope
- Trash/restore UI.
- Cascade delete of derived workspaces.

## Dependencies
- Blocks: M1-14.
- Blocked by: M1-01, M1-18.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for success, missing, read-only, and blueprint-with-derived-workspaces cases.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — deleting a fixture project leaves unrelated workspaces intact.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

