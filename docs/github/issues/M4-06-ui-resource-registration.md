---
title: "[M4-06] Register ui://genie/grid MCP-Apps resource"
milestone: "M4 — Preview Viewer (Vite + ui://)"
labels: ["type:feature", "area:mcp-ui", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary

Register the MCP-Apps resource at `ui://genie/grid`. MIME type is
the spec-mandated `text/html;profile=mcp-app` (per stable spec dated
2026-01-26). Body is the same `index.html` the Vite viewer serves, **with
the manifest inlined** as `<script type="application/json" id="manifest">…
</script>` so the sandboxed iframe doesn't need any fetch.

## Context

- Research report §3.4: "MIME `text/html;profile=mcp-app`, URI scheme
  `ui://`, linked via `_meta.ui.resourceUri` on the tool result. Stable spec
  dated 2026-01-26."
- Confirmed claim: spec URI scheme + MIME type.

## Acceptance Criteria

- [ ] AC1 — Resource registered via `server.registerResource({uri:
"ui://genie/grid", mimeType: "text/html;profile=mcp-app"})`.
- [ ] AC2 — Resource handler reads the kit identified by query-string
      `kitId`, compiles the manifest (M3-03), and inlines it into the
      HTML.
- [ ] AC3 — HTML is self-contained: exact `viewer.js` / `viewer.css` bytes are
      inlined because MCP Apps hosts receive one raw HTML resource and do not
      translate browser-relative URLs into additional `resources/read` calls.
- [ ] AC4 — Iframe `src` values are absolute `https://` URLs pointing at a
      separate-origin preview host (`previews.${DOMAIN}`); for solo dev,
      fall back to `data:text/html;base64,…` inlined HTML.
- [ ] AC5 — CSP allow-list declared at canonical `contents[]._meta.ui.csp`
      with `connectDomains` / `resourceDomains` / `frameDomains`.
- [ ] AC6 — `_meta["openai/outputTemplate"]` ALSO set on the tool result for
      ChatGPT Apps SDK compatibility (research report §3.4 cross-vendor note).

## Implementation Notes

- File: `packages/server/src/ui/grid-resource.ts`.
- Use `@modelcontextprotocol/ext-apps/server`.
- Cross-origin: research report §6 — separate origin "satisfies the
  per-card iframe isolation Anthropic does at `*.artifacts.anthropic.com`".

## Out of Scope

- ChatGPT widget-CSP / widgetDomain extensions beyond outputTemplate (v2).

## Dependencies

- Blocks: M4-10.
- Blocked by: M4-05, M3-03.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → visual-validate against the mock → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments

- explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Design Reference

This issue produces visual output (**pixel-diff target**). Validate per [`AGENTS.md`](../../../AGENTS.md) §3.

**Primary mock:** [`03-embedded-modes.svg`](https://github.com/ambitresearch/genie/blob/main/docs/designs/design-6/03-embedded-modes.svg) — inline / fullscreen / pip framings.

**Validate:** screenshot your build, diff layout/hierarchy/spacing against the mock, and confirm the **identity rule** — clay/gilt accent (`#c87c5e`/`#ac5a40`) ONLY on generate/refine moments, structure stays ink/neutral. Verify colors with computed styles, not a JPEG.

## Definition of Done

- [ ] Tests added — resource fetch returns valid HTML; manifest inlined.
- [ ] Docs updated.
- [ ] Manual verification — render in VS Code Insiders inline.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
