---
title: "[M1-18] Tool: create_project"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "priority:P0-critical", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Implement `create_project`, which creates blank workspaces, reusable blueprint projects, and workspaces instantiated from blueprints.

## Context
- D-F: a blueprint is technically a reusable project, modeled as `project.kind = "blueprint"`.
- PRD DS-023 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__create_project`.
- [ ] AC2 — Input: `{ name, kind, fromBlueprintId?, kitBindings? }`, where `kind` is `"workspace"` or `"blueprint"`.
- [ ] AC3 — Blank workspace creation writes `.genie/project.json` with `kind: "workspace"`.
- [ ] AC4 — Blank blueprint creation writes `.genie/project.json` with `kind: "blueprint"`.
- [ ] AC5 — Workspace-from-blueprint copies starter files and kit bindings, and records `sourceBlueprintId`.
- [ ] AC6 — Later edits to the source blueprint do not silently mutate derived workspaces.
- [ ] AC7 — Duplicate names raise `ERR_PROJECT_EXISTS` with a suggested slug.
- [ ] AC8 — Invalid `fromBlueprintId` raises `ERR_BLUEPRINT_NOT_FOUND`.

## Implementation Notes
- File: `packages/server/src/tools/create_project.ts`.
- Backed by `ProjectStore.createProject(args)`.
- Do not create a separate blueprint store or blueprint tool namespace.

## Out of Scope
- Syncing future blueprint changes into derived workspaces.
- Rich preview rendering for full-page screens.

## Dependencies
- Blocks: M1-20, M1-21.
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for workspace, blueprint, from-blueprint, duplicate, and missing-blueprint cases.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — create a workspace and a blueprint locally.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

