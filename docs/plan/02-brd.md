# Business Requirements Document — genie

> **Version:** v0.1 DRAFT · **Status:** For sponsor review · **Date:** 2026-06-27
> **Project ID:** genie · **Repository:** `genie` · **License:** MIT
> **Working group:** Genie / Genie initiative

This BRD is the canonical business case for **genie** — a harness-agnostic, MIT-licensed MCP server that brings AI UI-component generation directly into whatever AI coding harness you already use, with a portable preview pane and a configurable OpenAI-compatible generation backend. The document is companion to the committed research notes in `docs/research/` and the **Product Vision** (`docs/plan/01-product-vision.md`). It supersedes nothing — there is no prior BRD — and must not contradict any source-of-truth fact recorded in `INDEX.md`.

> **Framing note.** genie is a **solo, AI-assisted open-source experiment**, not a funded product. Its real purpose is to find out whether MCP-Apps (rich UI rendered inside AI coding harnesses) are actually useful in practice — and to build the muscle for other, more original ideas if they are. It is not monetized and there are no plans to monetize it. The team is one person plus AI coding agents. Cost, funding, and revenue language in this document should be read as _opportunity-cost reasoning for a personal bet_, not a budget request. Sections that originally read as a funded-team pitch (§13 financial model, §14 resource ask, §7 RACI) have been reframed to that reality.

---

## §1. Document control

### §1.1 Versioning

| Attribute               | Value                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Document ID             | genie/02-brd                                                                                                           |
| Version                 | **v0.1 DRAFT**                                                                                                         |
| Status                  | For sponsor review (pre-Go/No-Go)                                                                                      |
| Effective date          | 2026-06-21                                                                                                             |
| Next mandatory review   | 2026-07-19 (4 weeks) or upon Go/No-Go decision, whichever first                                                        |
| Document classification | Internal — pre-public-launch                                                                                           |
| Source-of-truth pins    | `genie/INDEX.md`, `docs/research/`                                                                                    |
| Companion documents     | 01-product-vision · 03-prd · 04-tech-design-rfc · 05-gtm-and-postprod · 06-operations-runbook · `github/milestones.md` |

### §1.2 Owner and reviewers

| Role                         | Name                                                  | Responsibility                                                  |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Maintainer                   | **Solo maintainer**                                   | Authoring, weekly upkeep, decision capture                      |
| Sponsor                      | Self (the maintainer)                                 | Self-sponsored experiment; no external funding or approval gate |
| Engineering lead             | TBD (initially the document owner)                    | Translate BRD scope to PRD/RFC, sign tech-design                |
| Designer-in-residence        | TBD (recruitment open)                                | Component-library exemplars, viewer UX                          |
| OSS maintainer (post-launch) | TBD                                                   | Triage, releases, community contributions                       |
| Security reviewer            | TBD (peer review by anyone with MCP security context) | Threat-model sign-off                                           |
| Legal reviewer               | TBD (open-source-friendly counsel; Tier-2 only)       | License/trademark posture sign-off                              |
| Community liaison            | TBD                                                   | Discord / GitHub Discussions stewardship post-launch            |
| Anthropic liaison            | TBD (cold outreach to DevRel)                         | Trademark posture confirmation, optional collaboration          |

The reviewer roster is intentionally **TBD-heavy** because genie begins life as a single-maintainer OSS effort; this BRD itself is part of the artifact set used to court reviewers. Reviewers ratify the BRD by adding their name to the appropriate row and dropping a comment in the §17 open-questions section.

### §1.3 Changelog

| Date       | Version    | Author        | Change                                                                                                                                            |
| ---------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-21 | v0.1 DRAFT | Maintainer    | Initial issue, derived from validated research report.                                                                                            |
| 2026-06-24 | v0.1 DRAFT | Maintainer    | Repositioned as a solo, unmonetized experiment (no funding/team/revenue). Raised minimum Node.js 18 → 22 (18 & 20 EOL; 22 is current Active LTS). |
| 2026-06-27 | v0.1 DRAFT | Maintainer    | BRD-feedback sweep: UI-kit terminology (not "design system"), native convention clarifications, M1 issue restructure (19-tool surface, projects-as-peer). |
| _TBD_      | _v0.2_     | _TBD_         | _Placeholder — sponsor-comment integration._                                                                                                      |
| _TBD_      | _v1.0_     | _TBD_         | _Placeholder — Go-decision freeze (locks scope for M0-M5)._                                                                                       |

### §1.4 Distribution list

| Audience                               | Channel                          | Purpose                                 |
| -------------------------------------- | -------------------------------- | --------------------------------------- |
| Sponsor and engineering lead           | Direct circulation               | Decision input                          |
| Designer-in-residence (when recruited) | Onboarding pack                  | Scope orientation                       |
| External advisors                      | Email PDF (`02-brd.docx` export) | Editorial review                        |
| Public OSS audience (post-launch)      | GitHub repository `docs/`        | Transparency on rationale               |
| Anthropic DevRel (cold outreach)       | Direct outreach + PDF            | Trademark posture, optional cooperation |

---

## §2. Executive summary

Anthropic's **Claude Design** — launched **2026-04-17** alongside the Claude Opus 4.7 model and surfaced at `claude.ai/design`, with companion slash-commands `/design` and `/design-sync` inside Claude Code (verified: `anthropic.com/news/claude-design-anthropic-labs`; `claude.com/product/design`) — has set a new bar for AI-assisted UI-kit collaboration. It generates real, on-brand UI components against a code-defined UI kit, lets users adjust elements through inline comments, and round-trips back into a developer's local repository. The marketing language is bold and the experience reportedly excellent, but Claude Design is hosted-only, Pro/Max/Team/Enterprise-gated, browser-bound to a single vendor's chat UI, and exposes no public API. Anthropic has published none of the canvas-side generation prompt, none of the manifest format used to drive its Design System pane, and none of the per-card edit protocol. The richest part of Claude Design is, by deliberate design, opaque to non-Anthropic clients.

That opacity is **also an opening**. The research report establishes the _concepts and techniques_ that make the developer-facing half work — a permission-gated plan→write capability flow, a first-line card marker that lets the server compile a component manifest, a verification-anchor sentinel, an atomic upload sequence — and that the preview surface can be reproduced with a local viewer plus an MCP-Apps `ui://` resource for hosts that render it. genie takes those _ideas_ and implements them with **its own conventions** — its own marker syntax, its own tool names, its own on-disk formats — designed from scratch and improved where possible, not copied from Anthropic's. The blocker is **non-technical**: there is no shortcut for designing a good generation prompt and per-element artifact format. Everything else is reachable from the open ecosystem.

**genie** is an independent, open-source build of that developer-facing experience. It will:

1. Ship a single, MIT-licensed **TypeScript MCP server** providing a file-flow tool surface (a permission-gated plan→write capability model plus read/list/validate verbs) built with genie's own naming and schemas, validated against the Tier-0 universal harness set (Claude Code · Claude Desktop · Codex CLI · GitHub Copilot in VS Code agent mode · Cursor · Cline · Continue.dev).
2. Route all model traffic through a configurable **OpenAI-compatible LLM endpoint** — so operators get per-key budgets, observability, and full model-choice flexibility. This can be a direct provider (Anthropic, OpenAI, Google, a local Ollama install) or a gateway/proxy in front of several (LiteLLM, OpenRouter, or similar). genie itself is provider-agnostic; it only requires an OpenAI-compatible `chat/completions` surface and a configurable base URL + key.
3. Distribute the preview pane in three formats from a single artifact set: `file://` (works for everyone), `http://localhost:5173` (Vite-backed live viewer, HMR-enabled), and `ui://genie/grid` (MCP-Apps payload for Claude · VS Code Stable Jan 2026 · ChatGPT · Cursor).
4. Operate against a **git-backed component store** — local filesystem for solo developers, any git host (self-hosted or cloud — GitHub, GitLab, Gitea/Forgejo, etc.) for shared teams. A "project" becomes a real git repo where `planId == branch`, a write == a commit, and merge == publish.

**Three outcomes that would tell us the experiment worked, over a 12-month horizon:**

- **Provider optionality, observably.**
  - The win is not "spend less on Anthropic" — routing `conjure` through LiteLLM can just as easily _increase_ per-token Anthropic spend.
  - The win is **control and choice**: per-key budgets, full observability, and the ability to swap providers freely — Sonnet for quality, a local Ollama/Qwen3-Coder model for cheap or free refines, Opus only for the hard problems.
  - For a solo operator on local hardware, the marginal cost of a generation can approach zero.
  - That optionality is the thesis.
- **A real productivity lift, honestly measured.**
  - Does the viewer's tight HMR loop plus `conjure` / `refine` actually make component authoring faster?
  - Measured as an honest **n=1 case study** (the maintainer's own before/after), not a funded multi-designer pilot.
  - If it doesn't help one person, it won't help a team.
- **A signal on whether MCP-Apps matter.**
  - The core question behind the whole experiment: do people find rich UI rendered _inside_ their coding harness useful enough to adopt?
  - Stars, forks, issues, and real installs are the proxy.
  - Modest organic traction (not a 1000-star vanity target) is enough signal to answer "keep going / fold / try the next idea."

**Resourcing is the honest part:** this is **one person plus AI coding agents**, working in spare time. There is no FTE budget and no hire. Hardware is already paid for — existing self-hosted hardware running the model gateway, git host, and test harnesses has marginal cost effectively zero. The only real cash is bounded LLM spend (~$200 over the build) and a domain. The "cost" of the project is mostly evenings, and the deliverable is an owned, MIT-licensed asset and the learning of whether this category is worth more of that time.

The recommendation, summarized: **build M0-M5 as a personal experiment, keep Tier-2 (Storybook adapter, marketplace publication) parked until there's a reason.** This BRD captures the rationale; the PRD captures the features; the Tech Design / RFC captures the architecture. The bet is small precisely because it's solo and AI-assisted — the question is whether the _category_ (open MCP servers + MCP-Apps UI for design tooling) is real, in an ecosystem that is — per the research report's exhaustive registry search — currently **greenfield**: no canonical Storybook MCP exists, no incumbent UI-kit MCP server has emerged, and the prior art (Framelink/Figma-Context-MCP, shadcn-ui-mcp-server, ui-design-to-code-mcp) maps cleanly to specific reusable skeleton components rather than to a direct competitor.

---

## §3. Business context

### §3.1 The 2026 state of AI-assisted UI development

By mid-2026, AI-assisted UI development has crossed three thresholds that materially change the build-vs-buy calculus for any team designing UI at scale:

1. **Generation quality has crossed the "production-acceptable" line for well-specified components.**
   - Claude Sonnet 4.6, Opus 4.7, GPT-class peers, and even open-weight successors like Qwen3-Coder routinely produce styled, accessible React/Vue/HTML that passes manual review with no human edits when prompted against a real UI kit.
   - The bottleneck is no longer "can the model generate this card variant?" — it is "can the model know my design tokens, my naming conventions, my a11y standards, and my preferred composition patterns well enough to be a useful collaborator?"
2. **The Model Context Protocol (MCP) has become the only cross-vendor substrate for that bottleneck.**
   - Every major AI coding harness in mid-2026 — Claude Code, Claude Desktop, OpenAI Codex CLI, GitHub Copilot's VS Code agent mode, Cursor, Cline, Continue.dev — implements MCP natively.
   - The research report's harness-by-harness matrix (§4 of the report) verifies this against primary documentation.
   - There is no proprietary plugin model with comparable reach.
   - There is no second open spec for tool-use plumbing across this many vendors.
3. **Vendor-hosted design surfaces have begun to bifurcate from the open ecosystem.**
   - Anthropic's Claude Design is the most visible example, but it is one of several: Figma's Dev Mode MCP Server is hosted at `mcp.figma.com/mcp` and prices its write-back-to-canvas behavior on a usage-based model (verified: `help.figma.com/hc/en-us/articles/32132100833559`); OpenAI's Apps SDK turns every approved app into a marketplace asset; the major IDEs ship one-click marketplace installers that resolve to vendor-curated catalogs.
   - Buyers who do not want to be metered, gated, or routed through a single chat client have a small and shrinking shelf of options.

### §3.2 Why Anthropic's Claude Design matters as a benchmark

Claude Design is the most credible exemplar of the next-generation design tool. The research-validated facts:

- Powered by **Claude Opus 4.x** (marketed 4.7; resolves to `claude-opus-4-8`), launched **2026-04-17** (re-verify pre-launch) (`support.claude.com/en/articles/12138966-release-notes`).
- Available in research preview for **Claude Pro, Max, Team, and Enterprise** subscribers; for Enterprise, off by default and an admin must enable it in Organization settings (`anthropic.com/news/claude-design-anthropic-labs`).
- Hosted at **`claude.ai/design`** with two Claude Code slash-commands: `/design-sync` (pull a code-defined UI kit into a Claude Design project) and `/design` (work in the canvas from inside Claude Code) (`claude.com/product/design`, verbatim sentence: "Pull in your design system from Claude Code using /design-sync or work directly in Claude Code with /design.").
- Backed by an MCP tool called **`DesignSync`** whose 12-method schema (read → plan → write/delete) defines a clean capability-grant model: one user-visible permission boundary (`plan`), tightly scoped file writes constrained to the granted glob set.
- The Design System pane's card index is **server-compiled** from each preview HTML's first-line marker `<!-- @dsCard group="…" -->`, validated by a regex confirmed in the on-disk skill source: `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/`. A missing marker raises `[DSCARD_MISSING]` and fails the build.
- The "atomic" upload sequence is non-trivial and load-bearing:
  - write the `_ds_needs_recompile` sentinel first to fence the server's manifest/copy machinery,
  - chunk content writes ≤ 256 files per call,
  - perform deletes,
  - re-arm the sentinel,
  - write `_ds_sync.json` last as the verification anchor.

What this benchmark gives genie is a **reference for the techniques** that make the developer-facing half work — the shape of a permission-gated plan→write flow, the idea of a server-compiled manifest driven by an in-file marker, the atomic-upload ordering that keeps a verification anchor honest. What it withholds is the **canvas-side generation half**: the prompt shape, the per-element artifact format, the inline-comment edit round-trip, the per-knob adjustment protocol. The research report concludes (with the only "killed" claim across 20 — which on review was a verification-process artifact, not a substantive disconfirmation — see §8.7 of the report's claim ledger) that this canvas half is undocumented anywhere public and would have to be designed from scratch. genie implements equivalent techniques with its own conventions: M0-M5 covers a developer-facing tool surface plus the preview pane plus enough generation tooling to be useful; the canvas-side reimagining is deferred to a post-M5 workstream.

### §3.3 The multi-harness fragmentation problem

A UI kit is a long-lived asset. The teams that maintain one will, over a 24-month horizon, see members move between harnesses — perhaps a designer starts on Claude Code, an engineer prefers Cursor, a contractor uses Codex CLI, a maintainer prefers Cline because of its lightweight footprint, a third-party PR comes in from a Continue.dev user. If the UI-kit tooling lives exclusively in one harness's hosted UI, that movement is friction. If the tooling is harness-agnostic — every team member uses their preferred client, the same MCP server speaks to all of them — the friction collapses to zero.

The seven harnesses that genie targets as Tier-0 universal (text + tool calls work everywhere) are the seven listed in `INDEX.md`: **Claude Code, Claude Desktop, Codex CLI, GitHub Copilot in VS Code agent mode, Cursor, Cline, Continue.dev**. The research report's per-harness matrix (§4) documents the exact config-file shape, transport support, capability surface, and known gotchas for each. The capability tiers (named **Profile A/B/C** to avoid collision with the §6 scope tiers) fall out cleanly:

- **Profile A (every harness)**: tools.
- **Profile B (Claude Code, Cursor, VS Code)**: tools + resources + prompts + elicitation.
- **Profile C (4 first-class: Claude, VS Code Stable Jan 2026, ChatGPT, Cursor; plus 3 ecosystem renderers: Goose, Postman, MCPJam)**: tools + resources + prompts + **MCP-Apps `ui://` HTML rendering**.

genie targets all three profiles from one server binary with progressive enhancement — the same artifact set surfaced three different ways, degrading gracefully to plain text wherever rich rendering is absent. This is the architectural posture that makes "harness-agnostic" a real claim and not marketing fluff: the verified MCP-Apps stable spec (`apps.extensions.modelcontextprotocol.io`, dated 2026-01-26, MIME `text/html;profile=mcp-app`, URI scheme `ui://`, tool→UI link via `_meta.ui.resourceUri`) is one wire format the same server can speak to ≥ 6 hosts simultaneously.

### §3.4 The self-hosting and compliance gap

Buyers with regulatory, residency, or sovereignty constraints — public-sector, healthcare, defense-adjacent, fintech, EU data-residency teams — face an additional pinch: hosted SaaS design tools cannot promise their data stays on-premises. Claude Design's data flow is hosted-only by definition (the canvas surface is `claude.ai/design`). Figma's Dev Mode MCP Server is hosted at `mcp.figma.com/mcp` with a desktop fallback only on Dev or Full seats on paid plans (verified). Open-WebUI, Cline, Continue.dev, and the local stdio paths through Claude Desktop demonstrate there is real demand for "AI tooling that runs on hardware I control."

genie's posture is **operator-managed at every scale**. The same TypeScript MCP server binary that runs on a developer's laptop also runs on a NAS Docker app, an EC2/Hetzner VM, a Kubernetes Deployment, an air-gapped server with a local Ollama backend. Because genie speaks to any OpenAI-compatible endpoint, the operator can point it at local Ollama, Anthropic/OpenAI/Google, or a gateway like LiteLLM or OpenRouter — their choice. The viewer is a vanilla Vite dev server that can serve under `file://`, `http://localhost`, or behind an internal reverse proxy. The component store is git, so existing self-hosted Git infrastructure (Gitea, Forgejo, GitLab CE, GitHub Enterprise) covers it. There are no telemetry calls home unless the operator opts in. There is no SaaS dependency the operator has not signed off on.

### §3.5 Why now

Three near-term temporal anchors push the calendar:

- **VS Code MCP-Apps in Stable, January 2026 milestone**, verified via `microsoft/vscode#260218` (closed, milestone January 2026, `insiders-released` label).
  - This was the largest swing-state in the harness matrix and it is now firmly on the supported side.
  - The MCP-Apps rendering path genie targets has gone from "Claude-only with an experimental ChatGPT path" to "supported in stable VS Code, Claude, ChatGPT, Cursor, Goose, Postman, MCPJam" inside one quarter.
  - Shipping after that wave but before MCP-Apps becomes table-stakes is the optimal window.
- **The seven-harness matrix is now stable**.
  - As of 2026-06-21, all seven Tier-0 harnesses have shipped a current MCP stable surface (Claude Code 2.x, Claude Desktop quickstart-stable, Codex CLI stable, VS Code 1.102 GA, Cursor, Cline, Continue.dev).
  - Any one of them changing materially would invalidate a config snippet but not the architecture; the floor underneath us is the most solid it has been since MCP became a standard.
- **No incumbent open UI-kit MCP exists**.
  - The research report's exhaustive search of the MCP Registry returned zero canonical Storybook MCPs and zero direct competitors for the UI-kit slot.
  - The closest prior art — Framelink's `Figma-Context-MCP` (15.2k★, MIT, scaffolding take), `shadcn-ui-mcp-server` (2.8k★, MIT, distribution take), `21st-dev/magic-mcp` (5.2k★, MIT, slash-command UX take), `ui-design-to-code-mcp` (IR-pipeline take), `Kinglions/ui-design-to-code-mcp` (cross-platform codegen take) — covers adjacent surfaces rather than overlapping with genie's footprint.
  - Greenfield is rare and brief; greenfield in a category Anthropic itself just legitimized is rarer.

That window argues for funding the build now, not later.

---

## §4. Business objectives

The objectives below are what the maintainer is steering toward — not commitments to a sponsor (there isn't one). Each combines a target, a value lens, the owner (the maintainer, in some mode), a measurement, and a target date. Anchor T+0 is the date the maintainer commits spare time to the build. Targets are deliberately soft: this is an experiment measuring signal, not a funded product hitting committed numbers. Six objectives cover the M0-M5 horizon, two extend into the post-launch year.

| #    | Objective                                                                                                                                                                                                                           | Business value                                                                                                                                                                                      | Owner      | Measurement                                                                                                                                                | Target date             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| BO-1 | **Ship MIT-licensed, harness-agnostic MCP server reaching Tier-0 functional parity with genie's 19-tool M1 native surface.**                                                                                                          | Establishes a credible open implementation of the developer-facing design-generation experience; floors the cost of switching off any single hosted vendor at "rerun your existing scripts."        | Maintainer | All M1 tools implemented + integration-tested against ≥ 1 exemplar UI kit and project.                                                                      | T+8 weeks (end of M2)   |
| BO-2 | **Demonstrate provider optionality with full spend observability** — generation routed through a configured OpenAI-compatible endpoint with per-key budgets, swappable between hosted (Sonnet/Opus) and local (Ollama/Qwen) models. | The real value is _control and choice_, not a guaranteed Anthropic-bill reduction (routing per-token can cut _or_ raise spend). Local-model routing can drive marginal generation cost toward zero. | Maintainer | Documented working config for ≥ 2 hosted + ≥ 1 local provider; endpoint-supported usage data shows per-key budget + usage attribution for `genie` traffic. | T+12 months             |
| BO-3 | **Show a real component-authoring speedup, honestly measured (n=1).**                                                                                                                                                               | The productivity question, answered for one person before claiming it for teams: does the HMR loop + `conjure`/`refine` actually make authoring faster?                                             | Maintainer | An honest before/after case study (maintainer's own authoring time, unaided vs with genie) published in the docs. No multi-designer pilot is claimed.      | T+16 weeks              |
| BO-4 | **Earn modest organic traction as a usable open tool** — enough signal to judge whether MCP-Apps are a category worth pursuing.                                                                                                     | Strategic learning, not a vanity metric. Stars/forks/issues/installs are the proxy for "do people find this useful?" The number matters less than the _signal_.                                     | Maintainer | Listed in `awesome-mcp` / `mcp.so`; some organic stars, forks, and real-user issues (not a hard 1000-star target); ≥ 1 unsolicited third-party mention.    | T+12 months             |
| BO-5 | **Validate 7/7 Tier-0 universal harnesses with documented config snippets and end-to-end smoke tests.**                                                                                                                             | Concrete demonstration of the "harness-agnostic" claim; removes plausible deniability for "well, it doesn't really work outside Claude."                                                            | Maintainer | Per-harness smoke-test pass + screenshot + config snippet in README, all green.                                                                            | T+11 weeks (end of M5)  |
| BO-6 | **Land ≥ 1 unsolicited third-party contribution** (a merged PR or a substantive issue not authored by the maintainer) in the first 6 months post-launch.                                                                            | A light health signal: did the project reach anyone? A solo experiment doesn't _need_ contributors, but one external PR is evidence it's discoverable and not hostile to work with.                 | Maintainer | Count of merged PRs / substantive issues whose authors are not the maintainer.                                                                             | T+24 weeks post-launch  |
| BO-7 | **Publish a hardened, auditable `.mcpb` Claude Desktop bundle** + Docker image + npm package on launch day.                                                                                                                         | Distribution-matrix completeness — eliminates "but I can't install it" friction for the three install paths that cover ≥ 95 % of MCP users.                                                         | Maintainer | All three artifacts published, signed where possible, install verified on a fresh machine.                                                                 | T+12 weeks (launch day) |
| BO-8 | **Establish a defensible trademark and license posture** — a generic-word name, clean-room engineering, no Anthropic IP verbatim.                                                                                                   | Risk reduction; pre-empts the most plausible legal complaint by being clean-room and clearly delineated.                                                                                            | Maintainer | Trademark reasoning documented (§12.5); optional friendly-counsel memo; README disclaimer in place; no Anthropic IP verbatim in code or docs.              | T+10 weeks (pre-launch) |

These objectives roll up into the §5 KPI grid and into the §15 Go/No-Go criteria; failure to track any one is a yellow flag, failure to deliver any of BO-1, BO-5, BO-7 is a red flag.

---

## §5. Success metrics & KPIs

The KPI grid is split into leading indicators (predict eventual outcome health) and lagging indicators (record actual outcome). Baseline is 0 in almost every cell because the product does not exist yet; the 90-day target is the launch-month exit number; the 1-year target is the 12-month rolling figure. Owners line up with §7 stakeholders.

| #    | KPI                                          | Definition                                                                       | Formula / source                   | Baseline                      | 90-day target                               | 1-year target                                  | Owner      | Data source                   |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------- | ------------------------------------------- | ---------------------------------------------- | ---------- | ----------------------------- |
| K-01 | Tool-surface coverage                        | % of planned file-flow tools implemented and integration-tested                  | implemented / planned × 100        | 0 %                           | 100 %                                       | 100 %                                          | Maintainer | CI matrix                     |
| K-02 | Harness pass rate                            | % of 7 Tier-0 harnesses with green smoke test in CI                              | green / 7 × 100                    | 0 %                           | 100 %                                       | 100 %                                          | Maintainer | CI artifact, GitHub Actions   |
| K-03 | Tier-2 host coverage                         | Count of MCP-Apps hosts where `ui://genie/grid` renders inline                   | manual probe matrix                | 0                             | 4 (Claude, VS Code Stable, ChatGPT, Cursor) | 6+ (add Goose, Postman, MCPJam)                | Maintainer | Manual quarterly verification |
| K-04 | Component-authoring speedup (n=1 case study) | Maintainer's authoring time per accepted component, unaided vs with genie        | git log + maintainer time-tracking | maintainer's unaided baseline | measurable speedup                          | speedup sustained across a real kit            | Maintainer | Case-study log                |
| K-05 | LiteLLM-attributed gateway throughput        | LiteLLM-recorded calls tagged `genie` per week                                   | LiteLLM metrics                    | 0                             | meaningful real usage                       | sustained real usage                           | Maintainer | LiteLLM dashboard             |
| K-06 | Provider optionality (verified configs)      | Count of working provider configs (hosted + local) with budget+usage attribution | manual + LiteLLM dashboard         | 0                             | ≥ 2 hosted + 1 local                        | ≥ 3 providers, local-default option documented | Maintainer | LiteLLM dashboard             |
| K-07 | GitHub stars (signal, not target)            | Public repo stargazer count — read as adoption _signal_, not a goal              | GitHub API                         | 0                             | some organic stars                          | organic growth (no hard target)                | Maintainer | GitHub API                    |
| K-08 | External contributions                       | PRs / substantive issues not authored by the maintainer                          | git log analysis                   | 0                             | ≥ 1                                         | a few                                          | Maintainer | git log                       |
| K-09 | Real-user signal                             | Distinct people who installed + reported back (issue, mention, message)          | informal                           | 0                             | a handful                                   | a small active circle                          | Maintainer | GitHub / informal             |
| K-10 | Time-to-first-component-on-fresh-install     | Median seconds from `npx genie init` to first `conjure` returning HTML           | telemetry opt-in                   | n/a                           | < 180 s                                     | < 90 s                                         | Maintainer | Opt-in telemetry              |
| K-11 | P50 / P95 `conjure` latency                  | Median and 95th-percentile end-to-end ms                                         | LiteLLM trace + server log         | n/a                           | P50 < 8 s, P95 < 20 s                       | P50 < 5 s, P95 < 12 s                          | Maintainer | LiteLLM + server telemetry    |
| K-12 | Card-marker validator pass rate              | % of generated previews passing genie's first-line marker check                  | server log                         | n/a                           | 99.5 %                                      | 99.9 %                                         | Maintainer | CI + production log           |
| K-13 | Documentation-completeness score             | (sections-complete / sections-required) × 100, per doc-checklist                 | manual review                      | 30 % (this BRD draft only)    | 90 %                                        | 100 %                                          | Maintainer | Doc audit                     |
| K-14 | Security incident count                      | Distinct security incidents requiring an advisory or patch                       | issue tracker label `security`     | 0                             | 0                                           | ≤ 1 (with clean resolution)                    | Maintainer | GHSA                          |
| K-15 | Would-recommend signal                       | Informal: do real users say they'd recommend genie?                              | informal feedback                  | n/a                           | net-positive informal feedback              | net-positive                                   | Maintainer | Informal                      |

K-01, K-02, K-12 are **leading** indicators of build health; K-05, K-06, K-10, K-11 are **leading** indicators of usefulness; K-04, K-07, K-08, K-09, K-15 are **lagging** signals of whether anyone finds it useful (the core experiment question); K-13, K-14 are project hygiene. K-03 sits between — Tier-2 host coverage tells us whether the rich-rendering bet is paying off but only confirms after launch. Targets are deliberately soft: this is a personal experiment measuring _signal_, not a funded product hitting committed numbers.

A lightweight KPI dashboard (aggregated from the LLM endpoint's usage metrics + GitHub API + manual notes) is maintained by the owner — monthly until M5, quarterly thereafter. The specific stack is the maintainer's own; genie does not require any particular metrics backend.

---

## §6. Scope

The scope statement is the most consequential paragraph in this BRD — it draws the bright lines for the build and for what we will politely refuse. Three explicit lists.

### §6.1 In scope — M0-M5 deliverables

1. A **TypeScript MCP server** built on `@modelcontextprotocol/sdk`, Node ≥ 22, ESM-only, distributed as:
   - npm package `genie`,
   - Docker image,
   - `.mcpb` Claude Desktop bundle.
2. A **file-flow tool surface** built with genie's own naming and JSON schemas: a permission-gated plan→write capability model (one user-visible grant before any write; writes scoped to the granted set), plus read/list/get/validate verbs and the genie-specific `conjure`, `refine`, `preview`, `validate`. Exact tool names and shapes are settled in the PRD/RFC, not inherited from any other product.
3. **Configurable OpenAI-compatible LLM integration** via a base-URL + key the operator sets. Works against a direct provider (Anthropic, OpenAI, Google, local Ollama) or a gateway/proxy (LiteLLM, OpenRouter, etc.). Ships with a sensible default model and named aliases the operator can remap. No specific provider or gateway is required.
4. **Git-backed component store** with two backends: local FS for solo developers (default), and any git host (GitHub, GitLab, Gitea/Forgejo — self-hosted or cloud) for shared teams. Project ↔ repo, planId ↔ branch, write ↔ commit, merge ↔ publish.
5. **Card-marker validator and manifest compiler** — genie defines its own first-line marker convention (syntax settled in the RFC); the server compiles a component `manifest.json` on every write that touches a preview file, rejecting files missing the marker.
6. **Vite-backed preview viewer** (`@genie/viewer`) shipping as `npx genie-viewer <kit-path>`, with chokidar HMR, iframe grid layout, viewport buttons, `file://` fallback.
7. **MCP-Apps `ui://genie/grid` resource** registered with MIME `text/html;profile=mcp-app`, manifest inlined as `<script type="application/json">` for sandboxed-iframe compatibility, surfaced via `_meta.ui.resourceUri` on `preview`.
8. **Auth surface**:
   - OAuth 2.0 with Dynamic Client Registration (for Claude Code, Codex CLI, Cursor),
   - static `Authorization: Bearer` header fallback (for VS Code, Cline, Continue.dev),
   - local stdio (for Claude Desktop).
9. **Smoke-test matrix** covering all 7 Tier-0 universal harnesses, capturing screenshots into `docs/screenshots/` and per-harness config snippets into `README.md`.
10. **Documentation set**: this BRD, the Product Vision, the PRD, the Tech Design / RFC, the GitHub roadmap, the GTM + post-prod doc, the operations runbook — all in `docs/` and shipped with the repo.
11. **Operational support**: GitHub issue templates, label taxonomy, milestone setup, contributor guide, code of conduct.

### §6.2 Out of scope — explicitly will not build in M0-M5

1. A **visual canvas editor** with drag-and-drop, marquee selection, inline comment threads, per-element knobs — this is Anthropic's hosted Claude Design surface and there is no public spec for the prompt shape or edit protocol; recreating it is open-ended R&D. Deferred to a post-M5 workstream.
2. A **hosted SaaS gallery**. The viewer runs on the operator's machine or behind their reverse proxy. We do not run a hosted instance for users in M0-M5.
3. **Per-seat billing infrastructure**.
   - genie is free, MIT-licensed, and LiteLLM-budget-metered.
   - We do not collect payment from end users.
4. **PII / identity storage**.
   - genie stores no end-user identifying information.
   - Auth tokens transit but are not persisted by the server.
5. **A standalone IDE plugin** for any harness (we ship a server; the harness's existing MCP client connects to it). No VS Code extension, no Cursor extension, no Cline extension.
6. **Native mobile clients**. Mobile is not a target harness in M0-M5.
7. **Real-time multi-user collaboration**. Git's merge model is the conflict-resolution mechanism; we do not ship a CRDT.
8. **Round-trip interop with other design tools.**
   - genie uses its own conventions and does not target compatibility with `claude.ai/design`, Google Stitch, or any other product's on-disk format in M0-M5.
   - Interop adapters are a possible _future add-on_ (§6.3), not a design constraint now — genie is free to design the best conventions for itself.
9. **Storage backends beyond local FS + git** (S3, Postgres, custom blobstores, MinIO). These are post-M5 community contributions.
10. **Telemetry-by-default**. Opt-in only, and only K-10/K-11 latency anonymous metrics.
11. **Model fine-tuning or hosted training pipelines**. genie uses off-the-shelf models via whatever OpenAI-compatible endpoint the operator configures; we do not train.
12. **Anthropic-IP-verbatim reuse**.
    - We do not embed Anthropic's documentation, system prompts, tool schemas, marker syntax, or other proprietary text.
    - genie's tool names, marker convention, and on-disk formats are its own design — informed by the observable _techniques_, not copied.

### §6.3 Future scope — candidates for post-M5

1. **Storybook adapter** (`--renderer=storybook` flag emitting `*.stories.tsx`). The research report identifies this as a documented greenfield gap.
2. **Shareable preview export** that emits a static site operators can deploy on their own domain.
3. **Figma plugin** that ingests a Figma file via the official Dev Mode MCP Server and emits a genie component library.
4. **Marketplace publication**: Smithery, mcp.so, Cursor marketplace, Cline marketplace.
5. **Canvas-side generation prototype** — the open R&D workstream parked from M0-M5.
6. **Per-component diff visualization** in the viewer (split-pane before/after).
7. **MCP-Apps interactive widgets** beyond the static grid (controls inside the iframe to mutate components live).
8. **Interop adapters** — optional import/export bridges to other design tools' formats (e.g. Claude Design round-trip if Anthropic publishes an ingest API, or Google Stitch), built as add-ons on top of genie's own conventions. Only if a real user need emerges; genie's native format stays primary.
10. **Enterprise SCIM/SSO integration** for orgs running their own genie instance behind an OIDC provider.
11. **CRDT-based real-time co-editing** in the viewer (likely Yjs- or Automerge-backed).
12. **A11y audit tool** that runs axe-core against each `preview.html` and surfaces findings as a card-level badge.

---

## §7. Stakeholders & RACI

> **Reality check.** This is a one-person project. The roles below are _hats the
> maintainer wears_ (with AI coding agents doing much of the Engineering-Lead-level
> mechanical work under the maintainer's review), not a staffed org. They are listed
> separately because the _responsibilities_ are real and worth tracking even when one
> human holds all of them — but read every "owner" as "the maintainer, in that mode,"
> unless and until a genuine contributor steps in. "Time commitment" columns describe
> the shape of the work, not a payroll allocation.

### §7.1 Roles (hats, not headcount)

| Role / hat                  | Description                                                                                                                                                                         | Who holds it                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Maintainer**              | Owns everything: business case, architecture, scope, sequencing, CI, releases. Signs the RFC. Ratifies Go/No-Go (self-sponsored).                                                   | The document owner              |
| **AI coding agents**        | Do the bulk of mechanical implementation (boilerplate, tests, per-issue PRs) under the maintainer's review and the SDLC in `AGENTS.md`. The parallelism a solo dev otherwise lacks. | Claude / Codex / Copilot agents |
| **Designer (hat)**          | Exemplar component libraries, viewer UX critique. Maintainer-with-AI, or community contribution.                                                                                    | Maintainer / community          |
| **Security reviewer (hat)** | Threat-model thinking; auth, sandboxing, supply-chain. Peer review welcome from anyone with MCP-security context.                                                                   | Maintainer / volunteer          |
| **Legal reviewer (hat)**    | License + trademark posture. Optional friendly-counsel memo (§13.1).                                                                                                                | Maintainer / optional counsel   |
| **Community (post-launch)** | Triage, PR review, Discussions stewardship — _if and when_ the project attracts contributors. Aspirational, not staffed.                                                            | Future contributors             |
| **Beta users**              | First handful of people who run genie against real component libraries and report back.                                                                                             | Self-organized, if they appear  |

### §7.2 Responsibility map

Since one human (plus AI agents) holds every hat, a full RACI matrix would be theater — every "A" is the maintainer. What's actually worth tracking is _which mode each workstream runs in_ and where AI agents carry the load vs. where the maintainer must own the judgment. R = does the work · ✔ = maintainer owns the call.

| Workstream                                     | Maintainer | AI agents     | Mode / note                                                |
| ---------------------------------------------- | ---------- | ------------- | ---------------------------------------------------------- |
| BRD / PRD / RFC                                | ✔ R        | drafting help | Maintainer owns the thinking; agents help draft.           |
| MCP server core (M0-M2)                        | ✔          | R             | Agents implement per-issue under review (`AGENTS.md`).     |
| Card-marker validator + manifest compiler (M3) | ✔          | R             | Same.                                                      |
| Preview viewer (M4)                            | ✔          | R             | Maintainer owns the design-identity calls; agents build.   |
| Auth + OAuth + distribution (M5)               | ✔ R        | partial       | The judgment-heavy swamp; maintainer leads, agents assist. |
| `.mcpb` / npm / Docker packaging               | ✔          | R             | Mechanical; agent-friendly.                                |
| Smoke tests across 7 harnesses                 | ✔          | R             | Agents run/iterate; maintainer verifies green.             |
| Documentation set                              | ✔          | R             | Agents draft; maintainer edits for voice + truth.          |
| Exemplar component library                     | ✔          | R             | Maintainer-with-AI, or community.                          |
| License + trademark posture                    | ✔ R        | —             | Maintainer's call; optional friendly counsel.              |
| Security thinking                              | ✔          | review help   | Maintainer owns; peer review welcome from anyone.          |
| Community / triage (post-launch)               | ✔          | —             | Only matters if contributors appear.                       |

The matrix collapses to one accountable human wearing every hat, with AI agents doing the bulk of implementation under review. There is no separate sponsor: the maintainer self-sponsors. The point of keeping the columns is to remember _which mode_ the work is in (build vs. security-thinking vs. legal-thinking), not to imply a staffed team.

---

## §8. Assumptions

The build plan rests on the assumptions below. Each carries a severity (**critical** = falsification kills the project; **major** = forces material scope/timeline change; **minor** = forces a small adjustment) and an explicit "what falsifies it" note so the team can recheck during quarterly reviews.

| #     | Assumption                                                                                                                                                                                                                                                                    | Severity     | What falsifies it                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AS-1  | The MCP spec remains stable enough through 2026 that a server built in Q3 2026 will still validate against the harness MCP clients shipped through Q2 2027 without breaking changes.                                                                                          | **Critical** | Any of the 7 Tier-0 harnesses ships a breaking-change MCP client update that requires server-side rework beyond patch-level adjustments.                  |
| AS-2  | A configurable OpenAI-compatible LLM endpoint (direct provider or gateway) is available to the operator and exposes a stable `chat/completions` API.                                                                                                                          | **Critical** | No OpenAI-compatible endpoint is reachable, or the contract changes such that generation breaks.                                                          |
| AS-3  | Anthropic does not pursue trademark or copyright action against an independent MIT-licensed implementation whose name does not include "Claude," "Anthropic," "DesignSync," "Claude Design," or similar protected marks.                                                                 | **Critical** | Cease-and-desist letter, takedown demand, or DMCA strike.                                                                                                 |
| AS-4  | genie's own marker convention, tool names, and on-disk formats (designed from scratch, informed by observable _techniques_ only) are not derivative of any other product's protected IP.                                                                                      | Minor        | Legal counsel finds a specific element too close to a protected work; we adjust that element.                                                             |
| AS-5  | A solo maintainer working spare-time with AI coding agents can deliver M0-M5 on the committed build plan. The "12 days focused work" figure is an **engineering-hours floor (best case)**, not a schedule; the calendar is elastic and the project ships when it ships. | **Major**    | The work stalls for a sustained stretch (weeks) with no progress, or a milestone reveals the scope is materially larger than the floor estimate assumed.  |
| AS-6  | Existing self-hosted hardware running the model gateway, git host, the Vite test viewer, and the smoke-test harnesses stays operational with marginal cost effectively zero.                                                                                                                          | Major        | Self-hosted hardware failure, ISP outage > 1 week, or unanticipated infrastructure spend.                                                                     |
| AS-7  | The Tier-0 universal harness set will not contract — i.e., none of Claude Code, Claude Desktop, Codex CLI, GitHub Copilot (VS Code agent mode), Cursor, Cline, or Continue.dev will shut down inside the 12-week build window.                                                | Minor        | Any single harness is discontinued; we drop it from the matrix and continue.                                                                              |
| AS-8  | The MCP-Apps stable spec dated 2026-01-26 does not undergo a breaking revision before VS Code Stable lands the rendering path on its January 2026 milestone schedule.                                                                                                         | Major        | Spec revision requires server-side rewrite; we degrade the viewer to non-MCP-Apps mode and continue.                                                      |
| AS-9  | Cursor's historical 40-tool cap (per the research report's open question #11) is either inactive in mid-2026 or non-binding for genie's tool count.                                                                                                                           | Minor        | Tools 41+ silently disabled in Cursor; we shard the tool surface into multiple servers.                                                                   |
| AS-10 | The on-disk `design-sync` bundled skill remains the canonical reference for verb semantics, since Anthropic does not publish a public spec.                                                                                                                                   | Major        | The bundled skill is removed from a Claude Code release and we lose our reference; we freeze genie's API at the last observed shape and document the gap. |
| AS-11 | The maintainer (with AI assistance) can author a small exemplar component library (~12 components: button, input, select, card, modal, table, alert, badge, chip, breadcrumb, navbar, sidebar) to demonstrate the viewer. No designer hire is assumed.                        | Minor        | Fewer exemplars ship by end-of-M5; the rest are labeled community-contribution opportunities.                                                             |
| AS-12 | The open MCP ecosystem will continue to standardize on `@modelcontextprotocol/sdk` as the canonical TypeScript SDK, with no major vendor forking.                                                                                                                             | Major        | A material vendor (Anthropic, OpenAI, Microsoft) ships an incompatible TypeScript SDK; we maintain compatibility shims.                                   |
| AS-13 | The seven-harness config-snippet shapes documented in the research report (`.codex/config.toml`, `~/.claude.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `~/.cline/mcp.json`, `.continue/mcpServers/*.yaml`, `claude_desktop_config.json`) remain valid through Q4 2026.    | Minor        | Per-harness schema change; we update the README snippets within one release cycle.                                                                        |
| AS-14 | The MIT license remains acceptable to all current and future sponsors / contributors; no requirement emerges for a copyleft license.                                                                                                                                          | Minor        | Sponsor or major contributor requires AGPL/LGPL; we relicense forward-only with consent.                                                                  |
| AS-15 | A git host (the maintainer tests against a self-hosted instance; any git backend works) is sufficient as the "shared" store for early adopters who want team mode.                                                                                                            | Minor        | An early adopter needs a backend genie's git layer doesn't yet support; we add it or accept a PR.                                                         |

These assumptions are revisited at the end of each milestone and at every quarterly review. Falsification of a **critical** assumption triggers an immediate stop-and-rethink; falsification of a **major** assumption triggers a scope review; a **minor** one is handled at the maintainer's discretion.

---

## §9. Constraints

Constraints are non-negotiable boundaries we accept. They differ from assumptions in that we choose them deliberately — they are first-class design inputs, not background facts that might or might not hold.

### §9.1 Licensing — MIT, contributor CLA recommended

The project ships under the **MIT license** (per `INDEX.md`). MIT was chosen for maximum compatibility with downstream commercial use, low contributor friction, and alignment with the dominant license choice across MCP servers in the wild (Framelink, shadcn-ui-mcp-server, 21st-dev/magic-mcp, ui-design-to-code-mcp are all MIT, per the research report's prior-art section). A contributor license agreement (CLA) is **recommended** but not made gating in M0-M5; if the project graduates to a foundation or accepts an outside-counsel review, a CLA will be required for all contributors before contributions are merged.

### §9.2 No PII storage

The MCP server is forbidden from persisting personally identifiable information about end users. Auth tokens (OAuth access tokens, static bearer headers) transit through the server but are not written to disk beyond ephemeral memory + standard process-stdio logging. No email addresses, names, IP addresses (beyond stdlib request-log defaults that the operator can scrub), session histories, prompt contents, or generated component payloads are persisted to any storage outside the git-backed component store the operator explicitly chose. The viewer ships no analytics SDK. Telemetry (K-10, K-11) is opt-in only.

### §9.3 No Anthropic IP verbatim

We do not embed Anthropic's documentation, system prompts, internal tool catalog descriptions, marker syntax, file formats, or any other proprietary text into genie's source. genie's **tool names, marker convention, and on-disk formats are its own design** — informed by the observable _techniques_ (a permission-gated plan→write flow, a server-compiled manifest, a verification anchor), not copied from any other product's specific names or schemas. genie deliberately does **not** mirror another tool's verbs or marker syntax verbatim; it picks its own, and improves on them where it can. Any reviewer who finds verbatim third-party-IP text in the codebase has authority to file a `legal:must-redact` issue and it is treated as a must-fix.

### §9.4 No Anthropic API key required

genie must not require an Anthropic API key to operate. A configurable OpenAI-compatible endpoint provides the abstraction: operators can route to Anthropic, OpenAI, Google, Ollama, or any compatible gateway. The default is an operator-mapped `design-default` alias, and the README will document at least three substitutes: `openai/gpt-5o`-class, `ollama/qwen3-coder:32b`-class, and `google/gemini-2.5-pro`-class.

### §9.5 Offline operability for local FS mode

When operating in local FS solo-dev mode, the entire happy path must work **fully offline** except for the model call itself. That means: scaffold a new project, run the plan→write flow, render previews, validate genie's card markers, open the viewer at `file://`, all without an Internet connection. The model call (`conjure`, `refine`) is the single forced network round-trip, and it points at whatever OpenAI-compatible endpoint the operator configured — which can itself be an offline Ollama install on the same machine.

### §9.6 MCP spec compliance — Draft 7 JSON Schema only

For maximum portability across the seven Tier-0 harnesses, all tool input schemas restrict themselves to **JSON Schema Draft 7** primitives. No `anyOf` discriminators, no `$ref` chains, no Draft 2019-09 / Draft 2020-12 vocabulary, no `oneOf` polymorphism. Continue.dev and Cline have unenumerated dialect support; Codex CLI's JSON-schema handling on the tool surface is undocumented beyond examples; this constraint guarantees zero ambiguity. Tool descriptions are capped at 2 KB (Claude's truncation limit) and tool names at 64 chars, `[A-Za-z0-9_-]` only.

### §9.7 Hardware budget — marginal cost

All hosting in M0-M5 is provided by existing self-hosted hardware already running for other purposes. The model gateway, git host, and test harnesses run as Docker apps on the existing stack. Marginal cost for the project is effectively zero in M0-M5; any new hosting need (e.g., a public preview-gallery service) is post-M5 scope and gated by a separate sponsor approval.

### §9.8 Single-maintainer initial bandwidth

The build is deliberately single-maintainer, spare-time, AI-agent-assisted. We assume no other human contributor bandwidth in M0-M5. Issues are written (per `AGENTS.md`) so an AI agent — or an outside contributor, if one appears — can pick one up independently, but the critical path is sized for one person plus agents.

---

## §10. Dependencies

Dependencies split cleanly between **internal** (we own or operate the resource) and **external** (third-party provided). The table lists owner, current version requirement, status, and risk.

### §10.1 Internal dependencies

| #      | Type           | Name                                                                                                                              | Version               | Owner      | Status                    | Risk                                        |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------- | ------------------------- | ------------------------------------------- |
| D-I-01 | Service        | An OpenAI-compatible LLM endpoint for dev/test (the maintainer uses a self-hosted LiteLLM gateway; any provider or gateway works) | any OpenAI-compatible | Maintainer | ✅ Available              | Low — genie is endpoint-agnostic; swappable |
| D-I-02 | Service        | A git host for team-mode dev/test (the maintainer uses a self-hosted instance; GitHub/GitLab/Gitea all work)                      | any git backend       | Maintainer | ⚠️ Provisioned during dev | Low — genie's git layer is host-agnostic    |
| D-I-03 | Infrastructure | Self-hosted server (existing hardware) for app hosting                                                                            | Current               | Maintainer | ✅ Live, healthy          | Low — uptime weeks+                         |
| D-I-04 | Service        | Docker engine on the self-hosted server for app hosting                                                                          | Current               | Maintainer | ✅ Live                   | Low                                         |
| D-I-05 | Network        | Private network access (operator VPN/overlay) for off-LAN gateway access                                                         | Current               | Maintainer | ✅ Live                   | Low                                         |
| D-I-06 | Secret         | LLM gateway API key (operator-provided), kept in the operator's environment                                                      | n/a                   | Maintainer | ✅ Configured             | Low                                         |
| D-I-07 | Project        | `genie` repo on `roshangautam/` (GitHub)                                                                                          | To create in M0       | Maintainer | ⚠️ Not yet created        | Low                                         |

### §10.2 External dependencies

| #      | Type     | Name                                                                                                                                                              | Version                                                                                                                              | Owner                    | Status                                               | Risk                                                |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| D-E-01 | SDK      | `@modelcontextprotocol/sdk` (TypeScript)                                                                                                                          | ≥ latest stable as of T+0                                                                                                            | Anthropic / MCP org      | ✅ Active                                            | Low — actively maintained, broad adoption           |
| D-E-02 | Runtime  | Node.js                                                                                                                                                           | ≥ 18 (LTS), ESM-only                                                                                                                 | Node Foundation          | ✅ Active                                            | Low                                                 |
| D-E-03 | Tool     | Vite                                                                                                                                                              | ≥ 5.x                                                                                                                                | Vite team                | ✅ Active                                            | Low — multi-page HTML entry points are native       |
| D-E-04 | Tool     | esbuild (via Vite)                                                                                                                                                | Vite-bundled                                                                                                                         | esbuild team             | ✅ Active                                            | Low                                                 |
| D-E-05 | Tool     | chokidar (viewer watch loop)                                                                                                                                      | Latest 4.x                                                                                                                           | OSS                      | ✅ Active                                            | Low                                                 |
| D-E-06 | Spec     | MCP-Apps stable                                                                                                                                                   | 2026-01-26                                                                                                                           | modelcontextprotocol org | ✅ Stable                                            | Medium — new stable spec, risk of revision          |
| D-E-07 | Tool     | OpenAI Node client (`openai`) for LiteLLM                                                                                                                         | Latest stable                                                                                                                        | OpenAI                   | ✅ Active                                            | Low — drop-in OpenAI-compatible                     |
| D-E-08 | Tool     | `@modelcontextprotocol/mcpb` (Claude Desktop bundler, formerly `anthropics/dxt`) (re-verify pre-launch) | Latest                                                                                                                               | Anthropic / MCP org      | ✅ Active                                            | Low                                                 |
| D-E-09 | Tool     | `ts-morph` (adherence-rule extraction from `.d.ts`)                                                                                                               | Latest stable                                                                                                                        | OSS                      | ✅ Active                                            | Low                                                 |
| D-E-10 | Tool     | Playwright (preview render-check in CI)                                                                                                                           | Latest stable                                                                                                                        | Microsoft                | ✅ Active                                            | Low                                                 |
| D-E-11 | Spec     | MCP core specification                                                                                                                                            | latest stable                                                                                                                        | modelcontextprotocol org | ✅ Stable                                            | Low — verified per research report §2.1             |
| D-E-12 | Harness  | Claude Code                                                                                                                                                       | 2.1.181+                                                                                                                             | Anthropic                | ✅ Active                                            | Medium — moves fast, watch breaking changes         |
| D-E-13 | Harness  | Claude Desktop                                                                                                                                                    | Current                                                                                                                              | Anthropic                | ✅ Active                                            | Low — quickstart MCP support is stable              |
| D-E-14 | Harness  | Codex CLI                                                                                                                                                         | Current                                                                                                                              | OpenAI                   | ✅ Active                                            | Medium — TOML schema is unique, watch for drift     |
| D-E-15 | Harness  | VS Code Copilot Chat (agent mode)                                                                                                                                 | 1.102+ (GA July 2025), Stable Jan 2026 for MCP-Apps (re-verify pre-launch) | Microsoft                | ✅ GA, MCP-Apps in Stable per January 2026 milestone | Medium — track `microsoft/vscode#260218` follow-ups |
| D-E-16 | Harness  | Cursor                                                                                                                                                            | Current                                                                                                                              | Cursor                   | ✅ Active                                            | Medium — historical 40-tool cap, verify pre-launch  |
| D-E-17 | Harness  | Cline                                                                                                                                                             | Current                                                                                                                              | OSS                      | ✅ Active                                            | Low — tools-only, less moving surface               |
| D-E-18 | Harness  | Continue.dev                                                                                                                                                      | Current                                                                                                                              | OSS                      | ✅ Active                                            | Low — schema requires explicit `type` discriminator |
| D-E-19 | Registry | npm public registry                                                                                                                                               | n/a                                                                                                                                  | npm                      | ✅ Active                                            | Low                                                 |
| D-E-20 | Registry | Docker Hub (or GHCR) for image distribution                                                                                                                       | n/a                                                                                                                                  | Docker / GitHub          | ✅ Active                                            | Low                                                 |

The **medium-risk** items (D-E-06, D-E-12, D-E-14, D-E-15, D-E-16) are tracked in §11 (risk register) with explicit mitigation paths. Nothing rated **high**.

---

## §11. Risk register

Each risk carries a Likelihood × Impact = Score (each on a 1-5 scale), a mitigation, a contingency, an owner, and a review cadence. Sorted by score, descending. Categories: T = technical, M = market, L = legal/IP, O = operational, F = financial, R = reputational.

| #    | Category | Description                                                                                                                                                                      | L   | I   | Score  | Mitigation                                                                                                                                                                                                                                                                                                                        | Contingency                                                                                                                                                 | Owner      | Review cadence                                         |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| R-02 | T        | Canvas-side generation R&D becomes a tempting rabbit-hole despite being out of M0-M5 scope; the maintainer is pulled into it prematurely.                                        | 4   | 4   | **16** | Make scope-cut explicit in BRD §6.2; pre-commit Go/No-Go criteria in §15 that do not require canvas surface; keep canvas explicitly parked as a separate future experiment.                                                                                                                                                       | Defer canvas to a later spare-time cycle; ship M0-M5 as planned.                                                                                            | Maintainer | Monthly                                                |
| R-03 | T        | MCP spec or MCP-Apps spec ships a breaking revision before Q4 2026.                                                                                                              | 3   | 4   | **12** | Pin SDK versions in package.json; subscribe to `modelcontextprotocol/specification` releases; budget 1 week per quarter for spec-tracking.                                                                                                                                                                                        | Pin to last-known-good version; compatibility shim if needed.                                                                                               | Maintainer | Monthly                                                |
| R-04 | T        | One of the 7 Tier-0 harnesses ships a breaking MCP client change.                                                                                                                | 4   | 3   | **12** | Per-harness smoke test in CI; subscribe to release notes; document per-harness config snippet versions.                                                                                                                                                                                                                           | Mark harness as degraded in matrix until fix; ship workaround within 1 week.                                                                                | Maintainer | Weekly (CI signal)                                     |
| R-07 | O        | Solo-maintainer stall — life, day-job crunch, illness, or a hard bug halts the single-threaded critical path with no one to pick it up. **This is the project's defining risk.** | 3   | 4   | **12** | Accept it explicitly: "ships when it ships," no committed launch date (§16, AS-5). AI coding agents provide the _parallelism_ a solo dev otherwise lacks — multiple issues can progress under review at once (`AGENTS.md`). Milestones sized in independently-shippable chunks so a stall never loses more than one unit of work. | Park the project at the last-completed milestone; it's an experiment, not an obligation. Resume when there's appetite, or declare it answered (§15.3 GR-3). | Maintainer | Monthly self-check                                     |
| R-01 | L        | Anthropic asserts a trademark or copyright claim against genie (name, or some convention alleged to be derivative).                                                              | 1   | 5   | **5**  | Generic-word name with no Anthropic marks; genie's tool names / marker / formats are its own design (no verbatim mirroring); document the independent-design reasoning; optional pre-launch legal memo.                                                                                                                           | Adjust the specific element flagged; rename only if the name itself is challenged; engage counsel if needed.                                                | Maintainer | Quarterly + ad-hoc on any communication from Anthropic |
| R-05 | M        | Anthropic ships a first-party self-hostable version of the Claude Design developer surface, undercutting the open project's positioning.                                         | 2   | 5   | **10** | Lean into MIT + harness-agnostic + self-host as differentiators a hosted vendor structurally won't prioritize; cultivate community moats (contributors, exemplar libraries).                                                                                                                                                      | Pivot positioning to "the open one"; offer migration tooling; accept that some attention goes to first-party.                                               | Maintainer | Quarterly                                              |
| R-11 | F        | Maintainer loses motivation or runs out of spare time mid-project.                                                                                                               | 3   | 3   | **9**  | No external funding to lose; deliverables sized in independently-shippable chunks so any stopping point is a real artifact. The §15.3 reality gate makes "park it" an honest, planned outcome.                                                                                                                                    | Ship at last-completed milestone, archive, declare the experiment answered.                                                                                 | Maintainer | Per milestone                                          |
| R-13 | R        | Negative review from a high-reach Twitter/HN account citing missing canvas surface as a deal-breaker.                                                                            | 3   | 3   | **9**  | Lead with honest scope statement; pre-emptively address in launch post; recruit balanced reviewers.                                                                                                                                                                                                                               | Respond publicly; address specific feedback; iterate.                                                                                                       | Maintainer | Weekly post-launch                                     |
| R-06 | T        | The chosen LLM endpoint gateway suffers extended outage or sunset.                                                                                                               | 2   | 4   | **8**  | Document direct-to-provider (Anthropic, OpenAI, Ollama) fallback in README; do not hard-code one gateway in the server.                                                                                                                                                                                                           | Operators reroute to direct provider endpoints; we publish guidance within 24 hours.                                                                        | Maintainer | Quarterly                                              |
| R-15 | O        | The on-disk `design-sync` bundled skill is removed from a Claude Code release, eliminating our reference source.                                                                 | 2   | 4   | **8**  | Snapshot the current source for our own archival reference; document everything we observe; cite primary sources where possible.                                                                                                                                                                                                  | Freeze the verb shape at last-observed state; document the gap; continue.                                                                                   | Maintainer | Per Claude Code release                                |
| R-17 | T        | The `ui://` MCP-Apps fallback fails to render in one or more Tier-2 hosts at launch (Claude Code in particular — research report's open question #8).                            | 4   | 2   | **8**  | Empirical test pre-launch in all 4 advertised hosts; document any host-specific known issues.                                                                                                                                                                                                                                     | Disable the fallback for the affected host; surface as a documented limitation; degrade to viewer URL.                                                      | Maintainer | Pre-launch + monthly                                   |
| R-18 | R        | A community contribution unintentionally introduces a security vulnerability that is exploited before patch.                                                                     | 2   | 4   | **8**  | All PRs require maintainer review; CI runs SCA (Snyk/dependabot); security@ email + GHSA process; published incident-response runbook.                                                                                                                                                                                            | Issue GHSA advisory; release patch within 48 hrs; post-mortem.                                                                                              | Maintainer | Continuous                                             |
| R-08 | M        | The seven-harness Tier-0 list contracts (e.g., Cline acquired and shuttered, Continue.dev sunset).                                                                               | 2   | 3   | **6**  | Track quarterly health checks on each harness; design tests to be removable without breaking core.                                                                                                                                                                                                                                | Drop affected harness from matrix; document gracefully.                                                                                                     | Maintainer | Quarterly                                              |
| R-10 | O        | Self-hosted hardware failure during M0-M5.                                                                                                                                           | 2   | 3   | **6**  | ZFS mirror pools provide hardware redundancy; weekly snapshots; documented rebuild procedure.                                                                                                                                                                                                                                     | Restore from snapshot; degrade gracefully (the build also works without that hardware — local-FS mode is the default).                                            | Maintainer | Continuous (hardware monitoring)                        |
| R-12 | T        | Cursor's historical 40-tool cap is silently enforced in mid-2026, breaking genie in Cursor.                                                                                      | 3   | 2   | **6**  | Pre-launch empirical test with 50+ tools; document tool-sharding fallback.                                                                                                                                                                                                                                                        | Ship multi-server tool-sharding pattern; document.                                                                                                          | Maintainer | M5 verification                                        |
| R-09 | L        | A contributor submits code containing a third-party patent encumbrance.                                                                                                          | 1   | 5   | **5**  | DCO sign-off on PRs; CLA-recommended posture; legal review of any pattern matching known patent claims.                                                                                                                                                                                                                           | Reject PR; remove if merged; legal escalation.                                                                                                              | Maintainer | Per-PR                                                 |
| R-14 | T        | `.mcpb` bundle format changes (the `anthropics/dxt` → `modelcontextprotocol/mcpb` migration in flight).                                                                          | 2   | 2   | **4**  | Track the bundler's stable release; build against current; smoke-test install.                                                                                                                                                                                                                                                    | Republish bundle on new format; document migration.                                                                                                         | Maintainer | Quarterly                                              |
| R-16 | F        | LiteLLM model spend exceeds budget during heavy testing (e.g., generating 1000s of components in CI).                                                                            | 2   | 2   | **4**  | Per-key budgets on LiteLLM keys used by CI; rate-limit middleware; switch CI to Ollama-routed local model for high-volume runs.                                                                                                                                                                                                   | Pause CI; downscale to local model; adjust budgets.                                                                                                         | Maintainer | Monthly LiteLLM dashboard review                       |

**Aggregate risk score: 154** (sum of all 18 risk scores after re-sort). Highest single risk: R-02 (canvas scope creep). The four highest-impact (impact 5) failure modes are R-01, R-05, R-09, R-11 — all mitigated by transparent scoping, milestone-sized commitments, contributor-vetting discipline, and a defensible legal posture.

---

## §12. Regulatory & compliance

### §12.1 Data residency

The default deployment stores **no telemetry**, **no PII**, and **no end-user data** beyond what the operator places in their git-backed component store. The server speaks to whatever LLM endpoint the operator routes it to. Data residency, therefore, is entirely the operator's responsibility — genie is residency-neutral by construction. An operator running genie on a self-hosted server in their own jurisdiction with an Ollama backend on the same hardware has full data sovereignty; an operator routing to a hosted Anthropic endpoint inherits Anthropic's residency posture.

### §12.2 GDPR (and analogous regimes)

Because genie stores no personal data, GDPR-style data-subject obligations do not bite the project itself. The README will include a "GDPR notes" subsection clarifying:

- The MCP server is a **data processor**, not a controller, in any pipeline an operator builds with it.
- Operators routing to a hosted LLM provider must satisfy themselves of the provider's GDPR posture.
- The opt-in telemetry (K-10, K-11) collects anonymous latency metrics only and is documented as such in `docs/telemetry.md`.

If an operator deploys genie in a GDPR-bound context (an EU enterprise, a healthcare provider, etc.), the operator becomes the controller for any PII their system handles, and genie offers no impediment to their compliance posture.

### §12.3 AI Act and analogous AI-specific regimes

The EU AI Act and analogous regimes classify systems by risk. A UI-kit MCP server that generates UI components against a user's UI kit is unambiguously a **limited-risk** AI system at most: no biometric data, no decision-making about humans, no critical-infrastructure adjacency. Disclosure of AI-generated content (a likely Article 50-style obligation) is handled by README documentation and by the fact that generated components are explicitly opt-in committed to the operator's repo. Operators bear the obligation to attribute and disclose downstream.

### §12.4 Licensing posture

**MIT** (per `INDEX.md`). The license file ships in the repo root. All contributors agree implicitly via the GitHub "Inbound = Outbound" model unless they have signed a separate CLA. A CLA is **recommended** for the project's first 12 months; if a graduate-to-foundation conversation materializes, the CLA becomes required. The license posture is reviewed annually.

### §12.5 Trademark posture re Anthropic

The project name **genie** is a strong position by construction:

- **It is a generic English word.**
  - "genie" is common vocabulary with no derivation from "DesignSync," "Claude," "Claude Design," or any Anthropic mark.
  - It is evocative (a genie grants wishes; you describe a component and it appears) rather than referential.
  - Generic, pre-existing words are about the hardest names to attack on trademark grounds.
- **It contains no Anthropic mark.**
  - "Claude" and "Anthropic" appear nowhere in the name, the npm package, the Docker image, or the repository (`roshangautam/genie`).
  - genie does not present itself as an official Anthropic surface, and the README names Claude Design as _inspiration_, not as something genie reproduces or affiliates with.
- **The positioning is "independent open-source tool," not "hosted-product reproduction."**
  - genie is its own thing that happens to speak a compatible protocol — the way many tools speak HTTP or implement POSIX without inheriting another product's identity.
  - The README and docs describe what genie _does_, not what it copies.

A pre-launch legal memo (see §15 Go/No-Go criterion G-7) will document the clean-room engineering of the developer-facing surface, the absence of any verbatim Anthropic IP, and the descriptive use of a generic name.

### §12.6 Own-conventions posture (not verbatim mirroring)

genie deliberately does **not** mirror another product's verb names, marker syntax, or file formats verbatim. It designs its own — informed only by the observable _techniques_ (the patterns that make the developer-facing flow work), not by any specific names or schemas. This is both a product choice (freedom to design better conventions, and to improve on the inspiration) and the **strongest possible legal posture**:

1. **Nothing is copied.**
   - genie's tool names, marker convention, and on-disk formats are original.
   - There is no transliteration of another vendor's API surface, so the "is this a derivative work?" question barely arises.
2. **The underlying techniques are not protectable.** A permission-gated plan→write flow, a server-compiled manifest, an in-file marker, an atomic write sequence — these are general engineering patterns (like REST verbs, or POSIX file semantics), free for anyone to implement.
3. **Independent, not interoperable-by-default.**
   - genie does not claim or target round-trip compatibility with `claude.ai/design`.
   - Any future interop (Claude Design, Google Stitch, etc.) would be an _optional adapter_ built on top of genie's own format (§6.3), not a verbatim shared protocol.

The optional legal memo (§15 G-7) documents this reasoning. Because genie copies nothing and claims no compatibility, the trademark/IP exposure is minimal by construction.

---

## §13. Cost reality

> This is a solo, AI-assisted, unmonetized experiment. There is no FTE budget, no
> hire, and no revenue plan. The numbers below are the _actual cash_ the project
> touches, plus an honest note on the real cost (time). The funded-team financial
> model that an enterprise BRD would carry here does not apply and has been removed.

### §13.1 Actual cash cost

| Cost category                                                   | M0-M5 (~12 weeks) | Year 1              | Notes                                                                                                                          |
| --------------------------------------------------------------- | ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Engineering labor                                               | **$0 cash**       | **$0 cash**         | Solo maintainer + AI coding agents, spare time. Paid in evenings, not dollars.                                                 |
| Designer                                                        | $0                | $0                  | No designer-in-residence. Exemplar components authored by the maintainer with AI assistance, or contributed by the community.  |
| Hosting (LLM endpoint gateway, git host, viewer test instances) | $0                | $0                  | Runs on existing self-hosted hardware; marginal cost effectively zero.                                                              |
| LLM model spend (dev + CI, via configured endpoint)             | ~$200             | ~$1,500             | Bounded by per-key budgets where the endpoint supports them. Can drop toward $0 by routing CI/refines to a local Ollama model. |
| Domain + DNS                                                    | ~$20              | ~$20                | One-time + renewal.                                                                                                            |
| Tooling (GitHub Free, Dependabot, Snyk OSS)                     | $0                | $0                  | All free tiers.                                                                                                                |
| Legal memo (optional, friendly counsel)                         | $0–$1,500         | —                   | Only if the maintainer decides a written memo is worth it; the trademark posture (§12.5) is strong without one.                |
| **Total real cash**                                             | **≈ $220–$1,720** | **≈ $1,500–$3,000** | The project is, in cash terms, nearly free.                                                                                    |

The honest headline: **this costs almost no money.** The only meaningful resource is the maintainer's time, and that time is spare time, not foregone billings.

### §13.2 The real cost is time, not money

The one thing the project genuinely spends is the maintainer's evenings and weekends. This is **not** billable time being given up — it is discretionary builder time that would otherwise go to other side projects or learning. The opportunity-cost question is therefore not "is this worth $48k of foregone contract income?" (it isn't that), but the much smaller and more honest one: **is this the most interesting thing to build with spare hours right now, versus the other ideas in the backlog?**

That reframing is the whole financial case. Because the cash cost is near-zero and the time is discretionary, the bar for "worth doing" is low: the project only has to teach the maintainer something useful about whether MCP-Apps are a real category — and produce an owned, MIT-licensed asset along the way — to clear it.

### §13.3 Monetization: none planned

genie is not monetized and there are no plans to monetize it. No donations tier, no paid support tier, no paid seats, and no managed gallery service. If the experiment surfaces something genuinely valuable, monetization can be reconsidered as a _separate_ decision later — but it is explicitly out of scope and out of intent for this project. The value sought here is **learning and optionality on future ideas**, not revenue.

The financial decision is: **is +intangibles worth $50-70k?** This BRD argues yes, on the grounds that maintainer reputation, ecosystem positioning, and the option value of any of the post-M5 commercial paths (Scenario 4, or acquisition, or sponsorship) collectively exceed that figure.

---

## §14. Resourcing

There is no funding ask. genie is built by **one person plus AI coding agents**, in spare time, on hardware that's already paid for. Stated plainly:

1. **The maintainer** (this document's owner) does the design, architecture, and implementation, with AI agents handling the bulk of the mechanical coding under review. M0-M5 per the milestone definitions in §16. The constraint is calendar/attention, not money or headcount.
2. **No designer hire.** Exemplar component libraries are authored by the maintainer with AI assistance, or contributed by the community post-launch. The "starter kit" is a nice-to-have, not a funded deliverable (see §13.1, BO-3 reframed to an honest n=1 case study).
3. **Cash outlay** is bounded LLM spend (~$200 over the build) plus a domain — see §13.1. No tooling budget, no labor budget, no post-launch maintenance budget to approve.

What the project produces:

- A complete, MIT-licensed, harness-agnostic open implementation of the developer-facing design-generation experience, with all 12 file-flow verbs.
- A working preview viewer, packaged three ways (`file://`, `http://localhost`, `ui://`).
- 7 documented and smoke-tested Tier-0 harness integrations.
- An exemplar component library demonstrating the viewer's value (maintainer- or community-built).
- A complete documentation set (this BRD + Vision + PRD + Tech Design + Roadmap + GTM + Runbook).
- A public, owned, MIT-licensed asset in a greenfield category.
- An honest answer to the real question: **are MCP-Apps a category worth more of my time?** — and the muscle to build the next idea if they are.

---

## §15. Go/No-go criteria

> Legend: **T+0 = BRD ratification date** (the gate clocks below count from this anchor).

Eight to ten gates that must be true at T+0 to start the build, and at T+12 weeks to declare M5 done and the project launched. Each item is marked ✓ if already true, ⚠️ if conditionally true, ✗ if not yet true.

### §15.1 At T+0 (pre-build gates)

| #    | Gate                                                                       | Status                                                                |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| G-1  | OpenAI-compatible LLM endpoint operational and budgeted                    | ✓                                                                     |
| G-2  | Self-hosted hosting capacity available (existing hardware healthy)         | ✓                                                                     |
| G-3  | Maintainer willing to spend spare time on M0-M5                            | ✓ (self-decided; no external commitment needed)                       |
| G-4  | This BRD ratified by sponsor (v1.0 freeze)                                 | ✗ (currently v0.1 DRAFT — this gate)                                  |
| G-5  | PRD and Tech Design / RFC drafted                                          | ⚠️ (PRD started, RFC pending)                                         |
| G-6  | GitHub repo `roshangautam/genie` created and labeled                       | ✗ (in M0 scope)                                                       |
| G-7  | Pre-launch legal memo confirming trademark posture and IP cleanliness      | ✗ (scheduled pre-M5)                                                  |
| G-8  | All 7 Tier-0 harnesses verified MCP-functional in the testbed              | ✓ (research report's per-harness matrix is the verification artifact) |
| G-9  | MCP-Apps stable spec dated 2026-01-26 confirmed live                       | ✓                                                                     |
| G-10 | Sponsor approval to start (the act of ratifying this BRD constitutes G-10) | ✗ (currently pending)                                                 |

### §15.2 At T+12 weeks (M5 launch gates)

| #     | Gate                                                                            | Threshold                                           | Status |
| ----- | ------------------------------------------------------------------------------- | --------------------------------------------------- | ------ |
| GL-1  | The planned file-flow tool surface implemented and CI-tested                    | 100%                                                | TBD    |
| GL-2  | 7 Tier-0 harness smoke tests green in CI                                        | 7/7                                                 | TBD    |
| GL-3  | ≥ 4 Tier-2 hosts render `ui://genie/grid` inline                                | 4 minimum (Claude, VS Code Stable, ChatGPT, Cursor) | TBD    |
| GL-4  | npm + Docker + `.mcpb` artifacts published                                      | 3/3                                                 | TBD    |
| GL-5  | Documentation set complete (BRD + Vision + PRD + RFC + Roadmap + GTM + Runbook) | 7/7 docs in `docs/`                                 | TBD    |
| GL-6  | Legal memo on file                                                              | Yes                                                 | TBD    |
| GL-7  | Reference component library shipped (≥ 12 components)                           | ≥ 12                                                | TBD    |
| GL-8  | No P0 security finding open                                                     | 0 P0                                                | TBD    |
| GL-9  | KPI dashboard live                                                               | Yes                                                 | TBD    |
| GL-10 | Public launch post published                                                    | Yes                                                 | TBD    |

Hitting all GL-_ gates triggers the M5 "ship" event. Missing any single GL-_ gate triggers a 1-week delay to remediate; missing GL-1, GL-2, GL-6, or GL-8 triggers a longer remediation cycle.

### §15.3 At T+16–24 weeks (the reality gate)

The GL-* gates above only prove the thing got *built*. They say nothing about whether it's *useful\* — which is the entire point of the experiment. So there is one more gate, checked a few months after launch, before pouring more spare-time into the project:

| #    | Gate                                                    | Threshold                                                                                                                        | Why                                                                                                                                                                  |
| ---- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GR-1 | **Did genie prove useful to at least its author?**      | The n=1 case study (BO-3) shows a real authoring speedup, OR the maintainer is genuinely using genie in their own work.          | If it doesn't help the one person who built it, it won't help anyone.                                                                                                |
| GR-2 | **Any external signal of usefulness?**                  | At least a few of: organic stars, a fork, an unsolicited issue/mention, a real install that came back with feedback (BO-4/BO-6). | Tells us whether MCP-Apps-for-design is a real category or a solution looking for a problem.                                                                         |
| GR-3 | **Is it still the most interesting use of spare time?** | Honest gut-check vs. the other ideas in the backlog.                                                                             | The opportunity cost is discretionary builder time (§13.2) — this gate makes the "keep going / park it / start the next idea" decision explicit instead of drifting. |

**This is a soft gate, not a kill switch.** A solo experiment doesn't owe anyone a pivot. But naming GR-1…GR-3 means the project can be honestly declared "answered the question, parking it" rather than quietly rotting — which is the healthy outcome for an experiment that taught you something even if it didn't take off.

---

## §16. Timeline at business altitude

> Legend: **T+0 = BRD ratification date** (anchor for every milestone week below).

Seven milestones, M0 through M6, from the research report's build plan (§7 of the report) plus a dedicated GA-hardening tail. The "~12 weeks" below is a **planning shape, not a schedule.** The research report's "12 days of focused engineering" is an _engineering-hours floor_ — the best case where nothing surprises you. It is **not** a calendar promise, and a solo, spare-time, AI-assisted build should be read as "this ships when it ships." Two parts of the plan are the realistic slip risks and deserve a skeptical eye up front: **OAuth 2.0 with Dynamic Client Registration across 7 different harness clients (M5)** is its own swamp, and **MCP-Apps `ui://` render parity across hosts (M4)** depends on host behavior nobody fully controls. The calendar buffer exists precisely because those two will take longer than the happy-path estimate suggests.

### §16.1 Milestone definitions

**M0 — Discovery & scaffold (weeks 1-2 from T+0)**

- **Business description.**
  - Stand up the GitHub repo, the reference git-host backend, the package skeleton, and the CI pipeline.
  - Validate the configured OpenAI-compatible endpoint from a hello-world MCP server.
  - Lock the BRD/PRD/RFC versions.
- **Business outcome.**
  - Project is operationally real — code exists, infrastructure is live, the team has a habit of shipping.
  - Sponsor sees commits within 5 business days.
- **Dependencies.** G-3, G-4, G-6 satisfied.
- **Target date.** T+2 weeks.

**M1 — Kit + project foundation (weeks 3-4)**

- **Business description.**
  - Implement genie's M1 tool surface: the permission-gated kit file-flow model plus project/blueprint management.
  - Tool names and schemas are genie's own (settled in the PRD/RFC).
  - Wire the local-FS backend; integration-test against synthetic kits, workspaces, and blueprint projects.
- **Business outcome.**
  - A user in any Tier-0 harness can connect, scaffold a kit, create or instantiate a project, bind a kit, and walk through the plan→write flow against genie.
  - The model is familiar to anyone who has used a permission-gated tool flow, but the conventions are genie's own.
- **Dependencies.** M0 complete.
- **Target date.** T+4 weeks.

**M2 — LLM generation surface (weeks 5-6)**

- **Business description.**
  - Add the genie-specific generation verbs: `conjure`, `refine`, `list_components`.
  - Wire to the configured OpenAI-compatible endpoint.
  - Define `COMPONENT_SCHEMA` JSON Schema (Draft 7).
  - Default to `design-default` alias.
- **Business outcome.** End-to-end "prompt → component → preview" works in Claude Code, with the operator's choice of model.
- **Dependencies.** M1 complete; `design-default` alias configured in the chosen endpoint or gateway.
- **Target date.** T+6 weeks.

**M3 — `@genie` validator + manifest compiler (weeks 7-8)**

- **Business description.**
  - Implement the `@genie` first-line marker validator and the `validate` tool.
  - Compile `.genie/manifest.json` on every `.html` write.
  - Begin the exemplar component library (maintainer + AI).
- **Business outcome.** genie enforces its own marker-based registration mechanism; downstream Vite viewer has a stable manifest to consume.
- **Dependencies.** M2 complete.
- **Target date.** T+8 weeks.

**M4 — Preview viewer (weeks 9-10)**

- **Business description.**
  - Build `@genie/viewer` as a Vite multi-page entry with chokidar HMR.
  - Implement `preview` tool with `ui://genie/grid` MCP-Apps resource.
  - Designer continues exemplar library; ships ≥ 12 components by milestone close.
- **⚠ Pre-M4 gate — Skybridge spike.** Before hand-building this tier, run the time-boxed [Skybridge](https://www.skybridge.tech/) spike (RFC §15.8, `docs/research/skybridge.md` §8): prove/disprove embedded-tier CSP + inline/fullscreen/pip parity + real Cursor/VS Code rendering. If it clears genie's hard constraints (G-5 + CSP), M4 builds _on_ Skybridge; else M4 proceeds hand-rolled as described. Either path keeps the `ui://` payload framework-agnostic. Decide before M4 starts — switching cost rises once the viewer is hand-built.
- **Business outcome.**
  - The visual half of genie exists.
  - Users can run `npx genie-viewer` and see their library at `http://localhost:5173`.
  - MCP-Apps hosts see the same grid inline.
- **Dependencies.** M3 complete.
- **Target date.** T+10 weeks.

**M5 — Auth + distribution + smoke tests across 7 harnesses (weeks 7-11)**

- **Business description.**
  - Implement OAuth 2.0 with DCR + static bearer fallback.
  - Package as npm + Docker + `.mcpb`.
  - Write per-harness config snippets.
  - Run end-to-end smoke tests across all 7 Tier-0 harnesses, capturing screenshots.
  - Land the legal memo (G-7) and the public launch post.
- **Business outcome.**
  - Public launch.
  - All 7 harnesses verified.
  - Sponsor's resourcing ask is delivered.
- **Dependencies.** M4 complete; G-7 in flight; OSS maintainer recruited (or document owner continues both roles).
- **Target date.** T+11 weeks.

**M6 — GA Hardening (weeks 11-12)**

- **Business description.** Load test, security audit, supply-chain hardening (sigstore + npm provenance), public docs site, launch checklist.
- **Business outcome.** GA-ready, public launch achievable.
- **Dependencies.** M5 complete.
- **Target date.** T+12 weeks.

### §16.2 ASCII Gantt-shape chart

> Legend: **T+0 = BRD ratification date** (anchor for all milestone weeks below).

```
Week:        1  2  3  4  5  6  7  8  9 10 11 12
M0 ████████
M1       ████████
M2             ████████
M3                   ████████
M4                         ████████
M5                               ██████████
M6                                        ████ → LAUNCH (T+12)
Exemplar lib            ████████████████████ (M3-M5, maintainer + AI, as attention allows)
Legal memo                                ███ (T+9-11)
KPI dashboard live           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ (lit at M2, sustained)
Smoke tests                                    ████ (continuous from M3, formalized M5)
```

Critical path: M0 → M1 → M2 → M3 → M4 → M5 → M6 (milestone dependencies are serial). The single-maintainer chain has no human parallelism — **this is the structural risk (R-07).** The mitigation is AI coding agents: within a milestone, multiple issues can progress concurrently under the maintainer's review (`AGENTS.md` SDLC), so "one person" doesn't mean "one thing at a time." The legal-memo work (optional, §13.1) and exemplar-library work can run alongside the build whenever attention allows. None of this is a committed schedule — see §16 intro.

---

## §17. Open questions to settle

Open questions the maintainer should settle before (or early in) the build. These are notes-to-self, not asks to an external sponsor. Defaults in the last column apply until decided otherwise.

### §17.1 Open questions

| #    | Question                                                                                                                                                                                                             | Why it matters                                                                                                      | Default                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q-1  | ~~Is the name acceptable?~~ **Decided: genie.** A generic English word, evocative, zero derivation from any Anthropic mark — a strong trademark position (§12.5).                                                    | Settled this session.                                                                                               | Keep genie.                                                                               |
| Q-2  | Should the M0-M5 build remain **strictly self-funded / opportunity-cost** (sponsor = document owner = single person), or do you want to recruit a co-sponsor (employer, foundation, foundation-adjacent) before T+0? | A co-sponsor adds runway, accountability, and reputational cover; it also adds governance overhead.                 | Self-funded; revisit at M3.                                                               |
| Q-3  | Author the exemplar component library yourself (with AI), or ship M0-M5 lean and let the community contribute exemplars later?                                                                                       | Exemplars improve viewer credibility, but cost maintainer attention during the build.                               | Maintainer authors ~12 exemplars with AI; more are community opportunities.               |
| Q-4  | What is your tolerance for **AGPL / LGPL** licensing if a contributor or external sponsor requests it?                                                                                                               | MIT is the default; a more restrictive license might appeal to GPL-aligned communities but blocks commercial reuse. | MIT, no relicensing.                                                                      |
| Q-5  | Should we publish a **public launch post** on a personal blog, Hacker News, or wait until we have a more impressive demo?                                                                                            | Earlier launch generates feedback faster but may attract harsher review.                                            | Launch on T+12 weeks per the Gantt.                                                       |
| Q-6  | ~~Do we want a managed preview-gallery offer?~~ **Decided: no managed service in scope.** Shareable previews stay self-hosted/operator-deployed.                                                                     | A managed gallery would add operational and privacy burden.                                                         | Strictly self-hosted/operator-deployed.                                                   |
| Q-7  | Should we **invest in Anthropic outreach** (cold DevRel email, conference talk submission) pre-launch, or stay quiet until we have something to show?                                                                | Outreach builds relationships but reveals our work early.                                                           | Wait until M4.                                                                            |
| Q-8  | What is your **risk appetite for the trademark posture**? Is a friendly-counsel memo (≈ $1.5k) sufficient, or do you want a formal opinion-of-counsel ($10-25k)?                                                     | Formal opinion is gold-standard but expensive.                                                                      | Friendly counsel for M0-M5; upgrade if challenged.                                        |
| Q-9  | Do you want a **VS Code-specific extension** added to the future scope, given that VS Code's MCP-Apps Stable lands in January 2026 and provides the best rich-rendering experience?                                  | Extension is duplicative work but offers a distinct discoverability path via the VS Code marketplace.               | Skip (per §6.2 OUT).                                                                      |
| Q-10 | Should the **canvas-side generation R&D workstream** be funded as a separate quarterly cycle post-M5, or treated as community R&D?                                                                                   | Funded → faster, opinionated; community → slower, more diverse, lower cost.                                         | Community R&D in M6, sponsor-funded if traction warrants in M7+.                          |
| Q-11 | What is the **process for handling a hypothetical Anthropic outreach** to us about the project (positive or negative)?                                                                                               | Pre-deciding this reduces panic and political risk.                                                                 | Maintainer responds within a few days, calmly; optional friendly counsel if it escalates. |
| Q-12 | Do you want **operational metrics (LiteLLM usage, GitHub traffic, NPS) published transparently** as part of the project's brand, or kept private?                                                                    | Transparency builds community trust; privacy preserves sponsor flexibility.                                         | Quarterly public KPI summary; raw data private.                                           |

These are the maintainer's own open questions; the defaults in column 4 apply until decided.

---

**End of Business Requirements Document v0.1 DRAFT.**

This document is companion to the Product Vision (`docs/plan/01-product-vision.md`), PRD (`docs/plan/03-prd.md`, in flight), and Tech Design / RFC (`docs/plan/04-tech-design-rfc.md`, in flight). It moves to v1.0 when the maintainer commits to the build (G-4 + G-10 — a self-decision, not an external sign-off).
