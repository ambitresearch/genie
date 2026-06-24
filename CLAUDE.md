# CLAUDE.md — genie

> Project context + working agreements for any agent (Claude or otherwise) working
> in this repo. Auto-loaded every session. Keep it tight; this is instructions, not docs.

## ▶ First thing every session

**Read `.claude/TASKS.md` if it exists.** It's the local, gitignored scratchpad holding
our live plan — what's done, in progress, pending, parked. It is the source of truth for
"what are we doing right now." Update it as work moves; it is *not* committed (intentionally
local). The formal, committed plan lives in `docs/plan/` and the issue backlog in
`docs/github/issues/` — those are the durable spec; `TASKS.md` is the fast working pad.

## What genie is

A **harness-agnostic MCP server that clones Anthropic's Claude Design** — an AI UI-component
generator with a live preview + UI-kit browser that lives *inside* AI coding harnesses
(Claude Code, Cursor, VS Code, ChatGPT, etc.) via MCP. The wedge: harness-native component
generation against your own UI kit, no separate app to open.

- **Two product surfaces:** (1) live component-preview grid + refine pane, (2) UI-kit file browser.
- **Two design tiers:** *embedded* (renders in a host iframe; system fonts; strict CSP
  `default-src 'none'`, no web fonts) and *standalone* (brand fonts). Cards must be
  **byte-identical across vehicles** (`file://` / `localhost` / `ui://`) — RFC G-5.
- **Server core** (model routing via LiteLLM, project store, sync, manifest compiler) is
  independent of the preview/UI framework choice.

## Repo map

- `docs/designs/design-1/` — **canonical** SVG mockups (warm-editorial; Newsreader/Inter/JetBrains
  Mono; clay accent `#c87c5e`), `design.md` (locked design system), `tokens.css` (source of truth
  for tokens). `_*.html` files are local scratch tooling. `docs/designs/design-2|3|4/` are
  alternate variants (Copilot-generated) kept for A/B comparison — not canonical until chosen.
- `docs/plan/` — product vision, BRD, PRD, tech-design RFC, GTM, ops runbook (the formal spec).
- `docs/github/` — M0–M5 issue backlog, labels, milestones (the build plan).
- `docs/resources/` — external evaluations (e.g. Skybridge framework verdict).
- `docs/research-artifacts/` — raw deep-research reports.

## Hard rules — do not break

1. **Preserve Anthropic interop terms verbatim:** `DesignSync`, `Claude Design`, `@dsCard`,
   `_ds_*`, `design-sync`. genie *mirrors* their on-disk protocol for round-trip compat —
   renaming these breaks the feature. genie's *own* user-facing skill is `genie-sync`.
2. **Terminology:** the user's component library is a **"UI kit"** (not "design system" —
   that's a Claude Design concept). genie's *own* locked visual language *is* its "design
   system." Templates are **"blueprints."**
3. **Genie identity / accent rule:** clay/gilt accent appears **only** on generation + refine
   moments. Structure (chrome, browser, layout) stays ink / ink-blue / neutral.
4. **SVG mockups hardcode hex** — they do NOT consume `tokens.css`. 1440×980 canvas.
5. **Secrets are never hardcoded.** Keep as `user_config` / env: `HA_AGENT_KEY`,
   `HONCHO_API_KEY`, `TRUENAS_API_KEY`, LiteLLM keys. Nothing secret enters the repo.
6. **Skybridge is parked, not adopted** — gated on a spike before M4 (RFC §15.8;
   verdict in `docs/resources/skybridge.md` §8). Don't build on it until the spike clears
   genie's CSP + G-5 constraints.

## Conventions

- Verify SVG edits by re-parsing the served file (DOMParser `parseOk`), not by screenshot —
  JPEG compression washes out the cream palette.
- `git` operations in this environment may need the MacOS-MCP shell tool (the sandbox blocks
  `.git` writes from the Bash tool).
- This repo is committed to a **private** GitHub repo: `roshangautam/genie`.
