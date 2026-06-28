---
title: "[M1-20] Tool: bind_kit"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Implement `bind_kit`, which attaches UI kits to projects and optionally marks one as the default for screen generation.

## Context
- D-F default-kit resolution: explicit kit, project default, sole reachable kit, then stop and ask before kit-specific generation.
- PRD DS-025 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__bind_kit`.
- [ ] AC2 — Input: `{ projectId, kitId, default?: boolean }`.
- [ ] AC3 — Given a valid project and kit, writes the binding to `.genie/project.json`.
- [ ] AC4 — Given `default: true`, sets `defaultKitId` and clears default status from any previous binding.
- [ ] AC5 — Given an invalid `projectId`, raises `ERR_PROJECT_NOT_FOUND`.
- [ ] AC6 — Given an invalid `kitId`, raises `ERR_KIT_NOT_FOUND`.
- [ ] AC7 — Given a blueprint project, the binding is allowed and copies into derived workspaces.
- [ ] AC8 — Binding the same kit twice is idempotent.

## Implementation Notes
- File: `packages/server/src/tools/bind_kit.ts`.
- Backed by `ProjectStore.bindKit({ projectId, kitId, default })`.
- Reuse `get_kit` validation before writing the project manifest.

## Out of Scope
- Per-screen kit overrides beyond the explicit `kitId` request field.
- ACL and sharing policy.

## Dependencies
- Blocks: M1-21.
- Blocked by: M1-01, M1-03, M1-17, M1-18.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for new binding, default replacement, duplicate binding, invalid project, invalid kit, and blueprint binding.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — bind a kit to a fixture workspace and blueprint.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

