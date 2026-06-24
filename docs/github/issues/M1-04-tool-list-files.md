---
title: "[M1-04] Tool: list_files"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `list_files` — returns the project's file tree with size, hash, and
mtime. Used by clients to detect empty vs non-empty projects (drives "atomic
vs incremental" upload path) and to confirm post-upload counts.

## Context
- Research report §3.1: `list_files({ projectId }): { path, size, hash,
  lastModified }[]`.
- Research report §1.4 confirmed claim: "list_files — used to detect empty vs
  non-empty projects (which drives 'atomic' vs 'incremental' upload path) and
  to confirm post-upload counts".

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__list_files`.
- [ ] AC2 — Input: `{ projectId: string }`.
- [ ] AC3 — Returns array of
      `{ path: string, size: number, hash: string ("sha256-..."),
      lastModified: string }`.
- [ ] AC4 — Paths are forward-slash-delimited and project-root-relative
      (never absolute).
- [ ] AC5 — `hash` uses SHA-256 of file bytes, base64-encoded, prefixed
      `sha256-` (matches Subresource Integrity format).
- [ ] AC6 — Hidden files (dot-prefixed) are included — `_ds_needs_recompile`
      and `_ds_sync.json` must show up.
- [ ] AC7 — `node_modules`, `.git`, and `dist` are excluded (configurable via
      `.genieignore`).

## Implementation Notes
- File: `packages/server/src/tools/list_files.ts`.
- Hash computation is expensive — for `GiteaStore`, reuse git's blob SHA
  (translate `sha1-...` → `sha256-` via lookup if needed, or document the
  difference).

## Out of Scope
- Glob filtering on input (the schema is just `projectId`).
- Diff against a previous snapshot (that's `validate_design_system`).

## Dependencies
- Blocks: M1-05 (needs to know what files exist before reading them).
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — empty project, non-empty project, ignore-pattern matching.
- [ ] Docs updated.
- [ ] Manual verification via MCP inspector.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
