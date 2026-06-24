---
title: "[M4-05] Tool: render_preview (returns _meta.ui.resourceUri)"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:mcp-tools", "area:mcp-ui", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Implement the `render_preview` MCP tool. Returns plain text content
(`"Preview running at http://localhost:5173"` and a `file://` fallback) plus
a `_meta.ui.resourceUri` pointing at a `ui://genie/grid` MCP-Apps
resource (registered in M4-06). Hosts that render `ui://` (Claude, VS Code
≥Jan 2026, ChatGPT, Cursor) get the inline grid; everyone else gets the URLs.

## Context
- Research report §3.1: `render_preview({ projectId, componentName?, group? }):
  { content: TextContent[], _meta: { ui: { resourceUri:
  "ui://genie/grid?…" } } }`.
- §3.4: "MCP Apps `ui://` resource for the four hosts that render it today
  — Claude, VS Code, ChatGPT, Goose/Postman/MCPJam."

## Acceptance Criteria
- [ ] AC1 — Tool name `mcp__genie__render_preview`.
- [ ] AC2 — Input: `{ projectId: string, componentName?: string, group?:
      string }`.
- [ ] AC3 — Returns: `{ content: [{ type: "text", text: <human URLs> }],
      _meta: { ui: { resourceUri: "ui://genie/grid?…" } } }`.
- [ ] AC4 — Resource URI query string carries `projectId` and optional
      filter params.
- [ ] AC5 — Boots the viewer server on demand if not already running;
      reuses across calls.
- [ ] AC6 — Falls back to `file://<projectRoot>/index.html` if Vite fails to
      boot (e.g. port in use).
- [ ] AC7 — Logs whether the requesting harness supports `ui://` (sniff via
      `params._meta.client.name` if present).

## Implementation Notes
- File: `packages/server/src/tools/render_preview.ts`.
- Use `@modelcontextprotocol/ext-apps/server` for resource registration
  (M4-06 provides the actual handler).

## Out of Scope
- Per-card detail view (v1 = grid only).

## Dependencies
- Blocks: M4-10 (smoke test).
- Blocked by: M4-04, M3-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`03-embedded-modes.svg`](https://github.com/roshangautam/genie/blob/main/docs/design/03-embedded-modes.svg) — the inline ui:// grid payload.

**Supporting:** [`02-preview-refine.svg`](https://github.com/roshangautam/genie/blob/main/docs/design/02-preview-refine.svg).

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done
- [ ] Tests added — happy path; viewer-down fallback.
- [ ] Docs updated.
- [ ] Manual verification — invoke from Claude Code + VS Code.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
