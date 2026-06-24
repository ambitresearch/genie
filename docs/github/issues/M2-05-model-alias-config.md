---
title: "[M2-05] LiteLLM model alias config (design-default, design-best, design-local)"
milestone: "M2 — LiteLLM Generation Surface"
labels: ["type:infra", "area:litellm", "priority:P1-high", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Ship the LiteLLM `model_list` config that the homelab gateway loads, and
document it in the repo so contributors can reproduce it. Aliases:
`design-default` → `anthropic/claude-sonnet-4-6`, `design-best` →
`anthropic/claude-opus-4-8`, `design-local` → `ollama/qwen3-coder:32b`.

## Context
- Research report §3.2 example YAML:
  ```yaml
  model_list:
    - model_name: design-default
      litellm_params: { model: anthropic/claude-sonnet-4-6, api_key: ... }
    - model_name: design-best
      litellm_params: { model: anthropic/claude-opus-4-8, ... }
    - model_name: design-local
      litellm_params: { model: ollama/qwen3-coder:32b, api_base: ... }
  ```
- CLAUDE.md: LiteLLM runs on TrueNAS, config at `/etc/litellm/config.yaml`.

## Acceptance Criteria
- [ ] AC0 — Confirm current LiteLLM model catalog via
      <https://litellm.roshangautam.com/v1/models> before configuring aliases
      (placeholder model IDs below — `claude-opus-4-8`, `qwen3-coder:32b` —
      must match real catalog entries; substitute the actual current names).
- [ ] AC1 — File `deploy/litellm/config.yaml` checked into the repo.
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
- Provisioning LiteLLM itself (it's already running per CLAUDE.md).

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
- [ ] Docs updated — `docs/06-operations-runbook.md`.
- [ ] Manual verification — restart LiteLLM, hit `/v1/models`, see 3 aliases.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
