# Design — genie chat-invocation surface

> Spec for making genie's viewer + verb workflow invokable from a natural chat
> conversation across popular AI coding harnesses.
> Status: **approved design, implemented.** Author date: 2026-07-05; Agent
> Skills capability matrix corrected 2026-07-10 as harness support evolved.

## Problem

genie ships a 19-tool MCP surface but **no guidance layer** teaching a host
model _when_ and _in what order_ to call those verbs, and **no mechanism that
reliably makes the GUI actually appear** in response to a chat request like
"show me my Button component" or "build me a CTA button and let me see it."

Three concrete gaps, found during manual testing (2026-07-05):

1. **No bundled Skill and no slash-command exist anywhere in the repo**
   (`.claude/skills/` and `.claude/commands/` are both absent). Invoking the
   viewer from chat depends entirely on the model inferring intent from raw MCP
   tool descriptions.
2. **`preview` does not compile the manifest.** `runPreview`
   (`packages/server/src/tools/preview.ts`) boots/reuses the Vite viewer and
   builds the resource URI, but never calls `compileManifest`. Today the
   manifest is compiled **only** as a side effect of a `ui://genie/grid`
   resource read (`packages/server/src/ui/grid-resource.ts:319`). So a caller
   that opens the returned Vite / `file://` URL — or MCP Inspector, which
   cannot read `ui://` resources at all — sees an **empty grid**.
3. **`preview` never opens anything itself.** The default booter hardcodes
   `open: false`, so on a **non-`ui://`** local harness (e.g. Codex, tools-only
   Copilot, plain MCP Inspector) whether a browser/panel appears depends on the
   calling model choosing to shell `open <url>` — which those harnesses do
   inconsistently or not at all. (`ui://`-capable harnesses render the inline
   grid instead, so they don't have this gap.)

## Key constraint that shapes the whole design

**Agent Skills (`SKILL.md`) are now a portable guidance channel.** Claude,
Cursor, Codex CLI, and GitHub Copilot support the open Agent Skills format,
though their install directories differ. Tool `description` strings remain the
universal fallback, and non-`ui://` local hosts still rely on **genie opening
the browser itself, server-side, on the user's own machine.** This capability
correction supersedes the original 2026-07-05 assumption that Agent Skills were
Claude-only.

**Two orthogonal harness axes.** Because Skill-loading and `ui://`-rendering are
independent capabilities, harnesses fall into a grid, and a given harness can
need different pieces of this design:

| Harness                           | `ui://`-capable? (inline grid, no auto-open) | Loads Agent Skills? | Gets guidance from                           |
| --------------------------------- | -------------------------------------------- | ------------------- | -------------------------------------------- |
| Claude Code / Desktop / claude.ai | yes                                          | **yes**             | Skill (C) + descriptions (D)                 |
| Cursor                            | **yes**                                      | **yes**             | Skill (C) + inline grid + descriptions (D)   |
| VS Code Copilot (≥Jan 2026)       | capability-dependent                         | **yes**             | Skill (C) + negotiated UI + descriptions (D) |
| ChatGPT remote connector          | yes                                          | no                  | inline grid + descriptions (D)               |
| Codex CLI                         | **no**                                       | **yes**             | Skill (C) + **server auto-open (B)**         |
| GitHub Copilot                    | capability-dependent                         | **yes**             | Skill (C) + negotiated UI/browser fallback   |
| MCP Inspector                     | **no**                                       | no                  | **server auto-open (B)** + descriptions (D)  |

Corollary that drives priority: **reliability comes from the server (piece A/B);
the Skill, tool-descriptions, and slash-command (C/D/E) are the ergonomic layer
on top.** No text can force a third-party harness's agent loop to open a URL.

## Scope

In scope (approved 2026-07-05):

- **A.** Fix `preview` to compile + persist the manifest via a shared helper.
- **B.** Harness-aware server-side auto-open in `preview`.
- **C.** A genie-authored portable **Agent Skill** (`SKILL.md`) teaching the full
  verb workflow across supported Agent Skills harnesses.
- **D.** Hardened MCP tool `description` strings — every harness.
- **E.** A Claude Code **slash-command** (`/genie:preview`) escape hatch.
- **F.** Delivery via **both** a Claude Code marketplace plugin _and_ documented
  manual artifact copy.

Explicitly out of scope:

- Any orchestration / agent-fleet / sandbox-provider work (unrelated; a stale
  ralph-loop injected that phrasing — see session notes).
- New per-harness UI panels beyond what each harness already renders from
  `ui://` or an opened browser tab.
- Cross-OS auto-open guarantees beyond what the `open` npm package already
  provides (macOS primary; Linux/Windows best-effort via the same package).

## Approved decisions

| Decision                                      | Choice                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `preview` auto-open default (non-ui:// hosts) | **Opt-out** — on by default; `GENIE_PREVIEW_NO_OPEN=1` disables.                          |
| Skill + slash-command delivery                | **Both** — marketplace plugin _and_ manual artifact copy docs.                            |
| Manifest compile location                     | **Shared `ensureManifest(kitDir)` helper**, called by both `preview` and `grid-resource`. |

---

## A. Manifest-compile fix (prerequisite)

**Unit:** `ensureManifest(kitDir): Promise<Manifest>` — a small helper (new file
`packages/server/src/manifest/ensure.ts`, or an added export in
`manifest/index.ts`) that wraps `compileManifest(kitDir)` (currently at
`manifest/compiler.ts:289`) and persists the result to
`<kitDir>/.genie/manifest.json`.

- **What it does:** compiles the on-disk kit to a `Manifest` and writes it to
  disk, returning the compiled manifest.
- **How it's used:** `runPreview` calls it before reporting the URL;
  `grid-resource`'s handler calls it instead of calling `compileManifest`
  directly (its `deps.compile` seam at `grid-resource.ts:418` retargets to
  `ensureManifest`, preserving the injectable-for-tests pattern).
- **What it depends on:** `compileManifest` + the store's file-write primitive.
- **Why shared:** removes the current single-compile-site coupling where only a
  `ui://` read compiles. One source of truth; `preview` and the grid resource
  can never diverge on how a manifest is produced.

Result: all three vehicles (Vite / `file://` / `ui://`) render real cards after
a single `preview` call, and `list_components` (which reads the compiled
manifest) returns populated results without needing a prior `ui://` read.

## B. Harness-aware server-side auto-open

**Unit:** the auto-open branch inside `runPreview`, gated first on negotiated
MCP Apps capability and then, only when extension negotiation is unavailable,
on the legacy `clientSupportsUi(ctx.clientName)` sniff.

- **MCP Apps-capable host:** boot headlessly and do not request a browser open.
  The inline `ui://genie/grid` grid renders in-panel.
- **Local stdio client without UI support:** boot headlessly, construct the
  filter-bearing viewer URL, then call `ViewerRegistry.open(target)`.
  `ViewerRegistry` caches one viewer per kit dir while tracking browser-open
  state per target, so an inline caller can boot first and a later tools-only
  caller opens the cached viewer. Repeated requests for the same filtered URL
  dedupe; a changed component/group target opens again.
- **HTTP deployment:** never call `ViewerRegistry.open`; a remote caller must
  not launch a browser on the server machine.
- **Override:** `GENIE_PREVIEW_NO_OPEN=1` suppresses the separate registry open
  everywhere (opt-out; default is on for local non-ui stdio hosts).
- **Degradation:** `ViewerRegistry.open` catches browser-open failures and keeps
  the returned viewer URL available, so headless boxes lose nothing.

On the local path, `runPreview` calls `ViewerRegistry.ensure(..., false)` to boot
or reuse a viewer headlessly. The harness-aware decision controls a later
`ViewerRegistry.open(filteredUrl)` call, which preserves
`componentName`/`group` filters and keeps boot caching separate from
target-deduplicated browser opening. Remote paths do not invoke the viewer
registry.

## C. Portable bundled Agent Skill

**Unit:** `SKILL.md` (+ any `references/` files) describing genie's full verb
workflow.

- **Teaches:** the happy-path sequence
  `conjure → plan → write_files → preview` and the refine/validate/delete side
  paths; when to reach for each verb; the **plan-guard capability model**
  (`write_files`/`delete_files` need a `planId` whose globs cover the paths);
  the real-`model` requirement for `conjure`/`refine`; and that `preview` is
  how you _show_ the user a component.
- **Trigger:** natural requests like "build/show/preview a component," "let me
  see my kit," "make a button and open it."
- **Depends on:** the genie MCP server being registered in the harness.
- **Loads in:** Claude, Cursor, Codex, and GitHub Copilot from each harness's
  documented project/user Skill directory.

## D. Hardened MCP tool descriptions (every harness)

**Unit:** the `description` strings on the 19 registered tools.

- Encode the same "when to reach for me / what typically comes next" hints the
  Skill carries inside each tool's own `description` — universal fallback
  guidance when a host does not load or invoke the Skill.
- Example shape: `preview`'s description states it compiles the manifest and
  opens/points to the live grid, and that it's the verb to call after
  `write_files` when the user wants to _see_ a component.
- Constraint: keep descriptions accurate to actual behavior post-A/B (no
  aspirational claims); do not break the verbatim Anthropic interop terms
  (CLAUDE.md hard rule 1).

## E. Claude Code slash-command (escape hatch)

**Unit:** a plugin `commands/preview.md` (invoked `/genie:preview`). Manual
copy installs the same source as `~/.claude/commands/genie-preview.md`, exposed
without a plugin namespace as `/genie-preview`.

- Lets a user **force-open** the viewer for a named/most-recent kit without
  depending on model inference.
- Claude-Code-only; additive, not a replacement for B.

## F. Delivery — both channels

1. **Claude Code marketplace plugin.** Bundles `SKILL.md` + the namespaced
   slash-command for a separately registered genie MCP server. Server runtime
   packaging belongs to the npm / `.mcpb` M5 distribution work; claiming an
   out-of-root local server path would make a marketplace install non-runnable.
   Modeled on the existing `claude-plugins-official` plugin layout
   (`.claude-plugin/plugin.json`, `hooks/`, `commands/`, `skills/`).
2. **Manual artifact copy from a source checkout.** The implemented
   `packages/plugin/skills/genie` source and `docs/harness/*.md` guides let users
   copy the portable Skill into each host's supported directory
   (`.claude/skills`, `.cursor/skills`, `.agents/skills`, or
   `.github/skills`/`~/.copilot/skills`). The slash command remains
   Claude-Code-specific; every host also receives hardened descriptions from D.
   Shipping these artifacts inside npm / `.mcpb` remains M5 packaging scope and
   is not claimed by this PR.

## Testing

- **A (compile):** unit test that `runPreview` persists a non-empty
  `.genie/manifest.json` for a kit with a component, and that
  `list_components` returns it afterward without a prior `ui://` read. Test
  `ensureManifest` directly (compiles + writes + returns).
- **B (auto-open):** unit test the open/no-open branch off `clientSupportsUi`
  and off `GENIE_PREVIEW_NO_OPEN`, using the injectable booter (assert the
  `open` flag value passed to `BootRequest`; no real browser in tests).
- **C/D/E (docs/skill/command):** covered by the M5 per-harness smoke tests
  (M5-09..M5-15) — Skill/command/descriptions are declarative text, verified by
  the four-verb chain rendering a populated grid in each harness.
- **F (delivery):** plugin `plugin.json` validates; manual-copy docs verified by
  a clean-profile install walkthrough.

## Relationship to existing backlog

- **A/B** are a fix + enhancement to **M4-05** (the `preview` tool) — likely a
  new issue "DRO-xxx: preview compiles manifest + harness-aware auto-open."
- **C/D/E/F** are **new backlog items** (no existing issue covers a genie-native
  Skill / slash-command / plugin). They slot near **M5** distribution
  (M5-05 `.mcpb`, M5-09..M5-15 harness snippets) but are additive to it.

## Open questions (none blocking)

- Exact `planId` for backlog issues — assigned at planning time.
- Whether the slash-command should also accept a `componentName`/`group` filter
  (mirrors `preview`'s optional args) — decide during implementation; default to
  whole-kit if omitted.
