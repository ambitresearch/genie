---
title: "[M2-08] Multi-framework adapter (React first, Vue/HTML stubbed)"
milestone: "M2 — LiteLLM Generation Surface"
labels: ["type:feature", "area:litellm", "priority:P2-medium", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Abstract the framework-specific bits of `generate_component` into a small
adapter interface so React lands in v1 and Vue / vanilla HTML can be added
without refactoring the generation pipeline. Crib the staged IR pattern from
`Kinglions/ui-design-to-code-mcp` (research §5 prior art #3).

## Context
- Research report §3.1: `framework?: "react" | "vue" | "html"`.
- §5 prior art: "Take: the IR pipeline architecture — `ingest_*` →
  `build_semantic_ir` → `build_cross_platform_nodes` → `build_target_ir` →
  `run_codegen` → `validate_pipeline`."

## Acceptance Criteria
- [ ] AC1 — `interface FrameworkAdapter` defines `renderSource`,
      `renderPreview`, `extractDts`, `defaultViewport`.
- [ ] AC2 — `ReactAdapter` implemented; defaults to `.tsx` + JSX preview
      bundle + `ts-morph`-extracted `.d.ts`.
- [ ] AC3 — `VueAdapter` and `HtmlAdapter` ship as stubs that return a
      structured `NotYetImplementedError` with a link to the tracking issue
      (v2 milestone).
- [ ] AC4 — `generate_component` picks the adapter based on the `framework`
      input.
- [ ] AC5 — Adapter contract is independently testable
      (`adapter-conformance.test.ts`).

## Implementation Notes
- File: `packages/server/src/framework/{interface.ts,react.ts,vue.ts,html.ts}`.
- React adapter uses `esbuild` to bundle the preview to an IIFE.

## Out of Scope
- Full Vue / HTML implementations (v2).

## Dependencies
- Blocks: nothing.
- Blocked by: M2-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — React adapter happy path + Vue/HTML stub errors.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
