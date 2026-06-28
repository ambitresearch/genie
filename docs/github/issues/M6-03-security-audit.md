---
title: "[M6-03] Security audit (OWASP Top 10, dependency CVEs)"
milestone: "M6 — GA Hardening"
labels: ["type:security", "area:mcp-server", "priority:P0-critical", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
External security audit (or internal red-team session) against OWASP Top 10
2025 + MCP-specific threat model (tool-output injection, sandbox escape,
prompt injection, plan-vs-write bypass). Patch findings before GA.

## Context
- Research report §3.4 + M4-07 hardened the iframe sandbox; this issue
  validates the whole stack.

## Acceptance Criteria
- [ ] AC1 — `npm audit --omit=dev` clean (zero high/critical).
- [ ] AC2 — Audit report `docs/security-audit-v1.md` lists each OWASP
      category with the project's mitigation or "N/A — not exposed".
- [ ] AC3 — MCP-specific checks documented: tool-output injection
      handling, sandbox-escape attempts (M4-07), plan-vs-write bypass
      attempts (M1-13), CSP bypass attempts.
- [ ] AC4 — Prompt-injection probes against `conjure` recorded
      (does the model leak system prompt?).
- [ ] AC5 — Findings filed as P0/P1 issues with fixes landed before tag
      v1.0.0.
- [ ] AC6 — Re-audit after fixes, sign-off committed.

## Implementation Notes
- Use `npm audit`, `osv-scanner`, `semgrep --config=p/owasp-top-ten`.

## Out of Scope
- SOC 2 / ISO 27001 (out of scope for open-source v1).

## Dependencies
- Blocks: GA tag.
- Blocked by: M5-04, M4-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — N/A (audit).
- [ ] Docs updated.
- [ ] Manual verification — clean re-audit.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
