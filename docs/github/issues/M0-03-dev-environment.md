---
title: "[M0-03] Bootstrap TypeScript dev environment (Node ≥22, ESM, pnpm)"
milestone: "M0 — Discovery & Scaffold"
labels: ["type:infra", "area:ci", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Stand up the TypeScript build pipeline: `package.json`, `tsconfig.json`
(strict, ESM), `pnpm-workspace.yaml` (server + viewer + e2e), `.editorconfig`,
`.prettierrc`, `.eslintrc.cjs` with `@typescript-eslint`, Vitest config, and a
`scripts/` directory with `dev`, `build`, `test`, `lint`, `typecheck`. After
this, a contributor can clone, `pnpm i`, and run `pnpm dev` to get an empty
MCP server on stdio.

## Context
- INDEX.md: "Primary language: TypeScript (Node ≥ 22, ESM)".
- Research report §7 step 1: "Scaffold MCP server — npm init, add
  @modelcontextprotocol/sdk, fork GLips/Figma-Context-MCP for transport/CLI
  scaffolding".

## Acceptance Criteria
- [ ] AC1 — `pnpm i` on a fresh clone succeeds on Node 22 and 24.
- [ ] AC2 — `tsconfig.json` has `"module": "NodeNext"`, `"strict": true`,
      `"target": "ES2022"`, `"moduleResolution": "NodeNext"`.
- [ ] AC3 — `pnpm-workspace.yaml` lists `packages/server`, `packages/viewer`,
      `packages/e2e`.
- [ ] AC4 — `pnpm dev` boots the empty MCP server on stdio without crashing.
- [ ] AC5 — `pnpm test` runs Vitest against a placeholder
      `expect(true).toBe(true)` test and passes.
- [ ] AC6 — `pnpm lint` and `pnpm typecheck` both pass on the empty scaffold.
- [ ] AC7 — `.nvmrc` pins Node `22`.

## Implementation Notes
- Use `@modelcontextprotocol/sdk` at the latest stable.
- Crib the multi-transport bootstrap from `GLips/Figma-Context-MCP` (MIT) —
  attribute in NOTICE.md.
- Prefer `tsx` for `pnpm dev` (no compile step in dev).

## Out of Scope
- CI workflows (M0-04).
- Tool registration (M1).

## Dependencies
- Blocks: M0-04 (CI needs the build scripts).
- Blocked by: M0-02.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — placeholder test passing.
- [ ] Docs updated — README quickstart section.
- [ ] Manual verification — fresh clone + `pnpm i && pnpm dev`.
- [ ] No new ESLint/TS errors — confirmed.
- [ ] Reviewed by 1 maintainer.
