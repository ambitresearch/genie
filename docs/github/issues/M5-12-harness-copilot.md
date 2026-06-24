---
title: "[M5-12] VS Code Copilot harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:copilot", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship the VS Code Copilot Chat config snippet for `.vscode/mcp.json` (uses
top-level `servers`, NOT `mcpServers`). Smoke test verifies inline `ui://`
rendering in the Insiders build (Stable in Jan 2026 per microsoft/vscode#260218).

## Context
- Research report §4 Copilot row: "Top-level key is `servers` (not
  Cursor/Desktop's `mcpServers`). Sandbox flag `sandboxEnabled: true` for
  stdio (macOS/Linux only)."
- VS Code MCP Apps: targeted for VS Code Stable Jan 2026 (see INDEX
  honest-uncertainty #4 — verify pre-launch; tracked in
  microsoft/vscode#260218).

## Acceptance Criteria
- [ ] AC1 — `docs/harness/copilot.md` includes the canonical snippet:
      ```json
      { "servers": { "genie": { "type": "http",
          "url": "https://genie.${DOMAIN}/mcp" } } }
      ```
- [ ] AC2 — Warns about the `servers` (not `mcpServers`) gotcha.
- [ ] AC3 — Documents `sandbox.network.allowedDomains` config for stdio
      installs on macOS/Linux.
- [ ] AC4 — Documents one-click install: search `@mcp` → install button.
- [ ] AC5 — Documents `code --add-mcp "..."` CLI install path.
- [ ] AC6 — Smoke test runs the four-verb chain in VS Code Insiders;
      asserts `ui://genie/grid` renders inline (not as text).
- [ ] AC7 — Falls back to text-only assertion when running on Stable (until
      Jan 2026 ships).

## Implementation Notes
- File: `docs/harness/copilot.md`,
  `packages/e2e/test/m5-smoke-copilot.test.ts`.

## Out of Scope
- Devcontainer integration (mention in docs, no smoke).

## Dependencies
- Blocks: M5 milestone close.
- Blocked by: M4-06, M5-02.

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
- [ ] Manual verification — install on Insiders, inline grid renders.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
