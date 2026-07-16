---
title: "[M5-05] .mcpb bundle packaging for Claude Desktop"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:infra", "area:mcpb", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Package the server as a `.mcpb` bundle so Claude Desktop users can
double-click install. Use the renamed `modelcontextprotocol/mcpb` toolchain
(formerly `anthropics/dxt`). Output artefact `genie.mcpb`
attached to every GitHub Release.

## Context
- Research report §7 step 9: "`npx @modelcontextprotocol/mcpb pack` (per
  the renamed `anthropics/dxt` → `modelcontextprotocol/mcpb` toolchain)".
- §5 prior art (shadcn-ui-mcp-server v2.0.0 ships `.mcpb`) — model the
  bundle after that one.

## Acceptance Criteria
- [ ] AC1 — File `mcpb/manifest.json` describes name, version, transports
      (stdio), entry, env-var requirements.
- [ ] AC2 — `pnpm bundle:mcpb` runs `npx @modelcontextprotocol/mcpb pack`
      and emits `dist/genie.mcpb`.
- [ ] AC3 — Bundle includes the server's `dist/`, `node_modules` (prod
      only), the embedded viewer assets, and the manifest.
- [ ] AC4 — Bundle size < 30 MB compressed.
- [ ] AC5 — Double-clicking the `.mcpb` on macOS installs into Claude
      Desktop without manual config.
- [ ] AC6 — Bundle uploaded to every GitHub Release via Action.

## Implementation Notes
- File: `mcpb/manifest.json`, `scripts/bundle-mcpb.mjs`.
- Document the env-var prompts Claude Desktop shows on first run
  (`GENIE_LLM_API_KEY`, etc.).

## Out of Scope
- Windows / Linux bundle verification (defer to v2; v1 is macOS-tested).

## Dependencies
- Blocks: M5-10 (Claude Desktop smoke).
- Blocked by: M4-08.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — bundle generation passes integrity check.
- [ ] Docs updated — README install section.
- [ ] Manual verification — install on a fresh macOS profile.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
