# CLAUDE.md — genie

> Project context + working agreements for any agent (Claude or otherwise) working
> in this repo. Auto-loaded every session. Keep it tight; this is instructions, not docs.

## ▶ First thing every session

**Read `.claude/TASKS.md` if it exists.** It's the local, gitignored scratchpad holding
our live plan — what's done, in progress, pending, parked. It is the source of truth for
"what are we doing right now." Update it as work moves; it is _not_ committed (intentionally
local). GitHub issues and pull requests are the durable work record; `TASKS.md` is the
fast working pad.

## What genie is

A **harness-agnostic MCP server for AI UI-component generation, inspired by Anthropic's
Claude Design** — an AI UI-component generator with a live preview + UI-kit browser that
lives _inside_ AI coding harnesses (Claude Code, Cursor, VS Code, ChatGPT, etc.) via MCP.
An independent, open-source take on the same idea, not a reproduction of Anthropic's hosted
product. The wedge: harness-native component generation against your own UI kit, no separate
app to open.

- **Two product surfaces:** (1) live component-preview grid + refine pane, (2) UI-kit file browser.
- **Two design tiers:** _embedded_ (renders in a host iframe; system fonts; strict CSP
  `default-src 'none'`, no web fonts) and _standalone_ (brand fonts). Cards must be
  **byte-identical across vehicles** (`file://` / `localhost` / `ui://`) — RFC G-5.
- **Server core** (model routing via a configured OpenAI-compatible endpoint, project
  store, sync, manifest compiler) is independent of the preview/UI framework choice.

## Repo map

- `docs/user/` — public installation, harness, workflow, and troubleshooting guide.
- `docs/developer/` — public architecture, contribution, security, release, and design guide.
- `docs/designs/design-6/` — canonical Warm Instrument SVG references and `tokens.css`.
- `docs/harness/` — tested registration and behavior references for each coding harness.

## Hard rules — do not break

1. **Preserve Anthropic interop terms verbatim when referencing interop:** `DesignSync`,
   `Claude Design`, `@dsCard`, `_ds_*`, `design-sync`. genie's native surface uses
   its own 13 verbs, `@genie`, `.genie/`, and `genie://`; Anthropic shapes belong
   only in explanatory prose or a future opt-in interop bridge.
2. **Terminology:** the user's component library is a **"UI kit"** (not "design system" —
   that's a Claude Design concept). genie's _own_ locked visual language _is_ its "design
   system." Templates are **"blueprints."**
3. **Genie identity / accent rule:** clay/gilt accent appears **only** on generation + refine
   moments. Structure (chrome, browser, layout) stays ink / ink-blue / neutral.
4. **SVG mockups hardcode hex** — they do NOT consume `tokens.css`. 1440×980 canvas.
5. **Secrets are never hardcoded.** Keep as `user_config` / env: `HA_AGENT_KEY`,
   `HONCHO_API_KEY`, `TRUENAS_API_KEY`, LLM endpoint keys. Nothing secret enters the repo.
6. **Skybridge is parked, not adopted.** Do not build the viewer on it without a new,
   explicit proposal that proves genie's CSP + G-5 constraints.
7. **npm package names (M0-04 fallback, recorded here per that issue's AC5):** both
   the bare `genie` package and the `@genie` scope belong to unrelated npm users. The
   Ambit Research-owned packages are **`@ambitresearch/genie`** (server) and
   **`@ambitresearch/genie-viewer`** — both scoped, public, and published with npm
   provenance. npm provenance requires this source repository to be public before the
   first live publish. See `.github/workflows/release.yml` (DRO-278 / M5-06).

## Conventions

- Verify SVG edits by re-parsing the served file (DOMParser `parseOk`), not by screenshot —
  JPEG compression washes out the cream palette.
- `git` operations in this environment may need the MacOS-MCP shell tool (the sandbox blocks
  `.git` writes from the Bash tool).
- This repository is public at `ambitresearch/genie`.
