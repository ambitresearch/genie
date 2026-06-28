---
title: "[M1-14] M1 integration test suite (19-tool conformance)"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:test", "area:mcp-tools", "priority:P0-critical", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
End-to-end conformance test suite that walks genie's kit protocol read → plan
→ write/delete sequence and the project/blueprint workflow. Runs against both
`LocalFsStore` and `GitHostStore`.

## Context
- Research report §1.3 confirmed claim documents the strict ordering: "Required
  ordering: list/read → plan → write/delete. Calling write, delete,
  register, or unregister without a valid `planId`, or with paths outside the
  plan, is rejected."

## Acceptance Criteria
- [ ] AC1 — File `packages/e2e/test/m1-conformance.test.ts`.
- [ ] AC2 — Spins up the MCP server in-process via
      `@modelcontextprotocol/sdk`'s test transport.
- [ ] AC3 — Walks the full kit sequence: `create_kit` → `list_files`
      (empty) → `plan` → `write_files` (5 files) →
      `list_files` (5 entries) → `read_file` round-trip → `delete_files` →
      `validate`.
- [ ] AC4 — Walks the full project sequence: `create_project` with
      `kind: "blueprint"` → `create_project` from blueprint → `bind_kit` →
      `list_projects` → `get_project` → `conjure_screen` with a stubbed model →
      `delete_project`.
- [ ] AC5 — Repeats the suite against `GitHostStore` (using a Docker-Compose
      Gitea instance in CI as the reference git host).
- [ ] AC6 — Negative path: writing without `planId` returns `-32602`; writing
      outside plan returns `-32602`.
- [ ] AC7 — Negative path: `conjure_screen` with no bound kit and a kit-specific
      prompt returns `ERR_PROJECT_KIT_REQUIRED`.
- [ ] AC8 — Test report uploaded as CI artefact.
- [ ] AC9 — Suite runs in < 60 s wall-clock.

## Implementation Notes
- Use the testcontainers `gitea/gitea:latest` image for the Gitea suite.
- Mock the LLM endpoint with a stub server (no real model calls in M1).
- Coverage gate ≥ 85 % on `packages/server/src/tools/`.

## Out of Scope
- Production LLM / `conjure` quality tests (M2-09).
- Manifest validator tests (M3-06).

## Dependencies
- Blocks: M1 milestone close.
- Blocked by: M1-02 … M1-13, M1-16 … M1-21.

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
