---
title: "[M1-05] Tool: read_file (with 256 KiB cap)"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `read_file` — returns the content of a single file. Hard-capped at
256 KiB per DesignSync's contract. The skill only ever uses it to fetch
`.genie/sync.json` as the verification anchor, but the verb must be general.

## Context
- Research report §3.1: `read_file({ kitId, path }): { content: string }
  // 256 KiB cap`.
- Research report §1.4 confirmed claim: "read_file — capped at 256 KiB; the
  skill only ever uses it to fetch `.genie/sync.json` as the verification
  anchor".

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__read_file`.
- [ ] AC2 — Input: `{ kitId: string, path: string }`.
- [ ] AC3 — Returns `{ content: string, encoding: "utf-8" | "base64",
      mimeType: string }`.
- [ ] AC4 — Files > 256 KiB return MCP error `-32603` with message
      `"File exceeds 256 KiB cap (actual: <N> bytes)"`.
- [ ] AC5 — Binary files (per content-type detection) are returned as base64.
- [ ] AC6 — Path traversal (`../` segments) raises
      `InvalidPathError` and rejects the call.
- [ ] AC7 — Unknown path returns MCP error `-32602`.

## Implementation Notes
- File: `packages/server/src/tools/read_file.ts`.
- MIME detection via `mime-types` package.
- Path traversal check: normalise + assert prefix matches project root.

## Out of Scope
- Range requests (no DesignSync verb supports this).
- Server-side decompression (file is returned as-stored).

## Dependencies
- Blocks: M3-04 (anchor read).
- Blocked by: M1-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — small file, exactly 256 KiB, over cap, binary, path
      traversal.
- [ ] Docs updated.
- [ ] Manual verification via MCP inspector.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
