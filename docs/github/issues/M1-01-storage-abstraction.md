---
title: "[M1-01] Storage abstraction (local FS + git-host adapters)"
milestone: "M1 — Kit + Project Foundation"
labels: ["type:feature", "area:mcp-server", "area:storage", "priority:P0-critical", "size:L"]
assignees: []
estimate: "12h"
---

## Summary
Define store interfaces for kits and projects, and ship two adapters:
`LocalFsStore` (solo dev — a kit/project is a directory) and `GitHostStore`
(shared — a kit/project is a git-tracked tree, a `planId` is a branch,
`write_files` is commit, merge is publish). The git-host
adapter targets **any git host** (GitHub / Gitea / GitLab) via its HTTP API;
Gitea is the reference instance we test against. All M1 tools (M1-02 … M1-21)
are implemented against this interface, not against `fs` directly.

## Context
- D-G (`00-decisions.md`): genie writes to a **git-tracked tree** on any git
  host, swappable; local FS for solo. A kit is a repo, a `planId` becomes a
  branch, `plan` opens a PR (full fidelity when genie owns the repo),
  `write_files` commits, merge = atomic publish.
- The reference shared deployment runs Gitea, but no git host is privileged in
  the abstraction and no provider URL is baked into the code.

## Acceptance Criteria
- [ ] AC1 — `interface KitStore` defines: `listKits`, `getKit`,
      `listFiles`, `readFile(path, maxBytes)`, `createKit`,
      `openPlan(writes, deletes, localDir) → planId`,
      `commitPlan(planId, fileOps)`, `closePlan(planId)`.
- [ ] AC2 — `interface ProjectStore` defines: `listProjects`, `getProject`,
      `createProject`, `deleteProject`, `bindKit`, `recordScreen`.
- [ ] AC3 — `LocalFsStore` stores kits under
      `${GENIE_HOME ?? ~/.genie}/kits/<kitId>/` and treats
      each plan as a temp staging directory; projects live under
      `${GENIE_HOME ?? ~/.genie}/projects/<projectId>/`.
- [ ] AC4 — `GitHostStore` uses a git-host SDK against an operator-configured
      base URL, plan = branch `plan/${planId}`, commit on `commitPlan`, no
      auto-merge.
- [ ] AC5 — Both adapters pass the same conformance test suite
      (`packages/server/test/store-conformance.test.ts`).
- [ ] AC6 — `GitHostStore` honours its token from env (`GENIE_GIT_TOKEN`),
      fails fast with a clear error if missing.
- [ ] AC7 — `readFile` enforces the 256 KiB cap and throws
      `FileTooLargeError` with the actual size in the message.

## Implementation Notes
- File: `packages/server/src/store/{interface.ts,local.ts,git-host.ts}`.
- Test fixtures: `packages/server/test/fixtures/sample-kit/` (≈10 components).
- Git-host base URL + token are env-configured; nothing hardcoded. Gitea is the
  reference instance for CI/manual testing.

## Out of Scope
- S3 / Postgres backends (out of scope for v1).
- Kit sharing / ACLs (the user owns every kit they touch in v1).

## Dependencies
- Blocks: M1-02 … M1-21.
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — conformance suite ≥ 90 % branch coverage on both adapters.
- [ ] Docs updated — `docs/plan/04-tech-design-rfc.md` §3.3 cross-link.
- [ ] Manual verification — `pnpm dev` against a real git host creates,
      reads, lists kits end-to-end.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
