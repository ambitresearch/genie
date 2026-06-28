---
title: "[M1-16] Tool: list_projects"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `list_projects`, the read-only project discovery tool for workspaces and reusable blueprint projects.

## Context
- D-F (`00-decisions.md`): a project is the screen/app workspace that binds one or more kits; a blueprint is a reusable project with `kind: "blueprint"`.
- PRD DS-021 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__list_projects`.
- [ ] AC2 — Description ≤ 2 KB and JSON Schema is Draft 7 only.
- [ ] AC3 — Input is `{}`.
- [ ] AC4 — Returns `projects[]` with `id`, `name`, `kind`, `defaultKitId`, `kitBindings`, `updatedAt`, and `canEdit`.
- [ ] AC5 — Includes both `workspace` and `blueprint` projects.
- [ ] AC6 — Returns `[]` when no projects exist.
- [ ] AC7 — Local results still return with `_meta.warnings` when a git-host backend is unreachable.
- [ ] AC8 — Results are deterministically sorted by `kind`, then `name`, then `id`.

## Implementation Notes
- File: `packages/server/src/tools/list_projects.ts`.
- Backed by `ProjectStore.listProjects()`.
- Reuse pagination/warning patterns from `list_kits`.

## Out of Scope
- Full-text search and project grouping.
- Hosted preview gallery.

## Dependencies
- Blocks: M1-17, M1-20, M1-21.
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for empty, local, mixed-kind, and unreachable-backend cases.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — `list_projects` returns a fixture workspace and blueprint.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

