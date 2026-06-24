---
title: "[M1-02] Tool: list_projects"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `list_projects` MCP tool — returns the user's writable design-system
projects. Mirrors DesignSync's filter `type: PROJECT_TYPE_DESIGN_SYSTEM`.

## Context
- Research report §3.1 tool surface:
  `list_projects(): { id, name, owner, updatedAt, canEdit }[]`.
- Research report §1.4 confirmed claim: "list_projects — lists writable
  design-system projects (filtered to `type: PROJECT_TYPE_DESIGN_SYSTEM`)".

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__list_projects` (Claude rewrite
      rule applied).
- [ ] AC2 — Description ≤ 2 KB (Claude truncation limit).
- [ ] AC3 — JSON Schema is Draft 7 only — no `anyOf` / `$ref` chains.
- [ ] AC4 — Returns an array of
      `{ id: string, name: string, owner: string, updatedAt: string (ISO 8601),
      canEdit: boolean }`.
- [ ] AC5 — Filters out projects whose stored `type !==
      "PROJECT_TYPE_DESIGN_SYSTEM"`.
- [ ] AC6 — Returns `[]` (not `null`, not error) when the user has no
      projects.
- [ ] AC7 — Backed by `ProjectStore.listProjects()`.

## Implementation Notes
- File: `packages/server/src/tools/list_projects.ts`.
- Register in `packages/server/src/tools/index.ts`.
- Description template from research report §3.1 — copy verbatim where ≤ 2 KB.

## Out of Scope
- Pagination (v1 returns all; revisit in v2 if any user crosses 100 projects).
- Search/filter (v1 client-side only).

## Dependencies
- Blocks: M1-03 (clients call `list_projects` to discover IDs).
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — unit (mocked store) + integration (real LocalFsStore).
- [ ] Docs updated — `docs/04-tech-design-rfc.md` §3.1 tool list.
- [ ] Manual verification — call from `npx @modelcontextprotocol/inspector`.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
