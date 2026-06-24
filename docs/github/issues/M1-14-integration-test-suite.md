---
title: "[M1-14] M1 integration test suite (12-method conformance)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:test", "area:mcp-tools", "priority:P0-critical", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
End-to-end conformance test suite that walks the protocol read → finalize_plan
→ write/delete sequence and asserts the strict ordering documented by
DesignSync. Runs against both `LocalFsStore` and `GiteaStore`.

## Context
- Research report §1.3 confirmed claim documents the strict ordering: "Required
  ordering: list/read → finalize_plan → write/delete. Calling write, delete,
  register, or unregister without a valid `planId`, or with paths outside the
  plan, is rejected."

## Acceptance Criteria
- [ ] AC1 — File `packages/e2e/test/m1-conformance.test.ts`.
- [ ] AC2 — Spins up the MCP server in-process via
      `@modelcontextprotocol/sdk`'s test transport.
- [ ] AC3 — Walks the full sequence: `create_project` → `list_files`
      (empty) → `finalize_plan` → `write_files` (5 files) →
      `list_files` (5 entries) → `get_file` round-trip → `delete_files` →
      `report_validate`.
- [ ] AC4 — Repeats the suite against `GiteaStore` (using a Docker-Compose
      Gitea in CI).
- [ ] AC5 — Negative path: writing without `planId` returns `-32602`; writing
      outside plan returns `-32602`.
- [ ] AC6 — Test report uploaded as CI artefact.
- [ ] AC7 — Suite runs in < 60 s wall-clock.

## Implementation Notes
- Use the testcontainers `gitea/gitea:latest` image for the Gitea suite.
- Mock LiteLLM with a stub server (no real model calls in M1).
- Coverage gate ≥ 85 % on `packages/server/src/tools/`.

## Out of Scope
- LLM / `generate_component` tests (M2-09).
- Manifest validator tests (M3-06).

## Dependencies
- Blocks: M1 milestone close.
- Blocked by: M1-02 … M1-13.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — the suite **is** the deliverable.
- [ ] Docs updated — CONTRIBUTING describes how to run integration tests
      locally.
- [ ] Manual verification — `pnpm e2e` green.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
