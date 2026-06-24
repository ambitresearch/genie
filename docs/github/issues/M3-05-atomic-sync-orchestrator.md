---
title: "[M3-05] 5-step atomic write sequence orchestrator"
milestone: "M3 — @dsCard Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P0-critical", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
Implement the 5-step atomic upload sequence the bundled skill enforces: (1)
write `_ds_needs_recompile` sentinel first to fence the manifest/copy
machinery, (2) chunk all content writes ≤256 per call, (3) all deletes, (4)
re-arm the sentinel, (5) write `_ds_sync.json` **last** as the verification
anchor. Mid-plan failure must leave `_ds_sync.json` unwritten so the next
sync's diff repairs the half-write.

## Context
- Research report §2.3 confirmed claim: the exact 5-step sequence is
  load-bearing — "Write `_ds_sync.json` **last** — it's the verification
  anchor; mid-plan failure leaves it vouching for files that aren't there."

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/sync/orchestrator.ts` exports
      `runAtomicSync({ planId, writes, deletes }): SyncResult`.
- [ ] AC2 — Step 1: writes `_ds_needs_recompile` with body `{"by":
      "genie"}` (matches the bundled skill's sentinel format).
- [ ] AC3 — Step 2: chunks `writes` into batches of ≤ 256, calls
      `write_files` per batch.
- [ ] AC4 — Step 3: calls `delete_files` with the deletes.
- [ ] AC5 — Step 4: re-arms `_ds_needs_recompile` (writes again).
- [ ] AC6 — Step 5: computes `_ds_sync.json` (M3-06) and writes it last.
- [ ] AC7 — If any step except a not-found delete fails, STOP without
      writing `_ds_sync.json` and return `{ ok: false, failedStep: N,
      error }`.
- [ ] AC8 — Idempotent re-run: detecting a stale sentinel + missing anchor =
      resume-from-step-2.
- [ ] AC9 — Emits structured events `{ step: 1..5, ok, ms }` for observability.

## Implementation Notes
- File: `packages/server/src/sync/orchestrator.ts`.
- Sentinel format and 5-step sequence: see `.deliverables/research-report.json`
  (`result.report` §2.2 manifest sentinel and §2.3 atomic upload sequence).
  Canonical sentinel literal: `{"by":"genie"}` written to
  `_ds_needs_recompile`. Anchor file: `_ds_sync.json` (last write).

## Out of Scope
- The `_ds_sync.json` schema itself (M3-06).
- Conflict resolution vs concurrent plans (rejected at plan-guard layer).

## Dependencies
- Blocks: M3-06.
- Blocked by: M1-08, M1-09, M3-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path; fault injection at each step; resume from
      partial state.
- [ ] Docs updated — `docs/04-tech-design-rfc.md` §3.3 reconstructed schema.
- [ ] Manual verification — fault-inject at step 3, observe missing anchor
      and resume.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
