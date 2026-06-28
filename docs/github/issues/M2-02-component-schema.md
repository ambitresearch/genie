---
title: "[M2-02] Define COMPONENT_SCHEMA (JSON Schema for structured output)"
milestone: "M2 — LLM Generation Surface"
labels: ["type:feature", "area:llm", "priority:P0-critical", "size:M"]
assignees: []
estimate: "4h"
---

## Summary
Codify the JSON Schema that `conjure` will demand from the model
(via `response_format: { type: "json_schema", json_schema: COMPONENT_SCHEMA }`).
Schema must describe the file set the bundled `design-sync` skill expects
under `components/<group>/<Name>/`: `<Name>.jsx`, `<Name>.tsx`, `<Name>.d.ts`,
`<Name>.prompt.md`, `<Name>.html`, `meta.json`.

## Context
- Research report §3.2 outlines the call shape but leaves
  `COMPONENT_SCHEMA` to us. §3.3 documents the file layout — the schema is
  the machine-readable mirror.
- §2.2 confirmed regex `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/` — the
  schema must constrain the first line of `<Name>.html`.

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/llm/schema.ts` exports
      `COMPONENT_SCHEMA: JSONSchema7`.
- [ ] AC2 — Schema is Draft 7 only (no `anyOf` discriminator pattern, no
      `$ref` chains beyond a single level).
- [ ] AC3 — Top-level shape:
      `{ componentName: string, group: string, files: Array<{ path: string,
      content: string, mimeType: string }>, manifestEntry: ManifestEntry }`.
- [ ] AC4 — `path` constrained by pattern
      `^components/[a-z0-9-]+/[A-Z][A-Za-z0-9]+/[A-Za-z0-9._-]+$`.
- [ ] AC5 — At least one file in `files` must be a
      `<Name>.html` whose `content` begins with a string matching the
      `@genie` regex (validated post-hoc by M3-01, not by the schema).
- [ ] AC6 — `ManifestEntry` includes `viewport: { width: number, height:
      number }`, `subtitle?: string`, `tags?: string[]`.
- [ ] AC7 — Schema exported as both a TypeScript type (via `json-schema-to-ts`)
      and a JSON file for downstream consumers.

## Implementation Notes
- File: `packages/server/src/llm/schema.ts` + emitted
  `packages/server/dist/schemas/component.schema.json`.
- Keep nesting shallow — LiteLLM's structured-output passthrough to Anthropic
  via tool-use may not handle deep `$ref` chains.

## Out of Scope
- Vue / HTML frameworks (v1 = React only; framework switch in M2-08).

## Dependencies
- Blocks: M2-03, M2-04, M2-07.
- Blocked by: M2-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — schema validates a known-good fixture; rejects 3
      known-bad fixtures.
- [ ] Docs updated — `docs/04-tech-design-rfc.md` §3.2.
- [ ] Manual verification — `ajv validate` against fixtures.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
