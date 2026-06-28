---
title: "[M2-07] Structured-output validation (Ajv strict mode)"
milestone: "M2 — LLM Generation Surface"
labels: ["type:feature", "area:llm", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Wrap every LLM completion with strict Ajv validation against
`COMPONENT_SCHEMA`. On failure, build a structured `SchemaValidationError`
with the failing path so M2-03 / M2-04 can retry once with the error
appended to the prompt.

## Context
- Research report §3.2 says "LiteLLM passes structured-output through to
  Anthropic via tool-use and to OpenAI via response_format natively" — but
  models still drift. Client-side validation is mandatory.

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/llm/validate.ts` exports
      `validateComponent(output: unknown): ValidatedComponent`.
- [ ] AC2 — Uses Ajv with `{ strict: true, allErrors: true }`.
- [ ] AC3 — On failure, throws `SchemaValidationError` with `errors:
      ErrorObject[]` attached.
- [ ] AC4 — Validates the `@genie` regex against the first line of any
      `<Name>.html` file in the output (cross-check vs M3-01 regex source).
- [ ] AC5 — Compiles the schema once at module load — not per call.
- [ ] AC6 — Test fixtures: 3 valid + 5 invalid (missing field, wrong type,
      bad path pattern, missing `@genie`, ManifestEntry without viewport).

## Implementation Notes
- File: `packages/server/src/llm/validate.ts`.
- Reuse the regex from M3-01's package so the two stay in sync.

## Out of Scope
- Auto-repair of malformed output (single retry only — repair is the model's
  job, not ours).

## Dependencies
- Blocks: M2-03 (retry path), M2-04.
- Blocked by: M2-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — fixtures.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
