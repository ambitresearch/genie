---
title: "[M1-07] Tool: plan (capability grant boundary)"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-tools", "area:mcp-server", "priority:P0-critical", "size:L"]
assignees: []
estimate: "10h"
---

## Summary
Implement `plan` — the **single user-visible permission grant** that
locks `writes` (max 256 glob patterns, ≤ 3 wildcards each), `deletes`, and
`localDir`. Returns a `planId` that downstream write/delete/register calls
must present. Without a valid `planId`, those verbs are rejected.

## Context
- Research report §3.1 + §1.3: "Plan boundary (the single permission grant) —
  plan — locks `writes` (max 256 glob patterns, ≤3 wildcards each),
  `deletes`, `localDir`".
- Confirmed claim: "Calling write, delete, register, or unregister without a
  valid `planId`, or with paths outside the plan, is rejected."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__plan`.
- [ ] AC2 — Input: `{ kitId: string, writes: string[], deletes?: string[],
      localDir?: string }`.
- [ ] AC3 — Validates `writes.length ≤ 256` else
      `TooManyWritesError`.
- [ ] AC4 — Validates each glob pattern has ≤ 3 `*`/`**` wildcards else
      `TooComplexGlobError`.
- [ ] AC5 — `localDir` defaults to `process.cwd()` if omitted; must be an
      existing directory; uploads may only read from inside it.
- [ ] AC6 — Returns `{ planId: string }` (UUIDv4).
- [ ] AC7 — Plans expire after 1 h of inactivity (configurable via
      `GENIE_PLAN_TTL`).
- [ ] AC8 — Plan state is persisted to
      `${GENIE_HOME}/plans/<planId>.json` so it survives a server
      restart.
- [ ] AC9 — Concurrent `plan` calls on the same `kitId` from
      different sessions are allowed (each gets its own `planId`).
- [ ] AC10 — Emits a `plan.created` audit log line with `{ kitId, planId,
      writeCount, deleteCount }` (no path contents).

## Implementation Notes
- File: `packages/server/src/tools/plan.ts` + `src/plans/`.
- Globbing: `micromatch` with `dot: true`.
- Path-inside-localDir check: resolve + assert prefix.
- Server-side plan registry: `Map<planId, PlanState>` + JSON snapshot per
  mutation.

## Out of Scope
- Mid-plan path additions (clients must re-finalize for new paths).
- Plan revocation API (plans just expire).

## Dependencies
- Blocks: M1-08, M1-09, M1-12.
- Blocked by: M1-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — happy path, 257-write rejection, 4-wildcard rejection,
      localDir-escape rejection, TTL expiry, restart-survival.
- [ ] Docs updated — `docs/04-tech-design-rfc.md` §3.1.
- [ ] Manual verification via MCP inspector.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
