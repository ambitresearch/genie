---
title: "[M5-11] Codex CLI harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:codex", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship the Codex CLI config snippet for `~/.codex/config.toml`. Critical
gotcha: NO `type` key — Codex infers transport from `command` (stdio) vs
`url` (HTTP). Uses `bearer_token_env_var`, NOT plain `headers`.

## Context
- Research report §4 Codex CLI row: "**No `type`/`transport` key** —
  transport is implicit by which keys present (`command` → stdio, `url` →
  HTTP). Use `bearer_token_env_var`/`http_headers`/`env_http_headers`, **not**
  plain `headers`."
- Confirmed claim re: documented keys.

## Acceptance Criteria
- [ ] AC1 — `docs/harness/codex.md` contains the canonical TOML snippet:
      ```toml
      [mcp_servers.genie]
      url = "https://genie.${DOMAIN}/mcp"
      bearer_token_env_var = "GENIE_TOKEN"
      startup_timeout_sec = 15
      tool_timeout_sec = 120
      ```
- [ ] AC2 — Doc explicitly warns against adding a `type` key (will be
      silently ignored or cause errors).
- [ ] AC3 — Documents `codex mcp login genie` for OAuth path.
- [ ] AC4 — Documents `enabled_tools` allow-list / `disabled_tools`
      deny-list usage.
- [ ] AC5 — Notes Codex is tools-only — `ui://` resources downgrade to
      text-only output.
- [ ] AC6 — Smoke test runs the four-verb chain via Codex's REPL,
      captures terminal output.

## Implementation Notes
- File: `docs/harness/codex.md`,
  `packages/e2e/test/m5-smoke-codex.test.ts`.
- Smoke uses `expect` (TCL) to drive the Codex REPL.

## Out of Scope
- Cursor-style "Add to Codex" deeplinks (undocumented).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M5-01.

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
