---
title: "[M5-03] Env-var secret handling (no plaintext at rest)"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:security", "area:mcp-server", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Every secret the server uses (`GENIE_LLM_API_KEY`, `OAUTH_HS256_KEY`,
`GENIE_GIT_TOKEN`, `OAUTH_CLIENT_SECRET`) is read only from env or from a
mounted secret file. The server refuses to start if a
required secret is logged anywhere, present in argv, or readable by other
local users.

## Context
- Secrets live in env or mounted secret files, never in the repo.

## Acceptance Criteria
- [ ] AC1 — `packages/server/src/config/secrets.ts` exports `loadSecrets()`
      that reads from env only.
- [ ] AC2 — Bootstrap rejects: any required secret missing; any required
      secret < 16 chars; any required secret present in `process.argv`.
- [ ] AC3 — A startup audit logs which secrets are loaded (their key names
      only, never the values).
- [ ] AC4 — Logger redacts any value matching a configured secret pattern
      from log output (`****`).
- [ ] AC5 — `.env.example` lists every supported var with a comment.
- [ ] AC6 — Optional `--secrets-from <path>` arg lets containers read from
      a mounted file (e.g. Docker secret).

## Implementation Notes
- File: `packages/server/src/config/{secrets,redact}.ts`.
- Use `pino`'s redact option for the logger.

## Out of Scope
- Vault / Doppler integration (v2).

## Dependencies
- Blocks: nothing (parallel work).
- Blocked by: M5-01, M5-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — missing / short / argv-leaked secret cases.
- [ ] Docs updated.
- [ ] Manual verification — `pnpm dev` rejects with clear error when
      `GENIE_LLM_API_KEY` unset.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
