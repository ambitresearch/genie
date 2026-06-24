---
title: "[M5-02] Static Bearer token fallback (VS Code, Cline, Continue)"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:security", "area:mcp-server", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Accept `Authorization: Bearer <token>` headers in addition to OAuth — covers
the three harnesses (VS Code Copilot, Cline, Continue.dev) that don't
implement DCR. Tokens are static, scoped to the user's projects, and
issued via the admin CLI.

## Context
- Research report §3.2 auth table: "Static `Authorization: Bearer <token>`
  via per-harness header — VS Code, Cline, Continue (simplest)".

## Acceptance Criteria
- [ ] AC1 — Server accepts `Authorization: Bearer <token>` on every
      MCP-over-HTTP request.
- [ ] AC2 — Token format: `dsc_<32-char-base32>` (matches GitHub PAT
      pattern).
- [ ] AC3 — Tokens stored hashed (SHA-256) in
      `${GENIE_HOME}/auth/tokens.json`.
- [ ] AC4 — Token claims: `{ sub: <userId>, scopes: ["read", "write"],
      createdAt, lastUsedAt }`.
- [ ] AC5 — Admin CLI: `genie token create [--scope read]
      [--scope write]` prints the plaintext token once, never again.
- [ ] AC6 — Admin CLI: `genie token list` shows hashed
      tokens with metadata.
- [ ] AC7 — Admin CLI: `genie token revoke <prefix>`
      invalidates a token.

## Implementation Notes
- File: `packages/server/src/auth/bearer.ts` + `packages/server/src/cli/token.ts`.
- Token check is constant-time (`crypto.timingSafeEqual`).

## Out of Scope
- Per-project ACLs (v1 = all-or-nothing).

## Dependencies
- Blocks: M5-10 (Claude Desktop smoke), M5-12, M5-14, M5-15.
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — create / list / revoke; auth-required endpoint with
      missing / invalid / valid token.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
