---
title: "[M3-01] @genie first-line regex validator"
milestone: "M3 — @genie Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement genie's own first-line marker validator with the regex
`/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`. Apply it to the first line of every
`**/preview.html` and `**/<Name>.html` file. A missing or malformed marker
emits `[MARKER_MISSING] <relpath>` and fails the build.

## Context
- D-B (`00-decisions.md`): `@genie` is genie's **native** marker. The validator
  tests the `@genie` regex; the Anthropic `@dsCard` regex lives only in the
  future interop adapter.
- The regex permits arbitrary additional attributes after `group` (viewport,
  name, subtitle).

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/validate/marker.ts` exports
      `MARKER_REGEX` and `validateMarker(path, content)`.
- [ ] AC2 — Regex literal is exactly
      `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`.
- [ ] AC3 — Tested against genie's own validation fixtures (≥ 5 good, 5 bad).
- [ ] AC4 — Returns `{ ok: true } | { ok: false, code:
      "MARKER_MISSING", path }`.
- [ ] AC5 — Optional attribute parsing: extract `viewport="WxH"` into a
      structured `{ width, height }` (W and H are integers).
- [ ] AC6 — Public re-export from `packages/server/src/validate/index.ts`.

## Implementation Notes
- File: `packages/server/src/validate/marker.ts`.
- Use `txt.split('\n', 1)[0]` for the first-line slice.
- Keep the regex strict and stable — it is genie's registration contract.

## Out of Scope
- Watching files (M3-02).
- Compiling the manifest (M3-03).

## Dependencies
- Blocks: M2-07, M3-03, M3-04.
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`ref-genie-card.svg`](https://github.com/ambitresearch/genie/blob/main/docs/designs/design-6/ref-genie-card.svg) — the @genie marker the card detail depends on.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — 5 good, 5 bad fixtures; viewport extraction.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
