---
title: "[M1-01] Storage abstraction (local FS + Gitea adapters)"
milestone: "M1 — Tier-0 File Verbs"
labels: ["type:feature", "area:mcp-server", "area:gitea", "priority:P0-critical", "size:L"]
assignees: []
estimate: "12h"
---

## Summary
Define a `ProjectStore` interface and ship two adapters: `LocalFsStore` (solo
dev — a project is a directory) and `GiteaStore` (shared — a project is a Gitea
repo, a `planId` is a branch, `write_files` is commit, merge is publish). All
12 DesignSync verbs in M1-02 … M1-12 are implemented against this interface,
not against `fs` directly.

## Context
- Research report §3.3: "For solo dev, the local working tree is enough. For
  shared use, **Gitea on TrueNAS** is the substitute for Anthropic's cloud
  project store: a 'project' is a git repo, a `planId` becomes a branch,
  `finalize_plan` opens a PR, `write_files` commits to it, and merge = atomic
  publish."
- TrueNAS Gitea host: per CLAUDE.md homelab context, runs as a TrueNAS app on
  aether pool.

## Acceptance Criteria
- [ ] AC1 — `interface ProjectStore` defines: `listProjects`, `getProject`,
      `listFiles`, `getFile(path, maxBytes)`, `createProject`,
      `openPlan(writes, deletes, localDir) → planId`,
      `commitPlan(planId, fileOps)`, `closePlan(planId)`.
- [ ] AC2 — `LocalFsStore` stores projects under
      `${GENIE_HOME ?? ~/.genie}/projects/<projectId>/` and treats
      each plan as a temp staging directory.
- [ ] AC3 — `GiteaStore` uses `gitea-js` SDK against
      `https://gitea.${DOMAIN}/api/v1`, plan = branch
      `plan/${planId}`, commit on `commitPlan`, no auto-merge.
- [ ] AC4 — Both adapters pass the same conformance test suite
      (`packages/server/test/store-conformance.test.ts`).
- [ ] AC5 — `GiteaStore` honours `GITEA_TOKEN` from env, fails fast with a
      clear error if missing.
- [ ] AC6 — `getFile` enforces the 256 KiB cap and throws
      `FileTooLargeError` with the actual size in the message.

## Implementation Notes
- File: `packages/server/src/store/{interface.ts,local.ts,gitea.ts}`.
- Test fixtures: `packages/server/test/fixtures/sample-kit/` (≈10 components).
- Gitea base URL configurable via `GITEA_BASE_URL` env var; default
  `https://gitea.roshangautam.com/api/v1`.

## Out of Scope
- S3 / Postgres backends (out of scope for v1).
- Project sharing / ACLs (the user owns every project they touch in v1).

## Dependencies
- Blocks: M1-02 … M1-13.
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
- [ ] Docs updated — `docs/04-tech-design-rfc.md` §3.3 cross-link.
- [ ] Manual verification — `pnpm dev` against a real Gitea instance creates,
      reads, lists projects end-to-end.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
