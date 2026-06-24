---
title: "[M3-06] _ds_sync.json schema + writer (reconstructed from sync-hashes.mjs)"
milestone: "M3 — @dsCard Validator + Manifest"
labels: ["type:feature", "area:mcp-server", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Define and emit `_ds_sync.json` — the verification anchor written **last** by
the atomic sync orchestrator. Schema reconstructed from `lib/remote-diff.mjs`
and `lib/sync-hashes.mjs` in the bundled skill (research §3.3 + open
question 7).

## Context
- Research report §3.3 reconstructed schema:
  ```json
  { "version": 1, "writtenAt": "...", "by": "genie",
    "sourceHashes": { "components/.../X.tsx": "sha256-..." },
    "renderHashes":  { "components/.../X.html": "sha256-..." },
    "verified": ["actions/Button", "surfaces/Card"] }
  ```
- INDEX.md uncertainty 2: "`_ds_sync.json` schema reconstructed from
  `lib/sync-hashes.mjs`, not from a public spec."

## Acceptance Criteria
- [ ] AC1 — File `packages/server/src/sync/anchor.ts` exports
      `writeAnchor(projectRoot, planResult): void` and
      `readAnchor(projectRoot): Anchor | null`.
- [ ] AC2 — Schema matches research report §3.3 exactly; TypeScript type
      `Anchor` exported alongside.
- [ ] AC3 — `sourceHashes` covers every `.tsx`/`.jsx` source file touched by
      the plan.
- [ ] AC4 — `renderHashes` covers every `.html` preview file touched.
- [ ] AC5 — `verified` lists `<group>/<Name>` IDs for every component that
      passed the M3-04 validator within this sync.
- [ ] AC6 — `by` is always `"genie"` (configurable for forks via
      env `GENIE_BY`).
- [ ] AC7 — Atomic write: temp file + rename.
- [ ] AC8 — `readAnchor` returns `null` (not throw) when the file is
      missing.

## Implementation Notes
- File: `packages/server/src/sync/anchor.ts`.
- Honest note in code header that the schema is reconstructed, not
  primary-source.

## Out of Scope
- Server-side adherence-config regeneration (out of scope; that's a Claude
  Design–internal artefact we don't need to mirror exactly).

## Dependencies
- Blocks: M3-05 step 5.
- Blocked by: M3-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (reference context). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`01-ds-browser.svg`](https://github.com/roshangautam/genie/blob/main/docs/design/01-ds-browser.svg) — the ✓ synced status the browser shows.

**Use the mock for:** correct output shape + the **identity rule** (clay/gilt accent ONLY on generate/refine; structure stays ink/neutral). See [`MOCK-MAP.md`](../MOCK-MAP.md).

## Definition of Done
- [ ] Tests added — write + round-trip read; missing file returns null.
- [ ] Docs updated — schema documented in `docs/04-tech-design-rfc.md`.
- [ ] Manual verification.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
