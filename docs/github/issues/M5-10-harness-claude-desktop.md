---
title: "[M5-10] Claude Desktop harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:claude-desktop", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary

Ship the Claude Desktop config snippet for
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), plus the Linux beta's
`~/.config/Claude/claude_desktop_config.json` default. Smoke test via `.mcpb`
install (M5-05).

## Context

- Research report §4 Claude Desktop row + §7 snippets.

## Acceptance Criteria

- [ ] AC1 — `docs/harness/claude-desktop.md` includes the snippet (stdio
      transport via `npx -y @genie/server`). The original bare `genie` name
      is occupied by an unrelated npm package; M5-06 owns publishing the
      scoped package.
- [ ] AC2 — Documents current Linux beta support: Ubuntu 22.04 LTS+ or
      Debian 12+ on x64/arm64. This supersedes the original non-support
      wording after Anthropic shipped its official Linux beta.
- [ ] AC3 — Documents `~/Library/Logs/Claude/mcp*.log` for debugging.
- [ ] AC4 — Documents the `mcp-remote` bridge pattern for users who want to
      reach a remote server from Desktop.
- [ ] AC5 — `.mcpb` install is the recommended path; the JSON snippet is
      "if you prefer".
- [ ] AC6 — Smoke test installs the `.mcpb`, opens Claude Desktop, fires
      `list_kits`, captures screenshot.

## Implementation Notes

- File: `docs/harness/claude-desktop.md`,
  `packages/e2e/test/m5-smoke-claude-desktop.test.ts`.

## Out of Scope

- Windows- and Linux-specific smoke (defer to v2; AC6 is macOS-tested).

## Dependencies

- Blocks: M5 milestone close.
- Blocked by: M5-05, M5-02, M5-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
and explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done

- [ ] Tests added — smoke + screenshot.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
