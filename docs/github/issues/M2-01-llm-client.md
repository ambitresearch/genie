---
title: "[M2-01] LLM client wrapper (OpenAI-compatible endpoint)"
milestone: "M2 — LLM Generation Surface"
labels: ["type:feature", "area:llm", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Add an `openai` SDK client pointed at an operator-configured OpenAI-compatible
endpoint, wire it up with `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` env vars,
and ship a thin `llm.ts` module that exposes `createChatCompletion(input)` with
retry/backoff. All future generation verbs call through this module. LiteLLM is
the reference gateway, but Ollama / OpenAI / vLLM / any compatible endpoint work
the same way (D-H) — no provider URL baked in.

## Context
- D-H (`00-decisions.md`): genie calls a **configurable OpenAI-compatible
  chat-completions endpoint**; the operator owns the model, budget, and rate
  limits. No private URL or IP in the code or docs.
- Reference implementation:
  ```ts
  import OpenAI from "openai";
  const client = new OpenAI({
    baseURL: process.env.GENIE_LLM_BASE_URL!,
    apiKey:  process.env.GENIE_LLM_API_KEY!,
  });
  ```

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/llm/client.ts` exports a singleton
      `llmClient` constructed from env vars.
- [ ] AC2 — Missing `GENIE_LLM_BASE_URL` or `GENIE_LLM_API_KEY` ⇒ fail fast at
      startup with `MissingLLMConfigError`.
- [ ] AC3 — No hardcoded default base URL — the operator MUST set it (there is
      no universal default endpoint). The error message names both env vars.
- [ ] AC4 — `createChatCompletion(input)` wraps `client.chat.completions.create`
      with structured logging (`{ model, promptTokens, completionTokens,
      latencyMs }`).
- [ ] AC5 — Reads `GENIE_LLM_REQUEST_TIMEOUT_MS` (default 120 000).
- [ ] AC6 — Test against a stub server confirms request shape (`model`,
      `messages`, `response_format`, `Authorization` header).

## Implementation Notes
- File: `packages/server/src/llm/client.ts`.
- `openai` v4+ supports `baseURL` override natively.
- Do NOT hardcode the API key or URL — read both from env at construction time.

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
