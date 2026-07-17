---
title: "[M5-09] Claude Code harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:claude-code", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship the Claude Code config snippet for `~/.claude.json` (or project
`.mcp.json`) and an automated Playwright smoke that runs
`conjure → write_files → preview → validate`
inside Claude Code. Capture screenshots. `write_files` precedes `preview`
because preview compiles the grid from the kit contents already on disk.

## Context
- Research report §7 step 11 + per-harness snippets.
- Tool name shape `mcp__genie__<verb>`.

## Acceptance Criteria
- [ ] AC1 — `docs/harness/claude-code.md` contains the canonical
      `~/.claude.json` snippet (HTTP transport + `apiKeyHelper` pattern).
- [ ] AC2 — Snippet documents the OAuth flow + `apiKeyHelper` script
      template.
- [ ] AC3 — Gotcha: callout that OAuth login can bypass the configured LLM endpoint
      routing in Claude Code (research CLAUDE.md gotcha — `/logout` to restore routing).
- [ ] AC4 — Smoke test boots Claude Code in a Docker sandbox, connects it to
      a real genie HTTP server owned by the host test process, runs the
      four-verb chain, and captures screenshots.
- [ ] AC5 — Smoke test asserts each tool call returns non-error.
- [ ] AC6 — Screenshots saved to `docs/harness/screenshots/claude-code/`.
- [ ] AC7 — Smoke runs in M5 CI workflow (manually triggered).

## Implementation Notes
- File: `docs/harness/claude-code.md`, `packages/e2e/test/m5-smoke-claude-code.test.ts`.

## Out of Scope
- Cross-OS smoke (macOS-only is fine for v1).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M2-03, M3-04, M4-05, M5-01, M5-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — Playwright smoke.
- [ ] Docs updated — harness snippet doc.
- [ ] Manual verification — copy-paste snippet onto a clean profile, all
      four verbs work.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
