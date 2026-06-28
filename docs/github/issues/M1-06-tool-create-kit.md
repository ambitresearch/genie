---
title: "[M1-06] Tool: create_kit"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `create_kit` — creates a new UI kit owned by the
caller; returns the `kitId` that `plan` will lock against. This
is the first permission-prompted verb in the protocol.

## Context
- Research report §3.1: `create_kit({ name }): { kitId }`.
- Research report §1.4 confirmed claim: "create_kit — creates a new
  UI kit owned by the user; returns the kitId to finalize
  against".

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__create_kit`.
- [ ] AC2 — Input: `{ name: string }` (required); the name is the
      human-readable display name, not the ID.
- [ ] AC3 — Output: `{ kitId: string }`.
- [ ] AC4 — `kitId` is a slug derived from `name` (lowercase, hyphens,
      ASCII only) plus a 6-char random suffix to dedupe.
- [ ] AC5 — Stamps `type: "GENIE_KIT"` immutably.
- [ ] AC6 — On `LocalFsStore`, creates the directory tree
      `${GENIE_HOME}/kits/<kitId>/`.
- [ ] AC7 — On `GitHostStore`, creates a new repo named `<kitId>`
      under the configured org/owner with `private: true` by default.
- [ ] AC8 — Returns `KitAlreadyExistsError` on collision (should be
      impossible with the random suffix, but defensive).

## Implementation Notes
- File: `packages/server/src/tools/create_kit.ts`.
- Name validation: max 64 chars, must match `[A-Za-z0-9 _-]+`.

## Out of Scope
- Importing an existing local directory as a kit (separate `import`
  verb not in the v1 surface).
- Kit deletion (no DesignSync verb).

## Dependencies
- Blocks: M1-07 (need `kitId` before plan).
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, collision, invalid name.
- [ ] Docs updated.
- [ ] Manual verification via MCP inspector on both adapters.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
