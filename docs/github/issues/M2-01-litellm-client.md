---
title: "[M2-01] LiteLLM OpenAI client wrapper"
milestone: "M2 — LiteLLM Generation Surface"
labels: ["type:feature", "area:litellm", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Add an `openai` SDK client pointed at the LiteLLM gateway
(`https://litellm.roshangautam.com`), wire it up with `LITELLM_BASE_URL` /
`LITELLM_MASTER_KEY` env vars, and ship a thin `llm.ts` module that exposes
`createChatCompletion(input)` with retry/backoff. All future generation
verbs call through this module.

## Context
- Research report §3.2 reference implementation:
  ```ts
  import OpenAI from "openai";
  const client = new OpenAI({
    baseURL: process.env.LITELLM_BASE_URL!,
    apiKey:  process.env.LITELLM_MASTER_KEY!,
  });
  ```
- CLAUDE.md homelab context: master key already lives in
  `~/.shellprivatevars` as `ANTHROPIC_AUTH_TOKEN` (re-used here as the
  LiteLLM master key).

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/llm/client.ts` exports a singleton
      `llmClient` constructed from env vars.
- [ ] AC2 — Missing `LITELLM_BASE_URL` or `LITELLM_MASTER_KEY` ⇒ fail fast at
      startup with `MissingLLMConfigError`.
- [ ] AC3 — Default base URL falls back to
      `https://litellm.roshangautam.com` if env is unset (homelab default).
- [ ] AC4 — `createChatCompletion(input)` wraps `client.chat.completions.create`
      with structured logging (`{ model, promptTokens, completionTokens,
      latencyMs }`).
- [ ] AC5 — Reads `LITELLM_REQUEST_TIMEOUT_MS` (default 120 000).
- [ ] AC6 — Test against a stub server confirms request shape (`model`,
      `messages`, `response_format`, `Authorization` header).

## Implementation Notes
- File: `packages/server/src/llm/client.ts`.
- `openai` v4+ supports `baseURL` override natively.
- Do NOT hardcode the master key — read from env at construction time.

## Out of Scope
- Retry/backoff (M2-06).
- Structured-output schema validation (M2-07).
- Per-tool generation logic (M2-03, M2-04).

## Dependencies
- Blocks: M2-03, M2-04.
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — stub server, config-missing path.
- [ ] Docs updated — README env-var section.
- [ ] Manual verification — `pnpm dev` boots, real chat completion succeeds.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
