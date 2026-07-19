---
title: "[M0-02] Initialize repo, MIT LICENSE, governance docs"
milestone: "M0 — Discovery & Scaffold"
labels: ["type:chore", "area:ci", "priority:P0-critical", "size:S"]
assignees: []
estimate: "2h"
---

## Summary
Record and verify the transferred `ambitresearch/genie` GitHub repository, MIT LICENSE,
CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, CODEOWNERS, and a README that
points at the docs/ tree. This is the legal and social entry point for the
project.

## Context
- INDEX.md: "License: MIT", "Repository: ambitresearch/genie".
- Open-source comparators (`GLips/Figma-Context-MCP`,
  `Jpisnice/shadcn-ui-mcp-server`) both ship the same docset.

## Acceptance Criteria
- [ ] AC1 — Repo exists at `ambitresearch/genie`, default branch
      `main`, branch protection on (1 review + status checks required).
- [ ] AC2 — `LICENSE` file is the standard MIT text with year 2026 and
      copyright "Roshan Gautam".
- [ ] AC3 — `CONTRIBUTING.md` describes the issue lifecycle, branch naming
      (`type/short-slug`), commit message convention (Conventional Commits),
      and the PR review checklist.
- [ ] AC4 — `CODE_OF_CONDUCT.md` adopts Contributor Covenant 2.1 verbatim.
- [ ] AC5 — `SECURITY.md` documents the disclosure address
      (`security@roshangautam.com`) and the 90-day responsible-disclosure
      window.
- [ ] AC6 — `CODEOWNERS` makes `@roshangautam` the global owner.
- [ ] AC7 — `README.md` includes the one-paragraph elevator pitch, badge row
      (CI · npm · license), quickstart, and links into `INDEX.md`.

## Implementation Notes
- Verify the transferred repository with `gh repo view ambitresearch/genie`.
  It remains **private pending public release** per INDEX.md; any visibility
  change is a separate release decision.
- Pull templates from `github.com/github/docs` or
  `github.com/anthropics/skills` for COC.
- Do NOT enable `Discussions` yet — pre-launch noise.

## Out of Scope
- Repo settings beyond branch protection (covered by M0-04).
- npm package reservation (covered by M0-04).

## Dependencies
- Blocks: every issue that needs to PR into the repo.
- Blocked by: M0-01.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A.
- [ ] Docs updated — yes, the docs themselves.
- [ ] Manual verification — `gh repo view ambitresearch/genie`
      shows the new repo with all six docs present.
- [ ] No new ESLint/TS errors — N/A.
- [ ] Reviewed by 1 maintainer.
