---
title: "[M4-07] Sandboxed iframe + CSP hardening for ui:// payload"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:security", "area:mcp-ui", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Lock down the `ui://genie/grid` payload: strict CSP, iframes get
`sandbox="allow-scripts"` only (no `allow-same-origin`), no inline
`onclick`, hash-only `<script>` blocks, deny `<form>`, `<object>`,
`<embed>`. Ensures hostile component HTML can't escalate inside the host's
sandbox.

## Context
- Research report §3.4: "served from a separate origin … `<iframe sandbox>`
  + strict CSP. Lost: nothing. Browser sandbox + cross-origin already does
  this."

## Acceptance Criteria
- [ ] AC1 — CSP header on the resource: `default-src 'none'; script-src
      'sha256-…'; style-src 'self'; img-src 'self' data:; frame-src
      previews.${DOMAIN};`.
- [ ] AC2 — Every inline `<script>` has its SHA-256 hash listed in CSP.
- [ ] AC3 — No `unsafe-inline`, no `unsafe-eval` anywhere.
- [ ] AC4 — Test: inject `<img src=x onerror=alert(1)>` into a preview;
      assert the alert never fires (blocked by `script-src 'self'`).
- [ ] AC5 — Test: try to navigate the parent (`top.location = …`) from
      inside an iframe; assert blocked by sandbox.
- [ ] AC6 — Documented threat model in `docs/04-tech-design-rfc.md`.

## Implementation Notes
- File: `packages/server/src/ui/csp.ts` — compute CSP at build time.
- Use `parse5` to sanitise inputs if any user-controlled HTML lands in the
  outer shell (manifest values).

## Out of Scope
- Trusted Types (browser-only; nice-to-have for v2).

## Dependencies
- Blocks: M4-10.
- Blocked by: M4-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`03-embedded-modes.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/03-embedded-modes.svg) — hardened payload renders identically (G-5 byte-identical).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — XSS injection + sandbox escape attempts.
- [ ] Docs updated.
- [ ] Manual verification — observe blocked attempts in browser console.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
