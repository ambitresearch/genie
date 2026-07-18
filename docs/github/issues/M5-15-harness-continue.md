---
title: "[M5-15] Continue.dev harness config snippet + smoke test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "type:test", "area:harness:continue", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary

Ship the Continue.dev config snippet for `.continue/mcpServers/`. Continue
accepts an optional explicit `type` discriminator (`stdio | sse |
streamable-http`) and uses `${{ secrets.NAME }}` interpolation. MCP only works
in agent mode; Continue CLI exposes that loop through scriptable `cn -p`.

## Context

- The original research report's explicit-`type` requirement is stale. Current
  Continue makes `type` optional and infers stdio from `command`; remote entries
  try Streamable HTTP and then SSE. Secrets use `${{ secrets.NAME }}` and MCP is
  usable only in **agent mode**.

## Acceptance Criteria

- [ ] AC1 — `docs/harness/continue.md` includes the canonical YAML
      snippet:

  ```yaml
  name: genie
  version: 1.0.0
  schema: v1
  mcpServers:
    - name: genie
      type: streamable-http
      url: "https://genie.<operator-domain>/mcp"
      requestOptions:
        headers:
          Authorization: Bearer ${{ secrets.GENIE_TOKEN }}
  ```

- [ ] AC2 — Corrects the stale requirement: current Continue accepts optional
      `type`; the canonical snippets keep it explicit for readability.
- [ ] AC3 — Documents secret interpolation via Continue's
      `${{ secrets.NAME }}` syntax.
- [ ] AC4 — Warns MCP only works in agent mode (not chat / autocomplete).
- [ ] AC5 — Smoke test runs the four-verb chain through headless agent-mode
      `cn -p`; asserts its text output (no `ui://` rendering in that CLI surface).

## Implementation Notes

- File: `docs/harness/continue.md`,
  `packages/e2e/test/m5-smoke-continue.test.ts`.

## Out of Scope

- Continue's `prompt` / `model` configuration (orthogonal).

## Dependencies

- Blocks: M5 milestone close.
- Blocked by: M5-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
and explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done

- [ ] Tests added.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
