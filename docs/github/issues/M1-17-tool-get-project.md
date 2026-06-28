---
title: "[M1-17] Tool: get_project"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `get_project`, the metadata read tool for workspace and blueprint project manifests.

## Context
- Projects persist their own `.genie/project.json`; project state is not nested inside a kit.
- PRD DS-022 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__get_project`.
- [ ] AC2 — Input: `{ projectId: string }`.
- [ ] AC3 — Given a valid project, returns `id`, `name`, `kind`, `defaultKitId`, `kitBindings`, `screens`, `canEdit`, and optional `sourceBlueprintId`.
- [ ] AC4 — Given a blueprint project, returns `kind: "blueprint"` with no special-case tool family.
- [ ] AC5 — Given an invalid id, raises `ERR_PROJECT_NOT_FOUND` with the id echoed.
- [ ] AC6 — Read-only projects return `canEdit: false`.

## Implementation Notes
- File: `packages/server/src/tools/get_project.ts`.
- Backed by `ProjectStore.getProject(projectId)`.
- Share schema helpers with `list_projects`.

## Out of Scope
- Loading screen file contents; use `read_file` once project-targeted file reads are introduced.

## Dependencies
- Blocks: M1-20, M1-21.
- Blocked by: M1-01, M1-16.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for workspace, blueprint, missing, and read-only manifests.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — `get_project` reads a fixture workspace and blueprint.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

