---
title: "[M2-06] Retry/backoff for LiteLLM calls (exponential, jittered)"
milestone: "M2 — LiteLLM Generation Surface"
labels: ["type:feature", "area:litellm", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Add retry/backoff middleware around `llmClient.createChatCompletion` for
transient failures (429 rate limit, 502/503/504, network ECONNRESET).
Exponential backoff with jitter, max 3 retries, surface a typed
`RateLimitedError` so callers can react.

## Context
- LiteLLM passes through Anthropic's 429 with `Retry-After` headers; the
  client must honour them.

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/llm/retry.ts` exports
      `withRetry(handler, opts)`.
- [ ] AC2 — Retries on: HTTP 429, 5xx, network errors (`ECONNRESET`,
      `ETIMEDOUT`). Does NOT retry on: 4xx (other), schema validation fails.
- [ ] AC3 — Honours `Retry-After` header when present.
- [ ] AC4 — Backoff: base 1 s, cap 30 s, jitter ±20 %.
- [ ] AC5 — Max 3 retries total (configurable via
      `LITELLM_RETRY_MAX`).
- [ ] AC6 — On exhaustion, throws typed `RateLimitedError | TransientError`.
- [ ] AC7 — Each attempt logged with `{ attempt, status, retryAfter }`.

## Implementation Notes
- File: `packages/server/src/llm/retry.ts`.
- `M2-01`'s `createChatCompletion` is wrapped: `withRetry(createChatCompletion)`.

## Out of Scope
- Circuit breaker (out of scope for v1).
- Cross-model fallback (use `design-best` if `design-default` fails) — defer
  to v2.

## Dependencies
- Blocks: nothing critical.
- Blocked by: M2-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — 429 with Retry-After, transient 5xx, ECONNRESET,
      exhausted retries.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
