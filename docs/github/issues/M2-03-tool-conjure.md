---
title: "[M2-03] Tool: conjure"
milestone: "M2 — LLM Generation Surface"
labels: ["type:feature", "area:mcp-tools", "area:llm", "priority:P0-critical", "size:L"]
assignees: []
estimate: "12h"
---

## Summary
Implement `conjure` — genie's headline verb. Takes a natural-
language prompt + optional reference image/URL, returns the file set defined
by `COMPONENT_SCHEMA`. genie's take on canvas-side generation lives here.

## Context
- Research report §3.1: `conjure({ kitId, kit, prompt, group?,
  refImageDataUrl?, refUrl?, framework?: "react" | "vue" | "html", model?:
  "anthropic/claude-sonnet-4-6" | ... }): { componentName, files: { path,
  content }[], manifestEntry }`.
- §6 honest uncertainty: "The canvas-side generation loop … prompt shape,
  per-element artifact format, tool catalog, inline-comment edit round-trip
  protocol — is not documented anywhere public. Anthropic publishes no spec.
  This is the real R&D cost."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__conjure`.
- [ ] AC2 — Input: `{ kitId: string, kit: string, prompt: string, group?:
      string, refImageDataUrl?: string, refUrl?: string, framework?:
      "react" | "vue" | "html", model?: string }`.
- [ ] AC3 — Default `framework` = `"react"`; default `model` =
      `"design-default"` (resolved by the configured endpoint or gateway).
- [ ] AC4 — Calls `llmClient.createChatCompletion` with `response_format:
      { type: "json_schema", json_schema: COMPONENT_SCHEMA }` (M2-02).
- [ ] AC5 — System prompt lives in
      `packages/server/src/llm/prompts/generate-component.system.md` and is
      versioned (commit hash logged on every call).
- [ ] AC6 — If `refImageDataUrl` is set, attach as a
      vision input (`messages[0].content = [{type: "image", ...}]`).
- [ ] AC7 — If `refUrl` is set, fetch + inline (warn if > 1 MB).
- [ ] AC8 — Output validated against `COMPONENT_SCHEMA`; on failure, retry
      once with the validation error appended to the user prompt.
- [ ] AC9 — Returns `{ componentName, files, manifestEntry }`. Does NOT call
      `write_files` itself — that's the caller's job (keeps generation pure).
- [ ] AC10 — Logs `{ model, promptTokens, completionTokens, latencyMs,
      componentName }` per call.

## Implementation Notes
- File: `packages/server/src/tools/conjure.ts`.
- System prompt v1: take from
  `https://github.com/anthropics/skills/tree/main/canvas-design` if licence
  allows; otherwise hand-author.
- 80 % of the engineering effort here is in iterating on the system prompt.
  Track edits in `prompts/CHANGELOG.md`.

## Out of Scope
- Refinement / inline-comment edits (M2-04).
- Storybook-format output (deferred to v2).

## Dependencies
- Blocks: M2-09, M5 smoke tests.
- Blocked by: M2-01, M2-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`00-front-door.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/00-front-door.svg) — the GENERATE moment — accent applies here.

**Supporting:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg).

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — unit (stub LLM) + integration (real LLM endpoint with $5 cap).
- [ ] Docs updated.
- [ ] Manual verification — generate "primary button" against design-default.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
