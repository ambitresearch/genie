---
title: "[M5-14] Cline harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:cline", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary

Ship the Cline config snippet for
`~/.cline/data/settings/cline_mcp_settings.json` and document the versioned
IDE-extension migration path. Cline is tools-only; the pinned real-CLI smoke
asserts the four-verb chain works and the `ui://` resource degrades to text.

## Context

- Current Cline requires `type: "streamableHttp"`; omitting it from a flat
  HTTP entry falls back to legacy SSE. This supersedes the older research
  report's "no type key" observation.

## Acceptance Criteria

- [x] AC1 — `docs/harness/cline.md` includes the snippet using `url` +
      `headers` for HTTP transport and `autoApprove` for read-only verbs.
- [x] AC2 — Documents the required `type: "streamableHttp"` correction and
      why omitting it selects legacy SSE.
- [x] AC3 — Documents the exact registered `mcp__genie__*` read-only tool
      names in `autoApprove`.
- [x] AC4 — Empirically locates and documents the IDE-extension settings
      path (open question 12 from research) and notes the date of the probe.
- [x] AC5 — Smoke test runs the four-verb chain via pinned Cline; asserts
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

- explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done

- [ ] Tests added.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
