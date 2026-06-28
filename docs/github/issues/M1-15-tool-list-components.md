---
title: "[M1-15] Tool: list_components"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "priority:P0-critical", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
Implement `list_components` MCP tool — one of genie's 13 kit/component core verbs.
Read-only enumeration of components within a kit, optionally filtered by
group. Backs every UI that needs to render a component picker, the manifest
compiler's seed list, and the harness smoke tests that assert "library X has
N components".

## Context
- D-A (`00-decisions.md`): `list_components` is a kept verb in genie's kit/component
  file protocol (the read/enumeration family, not the generation family).
- Research report §3.1 tool surface: `list_components({ kitId, group? }):
  { name, group, path, viewport, hash, lastModified }[]`.

## Acceptance Criteria
- [ ] AC1 — Tool name is `mcp__genie__list_components` (Claude
      rewrite rule applied).
- [ ] AC2 — Description ≤ 2 KB (Claude truncation limit).
- [ ] AC3 — JSON Schema is Draft 7 only — no `anyOf` / `$ref` chains.
- [ ] AC4 — Input: `{ kitId: string, group?: string }`. When `group` is
      omitted, returns every component across all groups.
- [ ] AC5 — Returns an array of
      `{ name: string, group: string, path: string, viewport: string,
      hash: string, lastModified: string (ISO 8601) }`.
- [ ] AC6 — **Deterministic ordering**: results sorted by `group` ASC, then
      `name` ASC; ties broken by `path`.
- [ ] AC7 — Respects the 256-result pagination cap shared with `list_files` /
      `list_kits`; cursor returned in `_meta.nextCursor` when truncated.
- [ ] AC8 — Returns `[]` (not `null`, not error) when the project has no
      components or the `group` filter matches nothing.
- [ ] AC9 — Backed by `KitStore.listComponents({ kitId, group })`
      (shared abstraction; both LocalFsStore and GitHostStore implement).
- [ ] AC10 — Integration test loads a 50-component fixture spanning 5 groups
      and asserts: total count, group-filtered count, deterministic
      ordering, and pagination cursor round-trip.

## Implementation Notes
- File: `packages/server/src/tools/list_components.ts`.
- Register in `packages/server/src/tools/index.ts`.
- Description template from research report §3.1 — copy verbatim where ≤ 2 KB.
- `hash` is the SHA-256 of the preview HTML; sourced from the same manifest
  pipeline M3-03 (`.genie/manifest.json`) feeds.
- `viewport` mirrors the value the @genie regex captures from the first-line
  marker (M3-01).

## Out of Scope
- Search/full-text filter (v1 client-side only — UI can grep the returned
  array).
- Component metadata beyond the 6-field shape (revisit in v2 if a harness
  needs renderer hints or asset deps).

## Dependencies
- Blocks: M3-03 (manifest compiler reuses the same ordering) ·
  M4-03 (iframe grid renderer reads this for its source list).
- Blocked by: M1-01 (storage abstraction), M1-02 (shared schema patterns).

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`01-ui-kit-browser.svg`](https://github.com/roshangautam/genie/blob/main/docs/designs/design-6/01-ui-kit-browser.svg) — response feeds the browser grouping.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — unit (mocked store) + integration (50-component fixture
      asserting count, group filter, ordering, pagination cursor).
- [ ] Docs updated — `docs/plan/04-tech-design-rfc.md` §3.1 tool list and §6.2
      genie verb enumeration both include `list_components`.
- [ ] Manual verification — call from `npx @modelcontextprotocol/inspector`
      against a fixture project; verify ordering + pagination.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
