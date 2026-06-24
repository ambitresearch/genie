# Research traceability matrix

> **M0-01 deliverable.** Maps each load-bearing claim from the validated research
> report (`docs/.deliverables/research-report.json`, 46-agent run, 19/20 confirmed)
> to the roadmap milestone(s) that depend on it. This anchors M1–M6 acceptance
> criteria to primary sources so nothing downstream is unmoored.
>
> **Status:** awaiting maintainer sign-off (M0-01 AC5).
> **Source of truth:** `result.claimVerdicts` (the audit trail) + `result.report`
> (the authoritative spec). Do not contradict `INDEX.md` §"Source-of-truth facts."

## How to read this

- **Status** — `confirmed` (≥2/3 verifier votes) or `killed` (refuted).
- **Backs** — the milestone(s) whose work depends on the claim being true, or an
  explicit *out-of-scope* note.
- **Source** — the primary URL the verifiers cited (full URLs in the report JSON).

---

## Confirmed load-bearing claims

| # | Claim (abbreviated) | Status | Backs | Source |
|---|---|---|---|---|
| C1 | Claude Design is powered by Claude Opus 4.x, in research preview for Pro/Max/Team/Enterprise | ✅ confirmed | M2 (model routing — `design-best` alias resolves to Opus); positioning (§2 BRD) | support.claude.com release notes |
| C2 | `/design-sync` and `/design` slash-commands are publicly named by Anthropic | ✅ confirmed | M1 (the verb surface genie mirrors); naming/interop posture | claude.com/product/design |
| C3 | Every preview file requires a first-line `<!-- @dsCard group="…" -->` HTML comment | ✅ confirmed | **M3** (`@dsCard` regex validator + manifest compiler) | bundled-skill source |
| C4 | The Design System pane manifest is regenerated server-side from the `@dsCard` markers | ✅ confirmed | **M3** (manifest compiler); **M4** (viewer consumes manifest) | claude.ai/design behavior |
| C5 | Claude Code supports MCP over stdio, HTTP (streamable-http), SSE (deprecated) | ✅ confirmed | **M0** (transport multiplexer — stdio + HTTP shipped); M5 (harness smoke) | MCP spec + Claude Code docs |
| C6 | Claude Code surfaces MCP resources via `@server:protocol://resource/path` | ✅ confirmed | M4 (`ds://` + `ui://` resource layer); M5 (Claude Code smoke) | Claude Code docs |
| C7 | Codex CLI declares MCP servers in `~/.codex/config.toml` under `[mcp_servers]` | ✅ confirmed | M5 (Codex harness config snippet + smoke) | Codex CLI docs |
| C8 | Codex CLI supports OAuth via `codex mcp login <server>` | ✅ confirmed | **M5** (OAuth DCR auth path) | Codex CLI docs |
| C9 | MCP Apps stable spec (2026-01-26) defines `ui://` scheme + `text/html;profile=mcp-app` MIME | ✅ confirmed | **M4** (`ui://genie/grid` MCP-Apps resource) | apps.extensions.modelcontextprotocol.io |
| C10 | VS Code renders MCP Apps inline in chat in a sandboxed iframe | ✅ confirmed | M4 (viewer parity); M5 (VS Code smoke) | VS Code docs |
| C11 | VS Code MCP Apps tracking issue (#260218) is closed, Jan 2026 milestone | ✅ confirmed | M4/M5 timing; **uncertainty U4** (verify pre-launch) | github.com/microsoft/vscode#260218 |
| C12 | ChatGPT's Apps SDK renders `ui://` resources | ✅ confirmed | M4 (Tier-2 host coverage); GTM (cross-host reach) | developers.openai.com/apps-sdk |
| C13 | Framelink Figma-Context-MCP is MIT, 15.2k★ (scaffolding prior art) | ✅ confirmed | M0 (transport/CLI patterns, attributed in NOTICE); competitive landscape | github.com/GLips/Figma-Context-MCP |
| C14 | shadcn-ui-mcp-server is MIT, 2.8k★ (distribution prior art) | ✅ confirmed | competitive landscape (BRD §3, launch doc) | github.com/Jpisnice/shadcn-ui-mcp-server |
| C15 | 21st-dev/magic-mcp is MIT, 5.2k★ (slash-command UX prior art) | ✅ confirmed | competitive landscape | github.com/21st-dev/magic-mcp |
| C16 | Figma Dev Mode MCP Server is hosted, usage-priced | ✅ confirmed | positioning (self-host differentiator, BRD §3.4) | help.figma.com |
| C18 | MCP defines transport, lifecycle, security principles; tools are server-declared | ✅ confirmed | **M0** (whole architecture); M1 (tool layer) | modelcontextprotocol.io spec |
| C19 | No DesignSync / `_ds_manifest` / `@dsCard` reference exists in the public MCP registry | ✅ confirmed | "greenfield" thesis (BRD §2/§3.5) | MCP Registry search |
| C20 | Claude Design launched 2026-04-17 alongside Opus 4.7 | ✅ confirmed | positioning timeline (BRD §2/§3.5); "why now" | anthropic.com/news |

## Killed claim

| # | Claim | Status | Correction | Backs |
|---|---|---|---|---|
| C17 | "Claude Design is an **Anthropic Labs beta** product available on Pro/Max/Team/Enterprise…" | ❌ killed | The compound claim was refuted **only on the "Anthropic Labs" framing** — the cited source does not describe it as an "Anthropic Labs" product. The substantive parts (Pro/Max/Team/Enterprise availability, Enterprise-off-by-default, `claude.ai/design` surface, `/design-sync` + `/design` companions) are independently confirmed by C1/C2. **Corrected wording:** "Claude Design is a hosted research-preview feature on `claude.ai/design`, available to Pro/Max/Team/Enterprise subscribers (Enterprise off by default)." | positioning (BRD §2 — must NOT call it an "Anthropic Labs" product) |

> **Why this matters:** the killed framing is the one place a downstream doc could
> overstate what's verified. Any genie doc describing Claude Design must use the
> corrected wording above, not "Anthropic Labs beta."

## Honest uncertainties → empirical settle-step

These are unproven assumptions (from `INDEX.md` §"Honest uncertainties"); each
needs an empirical step before the milestone that depends on it ships.

| # | Uncertainty | Settle-step | Gates |
|---|---|---|---|
| U1 | Canvas-side generation prompt is undocumented — genie invents it | Design + eval the generation prompt against real kits | M2 (`generate_component`); canvas R&D parked post-M5 |
| U2 | `_ds_sync.json` schema reconstructed from `lib/sync-hashes.mjs`, not a public spec | Diff genie's writer output against a real Claude Design sync; freeze at last-observed shape | M3 (`_ds_sync.json` writer) |
| U3 | `ui://` inline rendering in Claude Code unverified | Empirical render test in Claude Code pre-launch | M4 (render_preview); M5 (Claude Code smoke) |
| U4 | VS Code MCP Apps Stable on schedule (Jan 2026) | Re-verify #260218 shipped before relying on it | M4/M5 |
| U5 | Cursor's 40-tool cap is historical, not in current docs | Empirical test with 50+ tools in Cursor pre-launch | M5 (Cursor smoke); tool-sharding fallback |
| U6 | Skybridge spike must prove embedded CSP + display-mode parity + Cursor/VS Code rendering | Run the time-boxed spike (RFC §15.8) **before M4 hand-build** | **M4** (pre-build gate) |
| U7 | Cross-harness "write once, run everywhere" is unguaranteed by the spec | Per-harness hands-on validation, not assumption | M5 (7-harness smoke matrix) |

---

## Sign-off

- [ ] Maintainer has reviewed each claim → milestone mapping (M0-01 AC5).
- [ ] No row contradicts `INDEX.md` §"Source-of-truth facts."
- [ ] The killed-claim correction (C17) is reflected in all positioning copy.

_Generated for M0-01. Update if the research report is ever re-run (it is the
input, not a living document — see M0-01 out-of-scope)._
