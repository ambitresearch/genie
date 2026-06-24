---
title: "[M1-08] Tool: write_files (≤256 files/call, reads from localPath)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
Implement `write_files` — every path must match a glob in the plan's `writes`.
Max 256 files per call. Reads from `localPath` so file contents never enter
model context. Also handles `data` (inline) and `encoding` for binary
payloads. Implements the byte-cap retry pattern: on HTTP 500 halve the chunk
size and retry.

## Context
- Research report §3.1: `write_files({ planId, files: { path, localPath?,
  data?, encoding?, mimeType? }[] }): { writtenPaths: string[] }`.
- §1.3 confirmed claim: "write_files — every path must be in the plan's
  `writes`. Max 256 files per call. The tool reads from `localPath` so
  contents never enter the model context."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__write_files`.
- [ ] AC2 — Input schema: see Summary.
- [ ] AC3 — `files.length ≤ 256` enforced; else `TooManyFilesError`.
- [ ] AC4 — Each `path` must match at least one glob in the plan's `writes`;
      else `PathOutsidePlanError` with the offending path.
- [ ] AC5 — `planId` validation: existence + not-expired.
- [ ] AC6 — `localPath` is resolved against the plan's `localDir`; reads
      outside are rejected.
- [ ] AC7 — `data` (base64 or utf-8 per `encoding`) is the alternative input
      mode; both `localPath` and `data` set ⇒ error.
- [ ] AC8 — Returns `{ writtenPaths: string[] }` matching input order.
- [ ] AC9 — On byte-cap overflow, return HTTP-equivalent error code `-32099`
      with `{ retryWith: { maxFiles: <half> } }` in `data`.
- [ ] AC10 — Atomic per-call: if any file fails after partial writes, the
      whole call is rolled back (rename-to-temp + rename-back pattern).

## Implementation Notes
- File: `packages/server/src/tools/write_files.ts`.
- Streaming reads (don't load full file into memory; pipe through hash).
- Per-call transaction = write to `<projectRoot>/.genie-tmp/<callId>/`
  then atomic rename per file.

## Out of Scope
- The 5-step atomic sequence (sentinel·chunks·deletes·sentinel·anchor) — that
  lives in M3-05.
- Conflict detection vs concurrent writes from another plan — out of scope
  for v1; document as a known limitation.

## Dependencies
- Blocks: M3-05 (atomic sequence orchestrator).
- Blocked by: M1-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, out-of-plan rejection, > 256 files,
      localPath escape, byte-cap retry path, rollback on partial fail.
- [ ] Docs updated.
- [ ] Manual verification via MCP inspector with a 100-file plan.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
