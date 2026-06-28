---
title: "[M3-03] .genie/manifest.json writer (client-side compiler)"
milestone: "M3 — @genie Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Recompile `<projectRoot>/.genie/manifest.json` whenever the watcher fires. Walks
`components/**/*.html`, extracts the `@genie` markers, joins with
`meta.json` siblings, emits a manifest matching the schema in research
report §3.4. This is the "20-line Node script that watches `**/preview.html`
→ first-line regex → write `.genie/manifest.json`" called out as a substitute for
Anthropic's server-side manifest compilation.

## Context
- Research report §6 substitute: "Server-side `.genie/manifest.json` self-check
  → Vite plugin or 20-line Node script that watches `**/preview.html` →
  first-line regex → write `.genie/manifest.json`".
- §3.4 manifest schema documented in the report.

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/manifest/compiler.ts` exports
      `compileManifest(projectRoot): Manifest`.
- [ ] AC2 — Walks `${projectRoot}/components/**/*.html`; reads first line of
      each; extracts group + viewport via the M3-01 helper.
- [ ] AC3 — Joins each card with sibling `meta.json` (if present) for tags,
      subtitle, etc.
- [ ] AC4 — Output schema matches research report §3.4 exactly: `{ version:
      1, name, generatedAt, groups: [], cards: [{ id, name, subtitle, group,
      path, viewport, tags, hash, lastModified }] }`.
- [ ] AC5 — Hashes are SHA-256 of the HTML file bytes (matches M1-04's
      `list_files` hash format).
- [ ] AC6 — Atomic write: write to `.genie/manifest.json.tmp`, fsync, rename.
- [ ] AC7 — Compiles in < 100 ms for a 50-component kit on a 2025 laptop.

## Implementation Notes
- File: `packages/server/src/manifest/compiler.ts`.
- Group order: alphabetical unless a `_groups.json` sibling pins it.
- Per-card sort: alphabetical by `name`.

## Out of Scope
- Inlining manifest into `index.html` for sandboxed iframe (M4-05).
- Server-side regeneration (we're explicitly the client-side substitute).

## Dependencies
- Blocks: M4-05, M4-06.
- Blocked by: M3-01, M3-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`01-ui-kit-browser.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/01-ui-kit-browser.svg) — cards group correctly in the grid.

**Supporting:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/02-preview-refine.svg).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — small/empty/large kits; viewport extraction; hash
      stability.
- [ ] Docs updated.
- [ ] Manual verification — compile against `packages/server/test/fixtures/`.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
