---
title: "[M5-13] Cursor harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:cursor", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship the Cursor config snippet for `.cursor/mcp.json` or
`~/.cursor/mcp.json`. Tests the `auth` block (Cursor's OAuth shape) and
sniffs whether the historical 40-tool cap is still enforced.

## Context
- Research report §4 Cursor row: "The historical 40-tool cap is **not** in
  current docs page; treat as unverified. `auth: { CLIENT_ID, CLIENT_SECRET,
  scopes }` for OAuth; static callback at
  `https://www.cursor.com/agents/mcp/oauth/callback`."
- Open question (research §8): "Cursor's 40-tool cap — historical claim,
  not in current docs. Ship 50+ tools and observe; if 40 are loaded, the cap
  survived."

## Acceptance Criteria
- [ ] AC1 — `docs/harness/cursor.md` includes the canonical snippet
      using the `auth` block with `CLIENT_ID`/`CLIENT_SECRET`/`scopes`.
- [ ] AC2 — Documents `env:` interpolation tokens (`${env:VAR}`).
- [ ] AC3 — Smoke test installs the server, runs the four-verb chain,
      asserts `ui://genie/grid` renders via Cursor's Apps
      extension.
- [ ] AC4 — Tool-cap probe: registers 50+ dummy tools alongside the real
      ones; logs how many Cursor exposes; writes the result into
      `docs/harness/cursor.md` as a confirmed empirical finding.
- [ ] AC5 — Documents the static callback URL
      `https://www.cursor.com/agents/mcp/oauth/callback` and how the OAuth
      flow lands there.

## Implementation Notes
- File: `docs/harness/cursor.md`,
  `packages/e2e/test/m5-smoke-cursor.test.ts`.

## Out of Scope
- "Add to Cursor" deeplink format (undocumented per research §8).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M5-01, M4-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added.
- [ ] Docs updated — 40-tool finding recorded.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
