---
title: "[M1-21] Tool: conjure_screen"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:projects", "area:generation", "priority:P0-critical", "size:L"]
assignees: []
estimate: "8h"
---

## Summary
Implement `conjure_screen`, the M1 project-aware generation contract for screen artifacts.

## Context
- D-F: screens use a project and resolve kits by explicit request, project default, then sole reachable binding.
- Blueprints are reusable projects, not a separate tool family.
- PRD DS-026 defines the M1 behavior.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__conjure_screen`.
- [ ] AC2 — Input: `{ projectId, prompt, kitId?, blueprintId?, framework?, model? }`.
- [ ] AC3 — Resolves kit in order: explicit `kitId`, project `defaultKitId`, then sole reachable binding.
- [ ] AC4 — Given no bound kit and a prompt that asks for kit-specific components, raises `ERR_PROJECT_KIT_REQUIRED`.
- [ ] AC5 — Given no bound kit and a prompt for basic structure, may generate framework-neutral screen structure but must not pretend it used a kit.
- [ ] AC6 — Given `blueprintId`, seeds the screen from that reusable project template.
- [ ] AC7 — On success, records the screen in `.genie/project.json` and returns `screenId`, `files`, and `usage`.
- [ ] AC8 — Tests use a stubbed model endpoint; no real model call is required for M1 CI.

## Implementation Notes
- File: `packages/server/src/tools/conjure_screen.ts`.
- Backed by `ProjectStore.recordScreen()` and the same generation-client interface later deepened by M2.
- Keep output as an artifact set; richer full-page preview/review UX is DS-080.

## Out of Scope
- Production prompt quality evaluation.
- Region-targeted full-page refinement.
- Freeform drag-to-reflow canvas.

## Dependencies
- Blocks: M1-14.
- Blocked by: M1-01, M1-17, M1-18, M1-20.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added for explicit/default/sole kit resolution, missing-kit failure, kitless basic structure, blueprint seed, and manifest recording.
- [ ] Docs updated if the schema changes.
- [ ] Manual verification — `conjure_screen` records a fixture screen with a stubbed model.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.

