---
title: "[M5-08] Smithery + mcpb.dev listings"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:docs", "area:docs", "priority:P2-medium", "size:S"]
assignees: []
estimate: "3h"
---

## Summary
List the server on Smithery and mcpb.dev so users can install via their
one-click flows. Ship `smithery.yaml` per the Smithery spec.

## Context
- Research report §5 prior art `21st-dev/magic-mcp` confirmed: ships
  `smithery.yaml` and `llms-install.md`.

## Acceptance Criteria
- [ ] AC1 — `smithery.yaml` at repo root: `startCommand: { type: "stdio",
      configSchema: <env vars>, commandFunction: "..." }`.
- [ ] AC2 — Listing submitted to Smithery and approved (URL in
      README badges).
- [ ] AC3 — Listing submitted to mcpb.dev and approved (URL in README
      badges).
- [ ] AC4 — `llms-install.md` documents the install steps in
      LLM-readable format (per `21st-dev/magic-mcp` convention).
- [ ] AC5 — Both listings link back to the GitHub repo + npm package.

## Implementation Notes
- File: `smithery.yaml`, `llms-install.md`.

## Out of Scope
- Other registries (v2).

## Dependencies
- Blocks: nothing critical.
- Blocked by: M5-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A.
- [ ] Docs updated.
- [ ] Manual verification — listings live, install via Smithery one-click
      works.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
