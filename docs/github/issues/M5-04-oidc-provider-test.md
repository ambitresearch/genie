---
title: "[M5-04] OIDC provider integration test"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:security", "type:test", "area:mcp-server", "priority:P1-high", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Integration test that runs the OAuth flow against a real OIDC provider.
Confirms the OIDC handshake, scope mapping, and group-based access works
end-to-end. Acts as the template for adopters who bring their own provider.

## Context
- Research report §3.2: "OIDC against your IdP; OAuth DCR for Claude
  Code/Codex".

## Acceptance Criteria
- [ ] AC1 — File `packages/e2e/test/m5-oidc.test.ts`.
- [ ] AC2 — Spins up an ephemeral OIDC provider via testcontainers.
- [ ] AC3 — Bootstraps an OAuth2/OpenID Provider with client_id
      `genie-test`.
- [ ] AC4 — Headless browser (Playwright) performs the auth code + PKCE
      flow.
- [ ] AC5 — Asserts the issued bearer token authenticates a call to
      `mcp__genie__list_kits`.
- [ ] AC6 — Asserts users not in the `genie-users` group are rejected
      with HTTP 403.
- [ ] AC7 — Runs in < 3 min on GitHub Actions (Linux runner).

## Implementation Notes
- File: `packages/e2e/test/m5-oidc.test.ts`.
- Container fixtures cached between runs to keep CI under the 6-hour cap.

## Out of Scope
- Other OIDC provider parity; this issue proves one concrete provider path.

## Dependencies
- Blocks: M6-03 (security audit can reuse this harness).
- Blocked by: M5-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — the suite.
- [ ] Docs updated — `docs/06-operations-runbook.md` OIDC section.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
