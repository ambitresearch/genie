# Genie — Documentation Index

Generated 2026-06-21. All docs derive from the validated research report
(46-agent custom workflow, 19/20 claims confirmed) in this project.

## Reading order for first-time review

1. **Product Vision** (`docs/plan/01-product-vision.md`) — why we're building this
2. **BRD** (`docs/plan/02-brd.md`) — business case, scope, stakeholders
3. **PRD** (`docs/plan/03-prd.md`) — features, user stories, acceptance criteria
4. **Tech Design / RFC** (`docs/plan/04-tech-design-rfc.md`) — architecture, contracts, deployment
5. **GitHub Roadmap** (`github/milestones.md` + `github/issues/`) — execution plan as issues
6. **GTM + Post-Production** (`docs/plan/05-gtm-and-postprod.md`) — launch + iteration
7. **Operations + Runbook + Oncall** (`docs/plan/06-operations-runbook.md`) — keep it alive

## Source-of-truth facts (do not contradict)

- Project name: **genie**
- Repository: **roshangautam/genie** — **private**, to be created
- License: **MIT**
- Primary language: **TypeScript** (Node ≥ 22 LTS, ESM)
- MCP SDK: **@modelcontextprotocol/sdk**
- Distribution: npm + `.mcpb` bundle + Docker
- LLM backend: **any OpenAI-compatible endpoint** (configurable; LiteLLM is the reference, Ollama / OpenAI / vLLM also work — D-H). No provider URL baked in.
- Default model alias: `design-default` (operator-mapped to a Sonnet-class model)
- Storage: local FS for solo; **any git host** (GitHub / Gitea / GitLab) for shared — D-G
- Preview pane: Vite-backed viewer (`@ambitresearch/genie-viewer`) + MCP-UI `ui://` fallback
- Card marker regex (genie's own — D-B): `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`
- Tool-name shape: `mcp__genie__<verb>`
- **Tool catalog: 19 M1 tools (genie's own — D-A/D-F)** — kit/component core: `list_kits`, `get_kit`, `list_files`, `read_file`, `create_kit`, `list_components`, `plan`, `write_files`, `delete_files`, `validate`, `conjure`, `refine`, `preview`; project foundation: `list_projects`, `get_project`, `create_project`, `delete_project`, `bind_kit`, `conjure_screen`. Blueprints are reusable projects (`kind: "blueprint"`), not a separate tool family. Resource URI scheme: `genie://`; bookkeeping under `.genie/`.
- **Default MCP HTTP port: `8780`** (configurable via `GENIE_MCP_HTTP_PORT`)
- **Plan TTL: 15 minutes default**, configurable up to 24 hours via `GENIE_PLAN_TTL_MIN` env var
- **`write_files` payload cap: 16 MiB default**, hard ceiling 64 MiB configurable via `GENIE_WRITE_BYTE_CAP`
- Target harnesses (Tier-0 universal, 7): Claude Code · Claude Desktop · Codex CLI · GitHub Copilot (VS Code agent) · Cursor · Cline · Continue.dev
- First-class targets for `ui://` rich rendering (4): Claude, VS Code (Stable Jan 2026), ChatGPT, Cursor
- Ecosystem renderers (3, secondary): Goose, Postman, MCPJam — render `ui://` but not part of v1.0 launch matrix
- Local installs are stdio-first: the harness launches the `genie` process. Streamable HTTP is for already-running local dev, shared, or remote deployments.
- OAuth 2.0 with Dynamic Client Registration applies to Streamable HTTP deployments on Claude Code, Codex CLI, **and Cursor**; all other HTTP harnesses fall back to static `Authorization: Bearer`

## Build phases (referenced everywhere)

- **M0** — Discovery & scaffold (weeks 0–1)
- **M1** — Kit + Project Foundation — genie's own 19-tool M1 protocol (weeks 1–3)
- **M2** — LLM generation surface — `conjure`, `refine` (weeks 3–4)
- **M3** — `@genie` validator + manifest compiler + atomic sync orchestrator (weeks 4–5)
- **M4** — Preview viewer — Vite + MCP-UI `ui://` (weeks 5–7)
- **M5** — Auth + distribution + smoke tests across 7 harnesses (weeks 7–11)
- **M6** — GA Hardening — load test, security audit, supply-chain (sigstore + npm provenance), public docs site, launch checklist (weeks 11–12)

## Honest uncertainties (carry through every doc)

1. Canvas-side generation prompt is undocumented by Anthropic — we invent it.
2. genie's `.genie/sync.json` anchor schema is genie's own; the optional interop adapter maps it to Anthropic's `_ds_sync.json` shape (reconstructed from `lib/sync-hashes.mjs`, not a public spec).
3. `ui://` inline rendering in Claude Code unverified at draft time.
4. VS Code MCP Apps Stable on schedule (Jan 2026 milestone) — verify pre-launch.
5. Cursor's 40-tool cap is historical, not in current docs — test pre-launch.
6. Skybridge spike (RFC §15.8) must prove embedded-tier CSP (`default-src 'none'`, no web fonts) + inline/fullscreen/pip parity + real Cursor/VS Code rendering — all unproven in the 2026-06-23 deep-research, not negative. Gate before M4.
7. Cross-harness "write once, run everywhere" is an aspiration the MCP Apps spec explicitly refuses to guarantee — genie's harness-agnostic wedge needs per-harness hands-on validation, not assumption (research finding F2).

## Files

```
docs/
  plan/
    01-product-vision.md  → 01-product-vision.docx
    02-brd.md             → 02-brd.docx
    03-prd.md             → 03-prd.docx
    04-tech-design-rfc.md → 04-tech-design-rfc.docx
    05-gtm-and-postprod.md → 05-gtm-and-postprod.docx
    06-operations-runbook.md → 06-operations-runbook.docx
github/
  milestones.md
  labels.md
  AGENTS.md             → (repo root) canonical agent SDLC workflow contract
  MOCK-MAP.md           → issue → design-mock mapping for visual validation
  issues/
    M0-01-research-signoff.md
    M0-02-repo-scaffold.md
    ...
  scripts/build-artifacts.mjs  (regenerates CSV/script from issues/ on demand)
research/
  skybridge.md          → external framework eval (React framework for MCP Apps); affects RFC §5.2/§6.5/§6.9, G-5, M4
.deliverables/
  (intermediate notes from each generation agent)
```

## External resources & evaluations

- **`research/skybridge.md`** — evaluation of [Skybridge](https://www.skybridge.tech/),
  an MIT-licensed React framework for MCP Apps, as a possible replacement for genie's
  hand-rolled preview tier (RFC §6.9 Vite viewer + §6.5 `ui://` MCP-App payload).
  Decision scoped to the UI/preview tier only; server core unaffected.
  ✅ **Deep-research complete (2026-06-23) → verdict: 🟡 PARTIALLY ADOPT / spike-then-decide.**
  Skybridge is low-lock-in sugar over the standard `ui://`+iframe primitive (eject to
  raw SDK / mcp-ui anytime), but cross-harness parity is unguaranteed and the
  genie-critical blockers (embedded CSP, inline/fullscreen/pip parity, Cursor/Goose
  reach) are unproven — gated on a time-boxed spike **before M4**. Tracked at RFC
  §15.8; pre-M4 gate in BRD M4. Raw report: `research/skybridge.json`.
