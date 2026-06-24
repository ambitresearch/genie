---
title: "[M3-01] @dsCard first-line regex validator"
milestone: "M3 — @dsCard Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Port the regex `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/` from the bundled
DesignSync skill's `package-validate.mjs`. Apply it to the first line of every
`**/preview.html` and `**/<Name>.html` file. A missing or malformed marker
emits `[DSCARD_MISSING] <relpath>` and fails the build.

## Context
- Research report §2.2 confirmed claim: exact regex + `[DSCARD_MISSING]`
  error code + build failure via `process.exit(1)`.
- The regex permits arbitrary additional attributes after `group` (viewport,
  name, subtitle are explicitly named in the bundled skill comments).

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/validate/dscard.ts` exports
      `DSCARD_REGEX` and `validateDsCard(path, content)`.
- [ ] AC2 — Regex literal is exactly
      `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/` — character-for-character
      match with the bundled skill.
- [ ] AC3 — Tested against the bundled skill's own validation cases (5
      good, 5 bad).
- [ ] AC4 — Returns `{ ok: true } | { ok: false, code:
      "DSCARD_MISSING", path }`.
- [ ] AC5 — Optional attribute parsing: extract `viewport="WxH"` into a
      structured `{ width, height }` (W and H are integers).
- [ ] AC6 — Public re-export from `packages/server/src/validate/index.ts`.

## Implementation Notes
- File: `packages/server/src/validate/dscard.ts`.
- Use `txt.split('\n', 1)[0]` for the first-line slice (matches the skill's
  approach).
- DO NOT relax the regex even if it seems too strict — the round-trip into
  real Claude Design depends on byte-exact match.

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

**Primary mock:** [`ref-dscard.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/ref-dscard.svg) — the @dsCard marker the card detail depends on.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — 5 good, 5 bad fixtures; viewport extraction.
- [ ] Docs updated.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
