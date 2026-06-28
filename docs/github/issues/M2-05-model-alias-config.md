---
title: "[M2-05] Model alias config (reference: LiteLLM model_list)"
milestone: "M2 — LLM Generation Surface"
labels: ["type:infra", "area:llm", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Ship a reference `model_list` config (LiteLLM-style — the reference gateway)
and document it so operators can reproduce or adapt it to their own
OpenAI-compatible endpoint (D-H). Aliases the generation verbs use:
`design-default` → a Sonnet-class model, `design-best` → an Opus-class model,
`design-local` → a local model (e.g. Ollama Qwen). Operators map these aliases
to whatever their endpoint serves.

## Context
- D-H (`00-decisions.md`): the LLM endpoint is configurable; LiteLLM is the
  reference but not required. Aliases are operator-mapped, not hardcoded.
- Reference YAML (LiteLLM example):
  ```yaml
  model_list:
    - model_name: design-default
      litellm_params: { model: anthropic/claude-sonnet-4-6, api_key: ... }
    - model_name: design-best
      litellm_params: { model: anthropic/claude-opus-4-8, ... }
    - model_name: design-local
      litellm_params: { model: ollama/qwen3-coder:32b, api_base: ... }
  ```

## Acceptance Criteria
- [ ] AC0 — Confirm the operator's actual model catalog (via the endpoint's
      `/v1/models`) before configuring aliases — placeholder model IDs below
      (`claude-opus-4-8`, `qwen3-coder:32b`) must match real catalog entries;
      substitute the actual current names.
- [ ] AC1 — File `deploy/litellm/config.yaml` checked into the repo as the
      reference example (operators adapt it to their endpoint).
- [ ] AC2 — Three aliases defined; passthrough secret refs use
      `os.environ/ANTHROPIC_API_KEY` and `os.environ/OLLAMA_API_BASE`.
- [ ] AC3 — Per-key budget block: each MCP-server caller gets 50 USD / month
      hard cap (configurable per-deployment).
- [ ] AC4 — Per-key rate limit: 20 RPM, 200 KTPM (matches
      `claude-sonnet-4-6` tier defaults).
- [ ] AC5 — Docs include the `litellm proxy --config
      deploy/litellm/config.yaml` reload command.

## Implementation Notes
- Path: `deploy/litellm/config.yaml`.
- Reference: <https://docs.litellm.ai/docs/proxy/users>.

## Out of Scope
- Provisioning a gateway itself; this issue only ships the reference alias config.

## Dependencies
- Blocks: nothing.
- Blocked by: M2-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A (config file).
- [ ] Docs updated — `docs/plan/06-operations-runbook.md`.
- [ ] Manual verification — restart LiteLLM, hit `/v1/models`, see 3 aliases.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
