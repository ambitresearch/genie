---
title: "[M5-14] Cline harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:cline", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship the Cline config snippet for `~/.cline/mcp.json` (CLI) and document the
IDE-extension settings path (per research §8 open question — to be
re-confirmed empirically). Cline is tools-only; smoke test asserts the
four-verb chain works and the `ui://` resource degrades to text.

## Context
- Research report §4 Cline row: "**No `type` key in JSON examples** —
  transport is implicit (presence of `command` vs `url`). `autoApprove`
  array per server."

## Acceptance Criteria
- [ ] AC1 — `docs/harness/cline.md` includes the snippet using `url` +
      `headers` for HTTP transport and `autoApprove` for read-only verbs.
- [ ] AC2 — Warns against adding a `type` key (silently ignored or
      breaks).
- [ ] AC3 — Documents `autoApprove: ["list_components",
      "render_preview", "list_files"]` as the recommended baseline.
- [ ] AC4 — Empirically locates and documents the IDE-extension settings
      path (open question 12 from research) and notes the date of the probe.
- [ ] AC5 — Smoke test runs the four-verb chain via Cline; asserts
      `ui://` content shows as text (not silently dropped).

## Implementation Notes
- File: `docs/harness/cline.md`,
  `packages/e2e/test/m5-smoke-cline.test.ts`.

## Out of Scope
- One-click install via Cline Marketplace (mention, no smoke).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M5-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
