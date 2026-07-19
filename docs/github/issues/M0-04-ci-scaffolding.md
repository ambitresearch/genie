---
title: "[M0-04] CI scaffolding (GitHub Actions: lint, typecheck, test, build matrix)"
milestone: "M0 — Discovery & Scaffold"
labels: ["type:infra", "area:ci", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Ship `.github/workflows/ci.yml` that runs lint + typecheck + unit tests on
every PR across Node 22/24 on Ubuntu/macOS. Add `release-please` (or
Changesets) to manage versioning automatically. Reserve the npm package name
`genie`.

## Context
- INDEX.md: distribution = npm + `.mcpb` + Docker.
- Research report §7 step 11 needs a smoke-test workflow; this issue stops
  short of that — we only ship plumbing.

## Acceptance Criteria
- [ ] AC1 — `.github/workflows/ci.yml` runs on `push` + `pull_request`, jobs:
      `lint`, `typecheck`, `test`, `build` — matrix `{ node: [22, 24], os:
      [ubuntu-latest, macos-latest] }`.
- [ ] AC2 — Cache `~/.pnpm-store` keyed on `pnpm-lock.yaml`.
- [ ] AC3 — Build job produces `packages/server/dist/` and uploads as an
      artefact named `server-dist-${{ matrix.node }}-${{ matrix.os }}`.
- [ ] AC4 — `release-please` (or Changesets) PR is opened by the bot whenever
      Conventional Commits land on `main`.
- [ ] AC5 — npm name `genie` is registered (publish empty
      0.0.0-placeholder). **Reconciled after registry verification:** bare `genie`
      and the `@genie` scope belong to unrelated npm users, so publish the server
      as `@ambitresearch/genie` and the viewer as `@ambitresearch/genie-viewer`.
      Record the chosen names in `CLAUDE.md` and reconcile docs that assumed the
      unavailable names.
- [ ] AC6 — Branch protection requires `lint`, `typecheck`, `test`, `build`
      checks before merge.

## Implementation Notes
- Use `pnpm/action-setup@v3` for pnpm install.
- Run `pnpm exec vitest run --reporter=verbose --coverage`.
- Coverage gates are deferred to M6 — for now just publish the report as an
  artefact.

## Out of Scope
- E2E harness tests (M5).
- Docker / `.mcpb` publish (M5).

## Dependencies
- Blocks: every PR that needs CI green.
- Blocked by: M0-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — verify by opening a no-op PR and watching CI.
- [ ] Docs updated — CONTRIBUTING references CI status.
- [ ] Manual verification — green CI on M0-03 follow-up PR.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
