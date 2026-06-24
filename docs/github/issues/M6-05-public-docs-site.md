---
title: "[M6-05] Public docs site (mkdocs-material on GitHub Pages)"
milestone: "M6 — GA Hardening"
labels: ["type:docs", "area:docs", "priority:P1-high", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Publish the project docs as a navigable site at
`https://genie.docs.roshangautam.com` (or the GitHub Pages
default). Use mkdocs-material; auto-deploy on every push to `main`.

## Context
- Mature OSS comparators (Framelink, shadcn-mcp-server) all ship a docs
  site — table-stakes for adoption.

## Acceptance Criteria
- [ ] AC1 — `mkdocs.yml` configured with material theme, navigation tree
      mirroring `docs/` (vision, BRD, PRD, RFC, operations, GTM,
      harness pages).
- [ ] AC2 — `.github/workflows/docs.yml` deploys to `gh-pages` on push to
      `main`.
- [ ] AC3 — Docs include a copy-paste install matrix per harness (links to
      M5-09 … M5-15 docs).
- [ ] AC4 — Search works (mkdocs-material's built-in).
- [ ] AC5 — Dark mode supported.
- [ ] AC6 — 404 page links back to home.

## Implementation Notes
- File: `mkdocs.yml`, `.github/workflows/docs.yml`.

## Out of Scope
- Custom domain + Cloudflare proxy (defer).

## Dependencies
- Blocks: launch checklist.
- Blocked by: M5-09 … M5-15.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A.
- [ ] Docs updated — site is the docs.
- [ ] Manual verification — site live + links work.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
