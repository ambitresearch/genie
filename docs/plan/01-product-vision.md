# Product Vision — genie

> Document owner: the maintainer (solo) · Status: working draft · Last revised: 2026-06-27
> Source-of-truth: this document supersedes any prior pitch or slide. All
> downstream docs (BRD, PRD, RFC, GTM, Runbook) inherit from it.
> Revision note (2026-06-24): Raised minimum Node.js from 18 to 22 (Node 18 & 20 reached EOL; Node 22 is the current Active LTS).

---

## 1. One-line vision statement

> **Every AI coding harness — not just Claude.ai — deserves a UI-kit-aware
> teammate that lives where the developer already works, runs on infrastructure
> the team already owns, and speaks its own open conventions — with optional
> bridges back to Claude Design for those who want them.**

---

## 2. The problem we're solving

### 2.1 The asymmetry as it exists today

Per Anthropic's announcement, Claude Design launched in research preview in
mid-2026, marketed as powered by "Claude Opus 4.7".[^claude-design] It is the first commercial product that treats a UI kit as a
first-class collaborator for an LLM: components register themselves via the
`<!-- @dsCard group="…" -->` first-line marker, a server-side self-check
recompiles a `ds_manifest` on every upload, and the canvas at `claude.ai/design`
generates UI that mechanically adheres to the team's real components rather than
generic AI aesthetics. The companion Claude Code slash commands `/design-sync`
and `/design` glue the canvas to the codebase. The pricing model is the
subscription itself: Pro, Max, Team, and Enterprise — Enterprise admin-toggled,
off by default.

For Anthropic customers using Claude.ai, this is a step change. For everyone
else, it is a closed door. There is **no public API for Claude Design**. There
is no DesignSync, design-sync, `_ds_manifest`, or `@dsCard` reference anywhere
in `platform.claude.com/llms.txt` — Anthropic's developer documentation index
treats the entire surface as private. The schema is shipped only because it is
injected into the model's tool catalog at session start, and the bundled skill
that backs `/design-sync` exists only as on-disk cache inside the Claude Code
binary at `$TMPDIR/claude-<uid>/bundled-skills/<version>/<hash>/design-sync/`
(the leaf is session-specific). It is not in
`anthropics/claude-plugins-official` and it is not in `anthropics/skills`.

This produces a starkly asymmetric world:

| Capability | Anthropic-paying user | Everyone else |
|---|---|---|
| Generate UI against the team's real components | ✅ | ❌ |
| Get inline edits via "knobs made by Claude" | ✅ | ❌ |
| Push a UI kit from code with one slash command | ✅ | ❌ |
| Render the result in a live, grouped grid of preview cards | ✅ | ❌ |
| Run the whole loop against a model the security team approved | ❌ | ❌ |
| Run the whole loop on infrastructure the team already owns | ❌ | ❌ |
| Use the workflow from inside Codex CLI / Copilot / Cursor / Cline / Continue | ❌ | ❌ |

The last two rows are decisive: **even the people who do pay Anthropic cannot
self-host Claude Design**, because the canvas, the project store, and the
generation loop all live behind `claude.ai`. The architecture is hostage to the
hosted product.

### 2.2 Personas living inside the asymmetry

**Priya — staff UI-platform engineer at a 600-person fintech.**
Priya owns the company's React component library and ships it as a private
package consumed by 14 product teams. Her engineers are split: half use VS Code
with GitHub Copilot agent mode, four squads have standardized on Cursor, the
infra team uses Claude Code, and the platform CTO insists on OpenAI Codex CLI
for any work touching regulated systems. None of these users can talk to a
UI-kit-aware LLM today. Priya watches Anthropic's demo, demos `@dsCard`
to her CTO, and is told flatly: *"We can't put our component IP through
claude.ai. Find an alternative or build one."*

**Marco — solo indie hacker on a Mac mini.**
Marco builds three small SaaS products in parallel. He uses Claude Desktop for
casual UI brainstorming but does production work in VS Code with Continue.dev
because it lets him point at his self-hosted Ollama box for sensitive prompts.
Anthropic's Pro plan is real money for him, and even when he pays for it he
loses access to his own components the moment he leaves `claude.ai`. He wants
the Claude Design workflow as a Tuesday-afternoon utility, not a marriage.

**The "Bauhaus" team at a Series-D health-tech.**
A six-person design platform team supports 90 product engineers across five
domains. They run an internal Storybook against `acme-ui`, version 4. Their
designers have been quietly evaluating v0.dev and Galileo AI for ideation but
neither tool understands `acme-ui` — every generated artifact has to be hand-
rewritten to use the team's tokens, primitives, and spacing scale. They want
something that takes a Figma frame or a one-line prompt and emits a
copy-pasteable variant of an `acme-ui` component, scored by adherence rules
they themselves authored.

**Dr. Lina Okafor — research lab lead at a public university.**
Lina's lab maintains an internal academic toolkit (`oxfordoa-ui`) used by ten
grant-funded projects. The university's procurement office forbids sending lab
component source code to third-party SaaS. She wants the Claude Design loop
running on the lab's own GPU box, served to whichever editor her grad students
prefer, with audit logs going to the institutional SIEM. She does not need a
canvas — she needs the headless half: "given my components, generate three
candidate landing pages this Friday."

**Kenji — DevTools PM at a CLI-first company.**
Kenji's product is a developer-facing CLI. Internal designers ship mockups in
Figma, internal frontend engineers ship in plain HTML + Web Components. The
team's daily editor is OpenAI Codex CLI. There is no React, there is no
Storybook, and there is no Anthropic subscription. Kenji wants the
*incremental-sync verb set* — the 13-method `list_kits / plan /
write_files / delete_files / validate` protocol — so
his designers' Figma exports land in his repo as `@genie`-marked HTML cards
that his Codex agent can iterate on. The visual canvas is irrelevant to him; he
needs the contract.

### 2.3 The structural lock-in

Three things lock Claude Design to Anthropic, and only one of them is
defensible technology.

1. **Subscription metering.** Pro/Max/Team/Enterprise gates access. Replacing
   this is operationally trivial — LiteLLM already lets you mint per-key budgets
   and rate-limits ([docs.litellm.ai/docs/proxy/users](https://docs.litellm.ai/docs/proxy/users)).
2. **The canvas-side generation loop.** Prompt shape, per-element artifact
   format, inline-comment edit round-trip, and the "knob" UI are documented
   nowhere public. This is a real R&D cost.
3. **The `claude.ai/design` project store and self-check.** Recoverable from
   the on-disk bundled skill — the verbs are mirror-able, the regex is
   `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/`, and the file-tree contract is
   one `package-validate.mjs` away from being public.

The product opportunity is to **rebuild #1 and #3 in the open, and treat #2 as a
slow, honest, second-year workstream.** That is what genie is.

---

## 3. North-star metric

### 3.1 The one metric

> **Weekly active component-store mutations originating from a non-Claude.ai
> harness — counted as the number of distinct `(repo, week, harness)` triples
> in which our MCP server processes at least one `write_files` against a
> `GENIE_KIT` repo.**

Target by end of Year 1: **2,500 weekly triples** across the public install base,
of which at least **40%** come from harnesses other than Claude Code (i.e.
Codex CLI, Copilot, Cursor, Cline, Continue.dev, Claude Desktop combined).

### 3.2 Why this metric and not the obvious alternatives

The metric is engineered to refuse three temptations.

**It refuses GitHub stars.** Stars measure curiosity, not workflow. A repo can
trend on Hacker News and never touch a production UI kit. Stars also
collapse to zero signal once the project crosses ~5k — fan-out makes per-week
deltas meaningless.

**It refuses installs.** Install count rewards the `npx -y …` ritual but does
not distinguish "someone tried it" from "someone uses it." MCP servers are
particularly install-leaky: every laptop refresh re-pulls. We will track
installs as a leading indicator, but never as the goal.

**It refuses LLM token spend.** Token spend would be the natural metric if we
were a model provider. We are not. We sit in front of LiteLLM, which already
owns the cost-and-budget surface. Optimizing for tokens would push us toward
chatty prompts and away from terse, deterministic verbs.

**The chosen metric is workflow-anchored.** A `write_files` against a
UI-kit repo is the moment the product earned its keep — the user trusted
the system to mutate code they care about. It captures retention (weekly), real
work (writes, not reads), distinct contexts (per repo), and harness diversity
(per harness). The 40% non-Claude-Code threshold encodes our reason to exist:
this is not a Claude Code companion, it is a cross-harness peer-to-peer
substrate.

### 3.3 Counter-metrics

We pair the north star with two guard-rails:

- **Median latency of `preview` ≤ 600 ms (p95 ≤ 1500 ms).** If the
  preview pane is slow, the metric will be gamed by tooling that batches writes.
- **`validate` failure rate ≤ 3% per project per week.** If we
  let users write garbage cards, the metric becomes a vanity number.

---

## 4. Who it's for (target users)

### 4.1 Priya — staff UI-platform engineer (the anchor persona)

**Role.** Owns a private React component library at a regulated-industry
mid-market company. Reports to the head of design platform. KPI'd on adoption
across product teams.

**Current workflow pain.** Component churn. New product engineers ship hand-
rolled buttons instead of `acme-ui` primitives because LLM tab-completions
generate `<button class="bg-blue-500">` snippets that look right and ship green.
Six months in, the UI-kit migration story is on fire.

**What success looks like.** When a product engineer in Cursor asks for "a
loading state for the deposit confirmation card," they get back a snippet that
imports from `@acme/ui`, uses the team's `<Skeleton>` and `<Card>` primitives,
and passes Priya's adherence config on the first generation. Priya can audit
which components are used where by querying our component-store git log. She
never opens `claude.ai`.

### 4.2 Marco — solo indie hacker (the long-tail persona)

**Role.** Sole engineer on three SaaS products. Owns the UI from Figma to
production.

**Current workflow pain.** Context-switching between Continue.dev (for cheap
local Ollama work) and Claude Desktop (for the occasional design brainstorm)
means his components diverge across products. He has rebuilt the same auth flow
three times.

**What success looks like.** A single MCP server pointed at his local
`~/code/shared-ui/` directory, mounted in both Continue.dev and Claude Desktop.
A `conjure` call in either harness produces a card that lands in
`shared-ui/components/`, shows up in his Vite-backed viewer at
`http://localhost:5173`, and is committable in 30 seconds. His Ollama instance
serves the cheap iterations; LiteLLM routes the polish step to Sonnet 4.6.

### 4.3 The Bauhaus team — six-person design platform (the team persona)

**Role.** Six engineers + one design lead. Maintain `acme-ui` v4, an internal
Storybook, and the company's adherence rules.

**Current workflow pain.** Designers and engineers do not share tools. The
designers use Figma + v0.dev; the engineers use Cursor + GitHub Copilot. Every
design generation requires a translation pass to get from "an AI's idea of a
button" to "an `acme-ui.Button`." Galileo AI looked promising but does not
understand custom tokens.

**What success looks like.** Two Bauhaus engineers pair with the design lead to
write the adherence rule set as `_adherence.oxlintrc.json`-shaped JSON. The
designers point our preview pane at the same component store the engineers
commit to. A designer's "make me three primary-button hover states" produces
three cards in the grid, each scoring against the rule set, each round-trippable
into a real PR.

### 4.4 Dr. Lina Okafor — research lab lead (the air-gapped persona)

**Role.** Runs a six-grad-student lab building academic visualization tools.
Maintains `oxfordoa-ui`, a Web Components library.

**Current workflow pain.** Procurement forbids sending source code to SaaS. The
lab's research output funnels through ten distinct project websites, each
hand-styled because nobody has bandwidth to keep them aligned.

**What success looks like.** A single Docker-deployed genie
behind the lab's OIDC SSO, pointed at a self-hosted git host. An
OpenAI-compatible endpoint routes generation requests to a self-hosted
Qwen3-Coder 32B on the lab GPU.
Audit logs flow to the institutional SIEM. Lina's grad students get the Claude
Design workflow without a single byte of `oxfordoa-ui` leaving the campus
network.

### 4.5 Kenji — DevTools PM (the headless persona)

**Role.** Product manager for a CLI-first developer product. Manages a tiny
frontend marketing surface plus the CLI's `--help` HTML output.

**Current workflow pain.** Designers ship Figma frames. Engineers ship vanilla
HTML + Web Components. No React. No Storybook. No subscription. Every design
hand-off is a manual translation.

**What success looks like.** Kenji's designers run a Figma export pipeline that
emits `@genie`-marked HTML and dumps it into a genie project.
Kenji's Codex CLI agent picks up the cards via `list_components`, iterates on
copy, and writes back via `write_files`. The visual canvas is never opened —
Kenji uses the verbs and the viewer, nothing else.

---

## 5. Vision pillars

### 5.1 Pillar 1 — Harness-agnostic by construction

**What it means.** genie is built against the Model Context
Protocol's stable surface, not any one vendor's extension. We commit to seven
**Tier-0 universal harnesses** on day one: Claude Code, Claude Desktop, Codex
CLI, GitHub Copilot in VS Code agent mode, Cursor, Cline, and Continue.dev.
Every release passes a smoke test against all seven with a single MCP server
binary. The tool-name shape `mcp__genie__<verb>` is what every
harness sees; the verbs themselves do not change per host.

We accept three documented capability tiers and design for graceful
degradation:

- **Tier-0 (every harness):** tools + structured JSON responses.
- **Tier-1 (Claude Code, Cursor, VS Code):** add resources (`genie://`) and
  optional fallback prompts (`/genie__new-component`).
- **Tier-2 (Claude, VS Code Stable Jan 2026, ChatGPT, Cursor):** add the
  `ui://` MCP App for inline preview, generate, refine, and audit.

The same server emits all three. A tools-only Cline session can do real work; a
Tier-2 Claude session gets the same work plus an inline card grid.

**What it does NOT mean.** We will not chase every Cursor-specific or
Continue.dev-specific extension API. We will not ship VS Code Chat Participants
or Cline marketplace bundles unless they collapse to the same MCP server. The
moment a host-specific feature requires a parallel codepath, we refuse it.

### 5.2 Pillar 2 — Self-hostable by default

**What it means.** The reference deployment runs on self-hosted infrastructure with a git host
and a configurable OpenAI-compatible endpoint. There is no hosted SaaS in the critical path.
The `npm` package, the `.mcpb` bundle, and the Docker image are interchangeable
artifacts of the same build. Every secret is an env var. Every backend is
swappable.

We assume the deployer owns the model, owns the storage, and owns the auth
provider. Our defaults reflect that — local FS for solo, a self-hosted git host
(GitHub / Gitea / GitLab) for shared, a configurable OpenAI-compatible LLM
endpoint (LiteLLM / Ollama / vLLM / …) for generation, and OIDC against the
deployer's existing IdP for shared HTTP deployments. We publish reference
configurations for each.

**What it does NOT mean.** We do not refuse to run against hosted backends.
LiteLLM can route to Anthropic's hosted Sonnet 4.6, OpenAI's models, or a local
Qwen. The point is not anti-cloud purity; it is *operator choice at the
deployment boundary*.

### 5.3 Pillar 3 — UI-kit-first

**What it means.** The units of work are the UI kit and the project, not the
component, not the screen alone, not the conversation. Kit verbs take a `kitId`;
screen verbs take a `projectId` and resolve the bound kit explicitly. Every
kit-constrained generation follows the kit's adherence rules. Every card preview
registers itself via the `<!-- @genie group="…" -->` marker. genie's M1 surface
keeps the capability-gated *shape* Anthropic's DesignSync pioneered (read freely →
one `plan` gate → scoped writes) because that shape is right, while naming the
verbs genie's own way.

Cards group themselves. Validations short-circuit. The `[MARKER_MISSING]` build
failure is a feature, not a bug. We refuse the option to ship "loose" component
fragments outside a UI-kit project.

**What it does NOT mean.** We are not a Figma alternative, and we are not a
visual canvas editor. We do not invent new design tokens, we do not opinionate
on color, and we do not bundle a primitive library. The UI kit is yours;
we merely make it legible to an LLM.

### 5.4 Pillar 4 — Open by default, MIT-licensed, plain TypeScript

**What it means.** The repository at `ambitresearch/genie` is
MIT-licensed. The primary language is TypeScript (Node ≥ 22, ESM). The MCP
implementation uses `@modelcontextprotocol/sdk` only — no proprietary forks, no
private extensions. The protocol is the boundary; everything inside is open
source. No telemetry beacons. No "free tier vs paid tier." If a feature exists
in our hosted demo, it exists in the npm package.

We follow the conventions of two best-in-class open-source MCP servers:
**[GLips/Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP)** (15.2k
stars *(repo stats as of 2026-06-21; check current)*, MIT, TypeScript, latest
v0.13.2 dated 2026-06-18 *(repo stats as of 2026-06-21; check current)*) gives
us the transport/build/CLI skeleton, and
**[Jpisnice/shadcn-ui-mcp-server](https://github.com/Jpisnice/shadcn-ui-mcp-server)**
(2.8k stars *(repo stats as of 2026-06-21; check current)*, MIT, v2.0.0 dated
2026-01-30 *(repo stats as of 2026-06-21; check current)*) gives us the
distribution matrix (npm + Docker + `.mcpb` + Smithery + per-IDE installers).

**What it does NOT mean.** Open source does not mean "no commercial use." We
expect agencies, consultancies, and enterprise platforms to deploy this in
production and charge their customers for it. MIT was chosen precisely because
it permits that.

### 5.5 Pillar 5 — Own conventions, optional bridges

**What it means.** genie speaks its **own** conventions natively — its own verb
names, its own first-line `@genie` card marker, its own `.genie/` on-disk layout,
its own `genie://` resource scheme. We do not conform to anyone else's schema as a
design constraint. The conventions are designed for clarity and for genie's own
users first.

Interoperability with hosted Claude Design is a **future, opt-in bridge** — not a
foundational pillar. A later adapter mode can read and write Anthropic's
`@dsCard` / `_ds_*` shapes so a project can round-trip into a real
`claude.ai/design` project, and (separately) import designs from Google Stitch.
That bridge is additive and lives behind a flag; it never dictates genie's native
surface.

This is deliberate. Designing our own conventions is the honest move for an
independent project — we are inspired by Claude Design, not a reproduction of it.
If a team later wants to move work between genie and a hosted tool, the bridge is
there; but no genie user pays a "compatibility tax" in their day-to-day surface.

**What it does NOT mean.** Own-conventions does not mean hostile-to-interop. We
will ship the bridge when it earns its place (post-v1), and we keep our file
formats cat-able, diff-able, and documented precisely so that *any* external tool
— Anthropic's or otherwise — can integrate against them. The point is operator
choice, with genie's own clean surface as the default and bridges as opt-in.

### 5.6 Pillar 6 — Boring infrastructure, opinionated UX

**What it means.** Under the hood: stdio transport for first-run local installs,
Streamable HTTP for already-running local dev, shared, or remote deployments,
OAuth 2.0 with Dynamic Client Registration for HTTP-capable Claude Code, Codex
CLI, and Cursor setups, static `Authorization: Bearer` for HTTP harnesses
without OAuth. Vite for the preview viewer because Vite natively
supports multi-page entry points
([vite.dev/guide](https://vite.dev/guide/)). Chokidar for file watching. No
custom protocol invention. No homegrown bundlers.

On top of that infrastructure: a single, opinionated UX. One verb name for
generation. One layout for the preview grid. One regex for card validation.
One sentinel file (`.genie/recompile`) for triggering recompile. One
verification anchor (`.genie/sync.json`) written last. We chose these as
genie's own conventions, kept them tidy under one `.genie/` directory, and we
will not paint the bikeshed.

**What it does NOT mean.** Boring does not mean immutable. We will swap Vite
for something faster if Vite stagnates. We will adopt new MCP capabilities the
moment two of our seven target harnesses ship them. The principle is "stable
where it matters to users; pragmatic where it doesn't."

---

## 6. Product principles

### Principle 1 — MCP is the only interop boundary

**Clarification.** Every external consumer talks to us through the Model
Context Protocol. Tools, resources, prompts, and `ui://` apps are the entire
public surface. We do not expose a REST API. We do not publish an SDK. We do
not invite host-specific shims.

**Anti-example.** A "Cursor extension" that calls our internal Node modules
directly to bypass the MCP plan-then-write boundary, even if it is faster.
Reject.

### Principle 2 — We name our own verbs for clarity

**Clarification.** genie declares its own tool names, chosen to read clearly for
genie's users. The kit/component core is
`list_kits`, `get_kit`, `read_file`, `create_kit`, `plan`, `write_files`,
`delete_files`, `validate`, `list_components`, `conjure`, `refine`, `preview`
plus `list_files`; the project core is `list_projects`, `get_project`,
`create_project`, `delete_project`, `bind_kit`, `conjure_screen`. They keep the DesignSync *protocol shape* — read
freely → one `plan` permission gate → writes scoped to the granted globs — because
that shape is genuinely good, not because we are obliged to mirror it. Anthropic
does not own the verbs (MCP tool names are server-declared), and we are not bound
to their names.

**Anti-example.** Re-introducing `plan` / `conjure` purely to
match Anthropic's bundled skill, at the cost of a clearer name. Reject — the
optional interop bridge (Pillar 5) handles their schema; our native surface stays
ours.

### Principle 3 — Previews are static HTML files first, rich UI second

**Clarification.** Every preview ships as a `preview.html` file that opens
directly under `file://` with zero dependencies. The Vite viewer renders the
same files in a grid. The `ui://genie/grid` resource inlines the same
files for hosts that support MCP Apps. One artifact, three delivery vehicles.

**Anti-example.** A preview format that requires our viewer to render — a
React-component-as-preview that cannot be opened standalone. Reject.

### Principle 4 — Authoring without LLM access still works

**Clarification.** A user with a broken LLM-gateway connection can still
`list_kits`, `read_file`, `write_files`, `validate`, and
`preview`. Generation verbs (`conjure`, `refine`)
fail loudly with an actionable error. Everything else degrades gracefully.

**Anti-example.** A startup screen that refuses to load until an LLM-gateway
heartbeat succeeds. Reject.

### Principle 5 — The plan is the permission grant

**Clarification.** `plan` is the *only* user-visible permission
boundary. Everything before it (reads) is unprompted; everything after it
(writes, deletes) is constrained to the plan's paths: calling write or delete
without a valid `planId`, or with paths outside the plan, is rejected. We
enforce this with a hard check in the server, not in the harness.

**Anti-example.** A "convenience" tool that takes a write and an implicit plan
in one call. Reject.

### Principle 6 — Atomic upload sequence, anchor last

**Clarification.** The five-step write sequence is non-negotiable: (1) write
the `.genie/recompile` sentinel first, (2) chunk content writes ≤256 per call,
(3) all deletes, (4) re-arm the sentinel, (5) write `.genie/sync.json` last. The
anchor's job is to vouch for files; if anything mid-plan fails, the anchor must
not exist — its absence becomes the trigger for the next sync's repair pass.

**Anti-example.** Writing `.genie/sync.json` first to "lock in the version" before
content. Reject.

### Principle 7 — The card marker is the registration mechanism

**Clarification.** A component registers itself by having a `preview.html` whose
first line matches `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`. There is no
manual registration. There is no central registry file the user edits. There are
no asset-registration verbs at all — the marker *is* the registration; to
unregister, delete the file. (Anthropic's legacy `register_assets` /
`unregister_assets` live only in the optional interop bridge.)

**Anti-example.** A `dsRegister()` helper called from inside a component's TSX.
Reject.

### Principle 8 — Storage is git

**Clarification.** A kit's shared backing store is a git repo. A `planId` becomes a branch.
`plan` opens a PR. `write_files` commits to that branch. Merge is
atomic publish. Rollback is a `git revert`. This holds for both the solo case
(local working tree) and the shared case (GitHub / Gitea / GitLab). We get
diff, history, code review, branching, and audit for free; we will never
reinvent any of them.

**Anti-example.** A bespoke `~/.genie/db.sqlite` that tracks
"project state" outside git. Reject.

### Principle 9 — Models route through a configurable OpenAI-compatible endpoint, never directly

**Clarification.** The MCP server calls an operator-configured OpenAI-compatible
endpoint (LiteLLM is the reference; Ollama / OpenAI / vLLM also work — D-H). The
base URL is an env var with no hardcoded default. Model selection is
`model: "design-default"` or `model: "design-best"` — aliases the operator maps
at their gateway, not hardcoded in our code. Per-key budgets and rate limits are
the gateway's job.

**Anti-example.** Embedding an `anthropic-sdk` direct call into
`conjure` "for performance." Reject. Also reject baking any specific provider
URL into the code as a default.

### Principle 10 — Tool descriptions ≤ 2 KB, names ≤ 64 chars, JSON Schema Draft 7

**Clarification.** Claude Code truncates server instructions and tool
descriptions at 2 KB. Tool names must be `[A-Za-z0-9_-]` and ≤ 64 chars or they
get rewritten. JSON Schema Draft 7 primitives only — observed empirically; some
2026 harnesses (Continue.dev, Cline) accept JSON Schema Draft 7 reliably but
trip on `anyOf` discriminators and `$ref` chains. We design every tool for the
most restrictive harness in the matrix.

**Anti-example.** A 4 KB tool description that "fully explains the protocol."
Reject — split it across docs, not the tool blurb.

### Principle 11 — One server binary, one config, seven harnesses

**Clarification.** We ship one `genie` binary. The same binary
runs under stdio in Claude Desktop, under Streamable HTTP behind OAuth in
Claude Code, and under static-bearer HTTP in VS Code Copilot Chat. The README
has one config snippet per harness; the snippets differ only in transport keys
and auth shape. The server's behavior is identical.

**Anti-example.** A `--cursor-mode` or `--vscode-mode` flag that changes verb
behavior. Reject.

### Principle 12 — Claude Design is the inspiration, not a spec we conform to

**Clarification.** We studied Anthropic's bundled `design-sync` skill to learn
*which techniques work* — the capability-gated plan→write flow, the in-file card
marker, the verification anchor, the atomic write order. We adopt those
**techniques** and design our own **conventions** on top (our verb names, our
`@genie` marker, our `.genie/` layout, our `genie://` scheme). Where the skill's
choices don't serve genie's users, we choose differently and document why. The
optional interop bridge (Pillar 5) — not our native surface — is where Anthropic's
exact schema lives.

**Anti-example.** Refusing to ship `preview` because "Anthropic doesn't
have it," or re-adopting their file names "for fidelity." Reject — we are not
Anthropic, and the bridge handles round-tripping.

---

## 7. The 3-year arc

### 7.1 Year 1 — parity with Claude Design's core loop, local-only, single user

**Theme.** Build the credible open alternative. Make the core loop genuinely useful, solo and local-first.

| # | Outcome | Concrete artifact |
|---|---|---|
| 1 | The M1 genie tool surface works end-to-end against a local FS | Kit verbs plus `list_projects`, `get_project`, `create_project`, `delete_project`, `bind_kit`, and `conjure_screen` pass smoke tests in 7 harnesses |
| 2 | `conjure` produces a card that lands in the store and validates | `M2` release; demo video of Sonnet 4.6 generating an `acme.Button` variant in Cursor |
| 3 | `@genie` validator and manifest compiler ship and are covered by genie's own regex test fixtures | `M3` release; CI matrix runs the `@genie` regex against genie's fixture suite |
| 4 | Vite-backed preview viewer with HMR ships as `@ambitresearch/genie-viewer` | `npx @ambitresearch/genie-viewer ui_kits/<kit>` renders the grid at `http://localhost:5173` |
| 5 | Auth + distribution complete: local stdio install, OAuth DCR for supported HTTP harnesses, static bearer for the rest, `.mcpb` bundle for Claude Desktop | `M5` release; one-command install in all 7 harnesses |
| 6 | First wave of public adoption | 1,000 GitHub stars; 100 weekly active component-store mutations |
| 7 | Reference self-hosted deployment documented end-to-end | `docs/06-operations-runbook.md` plus a self-hosting tutorial blog post |
| 8 | One brand-name UI kit adopts us in production | A public case study or testimonial from a recognizable team |

**Explicit GA milestone — v1.0 in Q4 2026.** v1.0 ships with M0–M6 complete
(M6 being the GA-hardening tail: load test, security audit, supply-chain
provenance, public docs site, launch checklist), the 7-harness compatibility
matrix in CHANGELOG, and the reference self-hosted deployment proven by at least
one external adopter.

### 7.2 Year 2 — multi-user, team workflows, shareable previews, plugin ecosystem

**Theme.** Cross the team threshold. Make this safe for ten people instead of
one.

| # | Outcome | Concrete artifact |
|---|---|---|
| 1 | Git-host backend with branch-as-plan model ships as default for shared deployments | v1.1 release; `plan` opens a PR/MR where supported, merge = publish |
| 2 | Multi-tenant auth via the deployer's OIDC provider | v1.2 release; per-org per-project RBAC |
| 3 | Shareable preview exports — card URLs designers can drop in Slack | Static-site generator operators can deploy on their own domain |
| 4 | Plugin API for custom verbs (e.g. Storybook adapter, MDX adapter, Figma exporter) | v2.0 release with plugin SDK; first three reference plugins |
| 5 | First external community plugins ship | Three plugins from outside contributors in the registry |
| 6 | Webhook surface for CI integration (PR previews, Chromatic-style visual diff) | v2.1 release; reference GitHub Action |
| 7 | Adoption signal: 5,000 weekly active component-store mutations, 40% from non-Claude harnesses | North-star metric hit |
| 8 | First external operator guide | An agency or platform publishes a repeatable self-hosted deployment guide |

### 7.3 Year 3 — de-facto open standard for AI UI-kit tooling

**Theme.** Become the substrate everyone else builds on.

| # | Outcome | Concrete artifact |
|---|---|---|
| 1 | The `@genie` marker and genie's kit/project protocol are referenced by at least two unrelated MCP servers | Citation in the public MCP registry; cross-server interop demos |
| 2 | A canonical Storybook adapter ships (greenfield gap noted in research — no Storybook MCP exists today) | `@ambitresearch/genie-storybook-adapter` v1.0 |
| 3 | First-class adapters for Tailwind v5, shadcn/ui registry, Material UI, Chakra | Four adapter packages, all maintained |
| 4 | Canvas-side generation R&D ships — inline-comment edit protocol, region-targeted refinement | v3.0 release; the part Anthropic hides becomes openly specified |
| 5 | Adoption signal: 25,000 weekly active mutations, presence in three Top-10 UI-platform org workflows | Public usage report |
| 6 | A vendor-neutral MCP working group adopts the `@genie` regex as a recommended extension | Spec-track inclusion |
| 7 | At least one harness ships native rendering of our `ui://` cards as a bundled UX | A harness (likely VS Code or Cursor) ships a "UI kit" tab powered by our resource |
| 8 | Anthropic ships an official cross-harness Claude Design extension and references our prior art | Acknowledgment or compatibility statement from Anthropic; we treat this as success, not threat |

---

## 8. Anti-goals (explicit non-goals)

### 8.1 We will NOT build a hosted SaaS competing with Anthropic

A multi-tenant SaaS at `genie.cloud` would be the obvious commercial
move. We refuse it. The entire product thesis is self-hosting; a SaaS would
make us functionally indistinguishable from Anthropic on the "trust us with
your component IP" axis and would let one outage of ours take down every
customer's design pipeline. We will publish a reference Docker image, a
Helm chart, and a self-hosted app catalog entry. We will not run them on our
infrastructure for customers.

If a partner agency wants to operate a managed genie on
behalf of a customer, that is exactly the deployment model we celebrate.
But the operator is them, not us.

### 8.2 We will NOT build a visual canvas editor

The canvas at `claude.ai/design` is genuinely impressive. Rebuilding it —
the in-browser WYSIWYG, the inline comments, the per-element knobs, the
drag-to-reflow — is open-ended R&D that competes with Webflow, Framer, and
v0.dev simultaneously. None of those products have been "won," and the
team that wins them will not look like the team that wins MCP adoption.

We ship a preview *grid* (read-only), not a preview *canvas* (editable).
Refinements happen via `refine({ instruction, region })` calls
made by the harness, not by clicking on pixels in our viewer. That is a
deliberate scope cut. The visual canvas is on the Year 3 R&D track and may
never ship at all.

### 8.3 We will NOT build a Figma alternative

Designers will continue to use Figma, and that is fine. We expect Figma to
be the *source* of design intent (via `refImageDataUrl` or via a third-party
exporter that emits `@genie` HTML), not its competitor. We will publish
recipes for Figma → genie flows, but we will not maintain a
Figma plugin, we will not parse `.fig` files, and we will not try to
replace `Figma → Dev Mode → MCP Server` for the teams who already pay for
that stack ([Figma's official Dev Mode MCP at `https://mcp.figma.com/mcp`](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server)).

### 8.4 We will NOT build a design-token color tool

The world has Style Dictionary, Token Studio, Theo, Specify, and a dozen
others. None of them is going away. We accept the team's tokens as input
(under `tokens/` in the component store) and propagate them into generated
components and previews. We will not invent yet another token format, we
will not ship a color picker, and we will not opinionate on accessible-
contrast thresholds.

### 8.5 We will NOT add a database

The store is git. The audit log is the git log. The "session state" is the
filesystem. Caches are `.cache/` directories. We refuse to add Postgres,
SQLite, Redis, or any other stateful service to the critical path. If you
need full-text search across your component store, run `ripgrep`. If you
need analytics, query the git log. If you need session state, the harness
already has it.

### 8.6 We will NOT ship our own LLM

The configured OpenAI-compatible endpoint is the model gateway. We are not a
model. We are not a fine-tuning provider. We are not a prompt library. We will publish *prompts* in the
repository — they are part of the open-source surface — but we will not
ship weights, we will not train embeddings, and we will not bundle Ollama
in the Docker image. Choosing a model is the operator's job.

### 8.7 We will NOT lock the file format

The on-disk format is `preview.html` + `meta.json` + `.genie/manifest.json` +
`.genie/sync.json` — genie's own, plain and inspectable. We will not
invent a proprietary binary, we will not depend on a closed schema
registry, and we will not require our viewer to read the files. Cat-able,
diff-able, grep-able. Always.

---

## 9. Competitive positioning

### 9.1 The matrix

| # | Product | Harness portability | Self-hostable | Design-system-first | Open source | No subscription required | Custom LLMs | Visual pane | Programmable |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **genie** (this) | ✅ 7 harnesses Tier-0 | ✅ Docker/npm/`.mcpb` | ✅ 19-tool kit/project protocol | ✅ MIT | ✅ | ✅ any OpenAI-compatible endpoint | ⚠️ grid-only (Year 1), canvas (Year 3) | ✅ MCP |
| 2 | Claude Design (hosted, Anthropic) | ❌ Claude Code only | ❌ | ✅ | ❌ closed | ❌ Pro/Max/Team/Ent | ❌ Opus 4.x (marketed Opus 4.7; resolves to Opus 4.8) | ✅ full canvas | ⚠️ DesignSync tool only |
| 3 | v0.dev (Vercel) | ❌ web UI only | ❌ | ⚠️ ad-hoc shadcn | ⚠️ shadcn snippets MIT | ❌ Vercel plan | ❌ | ✅ canvas | ❌ |
| 4 | Galileo AI | ❌ web/Figma plugin | ❌ | ❌ generic AI aesthetics | ❌ | ❌ | ❌ | ✅ canvas | ❌ |
| 5 | GLips/Figma-Context-MCP | ✅ MCP | ✅ npm | ⚠️ Figma frames, not component lib | ✅ MIT | ✅ (needs Figma seat) | ✅ via host | ❌ | ✅ MCP |
| 6 | Jpisnice/shadcn-ui-mcp-server | ✅ MCP | ✅ npm + Docker + `.mcpb` | ⚠️ shadcn registry, not your DS | ✅ MIT | ✅ | ✅ via host | ❌ | ✅ MCP |
| 7 | Storybook | ✅ any web frontend | ✅ static or hosted | ✅ if you maintain stories | ✅ MIT | ✅ | n/a (not LLM) | ✅ live story canvas | ⚠️ CSF + addons |
| 8 | Plain Cursor/Copilot autocompletion | ✅ in-IDE | ✅ | ❌ no DS awareness | ⚠️ host-dependent | ❌ host | ⚠️ host-dependent | ❌ | ❌ |

### 9.2 Interpreting the table

**The only competitor that ticks both "harness portability" and "UI-kit-
first" is us.** Claude Design is the most polished product in the row, but it
binds the UI-kit loop to one harness and one subscription. v0.dev and
Galileo AI optimize for canvas-first ideation, not component-library adherence
— they generate beautiful-but-orphan UI. Figma-Context-MCP and shadcn-ui-mcp-
server are harness-portable, but neither treats *your* component library as
the first-class object; one is a Figma viewer and the other is a registry
client. Storybook is the closest UI-kit-first cousin, but it is not an
LLM substrate and has no equivalent to `@genie` or `conjure`.

**Our differentiation is the conjunction, not any single column.** Anyone can
ship a harness-portable MCP server. Anyone can ship a UI-kit viewer.
The combination — *one open-source MCP server that runs in seven harnesses,
self-hosts, speaks its own UI-kit-native protocol, and can later bridge to hosted
Claude Design* — exists only here.

**We are also the only entry where "open source" and "UI-kit-first"
co-occur with "self-hostable."** Storybook is open and self-hostable but does
not generate or refine components. shadcn-ui-mcp-server is open and
self-hostable but ties you to the shadcn registry rather than your library.
Plain Copilot is harness-native but knows nothing about your UI kit.
The gap in the market is precise and it is the gap we fill.

**The future interop column does not appear in the table because nobody else
offers it.** Claude Design users cannot export their work to a non-Anthropic
backend. v0.dev users cannot export to a non-Vercel backend. Figma-Context-MCP
users cannot save state outside Figma. genie is the only product planning an
opt-in bridge that can read/write another vendor's project shapes while keeping
its native protocol independent. That alone is a moat: it means we are the safe
bet, even for teams who eventually need to migrate to hosted Claude Design.

---

## 10. Strategic risks

### 10.1 Anthropic ships an official cross-harness Claude Design extension

| Field | Value |
|---|---|
| Likelihood | **M** — there is a coherent business reason to do this (broaden the addressable harness market), but Anthropic's pricing model is subscription-anchored and a cross-harness extension dilutes that. |
| Impact | **H** — our reason to exist contracts overnight. |
| Mitigation | (a) the optional interop bridge (Pillar 5) lets users migrate to Anthropic's official offering in a day if they prefer it; (b) self-host + custom-LLM remain advantages Anthropic will not match; (c) we explicitly frame v3 as "the substrate they build on," so if Anthropic does ship, we have already become the canonical extension target. |

### 10.2 MCP spec evolves in a breaking way

| Field | Value |
|---|---|
| Likelihood | **M** — the MCP working group is iterating quickly. The 2026-01-26 MCP Apps spec is brand new *(see §13 glossary hedge)*. |
| Impact | **M** — we lose Tier-2 cleanly if `ui://` semantics shift; we lose more if the core tool envelope changes. |
| Mitigation | Pin to the spec dated 2026-01-26 for Tier-2 *(see §13 glossary hedge)*; maintain a compatibility shim layer; subscribe to MCP working group RFCs; ship a minor release within two weeks of any breaking change. |

### 10.3 One of the seven Tier-0 harnesses drops or rewrites MCP support

| Field | Value |
|---|---|
| Likelihood | **L–M** — Cline and Continue.dev are the most plausible candidates; both are independent and could pivot. |
| Impact | **L** per harness, **M** cumulative if two drop. |
| Mitigation | The 7-harness matrix is in CHANGELOG every release; we document which harnesses are Tier-0 vs degraded; we will accept the downgrade and re-publish without trying to support a sunset harness. |

### 10.4 `ui://` rendering inconsistencies create perception of a broken product

| Field | Value |
|---|---|
| Likelihood | **H** — different hosts will render `ui://` with different CSP allow-lists, different iframe sandboxes, different postMessage timing. We have already flagged Claude Code's `ui://` rendering as unverified, and Codex CLI is silent on rich rendering. |
| Impact | **M** — users blame us when their card looks broken in Cline; this damages trust. |
| Mitigation | Ship Tier-2 as an explicit progressive enhancement, not a default; the README must say "Cline shows a URL, not a card, and that is correct"; provide a `--no-ui-apps` flag that turns the resource off; maintain a per-harness rendering screenshot suite. |

### 10.5 Canvas-side R&D cost spirals (the Year 3 workstream)

| Field | Value |
|---|---|
| Likelihood | **H** — every team that has tried to ship a canvas (Webflow, Framer, v0.dev, Anthropic) has spent multiple years on it. |
| Impact | **M** — if we promise canvas in Year 3 and miss, we look like a half-finished product. |
| Mitigation | Treat canvas as explicitly research, not roadmap; communicate v1.0 and v2.0 as the canvas-free, headless-first product; never sell to a team based on Year 3 canvas; if the R&D fails, declare "we are the headless half" and own it. |

### 10.6 Supply-chain attack via the npm package

| Field | Value |
|---|---|
| Likelihood | **L–M** — npm has had high-profile compromises (chalk, ua-parser-js); a small (~1-2 MB) MCP server that runs against private UI kits is an obvious target. |
| Impact | **H** — a compromised release could exfiltrate component IP, secrets, or LiteLLM tokens. |
| Mitigation | npm provenance attestations on every release; signed `.mcpb` bundles; dependency pinning with `npm audit signatures`; restrict release access to a 2-of-3 maintainer quorum; publish reproducible Docker images; document SBOM generation in the runbook. |

### 10.7 Legal/IP question around DesignSync verb interoperability

| Field | Value |
|---|---|
| Likelihood | **L** — the MCP spec is clear that tool names and schemas are server-declared, not part of the protocol, and Google v. Oracle established that API shape is generally fair use. Anthropic has not asserted IP over the DesignSync verbs. |
| Impact | **L–M** — a cease-and-desist would still be expensive even if eventually defensible. |
| Mitigation | (a) Document publicly that the verbs are mirrored *for interoperability* (Pillar 5), citing the MCP spec's server-declared-tool stance; (b) use the name `genie` — a generic word, not derived from any Anthropic mark, framed as an independent tool inspired by Claude Design, not a reproduction of it; (c) avoid using Anthropic logos, trademarks, or claude.ai favicons; (d) keep open lines with Anthropic developer relations and frame this as a complement, not a competitor. |

### 10.8 We lose the maintainer

| Field | Value |
|---|---|
| Likelihood | **M** — solo-maintainer burnout is the modal end-state for ambitious open-source projects. |
| Impact | **H** — abandonment kills adoption faster than competition does. |
| Mitigation | Recruit two co-maintainers before v1.0; document everything in `docs/`; use the `superpowers:finishing-a-development-branch` skill to keep handoffs clean; commit to a "no single point of failure" rule by Q2 2027. |

### 10.9 LiteLLM upstream outage as single-gateway dependency

| Field | Value |
|---|---|
| Likelihood | **M** — LiteLLM is a single process and any deployment's most concentrated dependency; restart, mis-config, or an upstream provider's quota event takes the gateway with it. |
| Impact | **H** — every `conjure`/`refine` call fails; the read/write verbs degrade gracefully (Principle 4) but the user-visible value collapses. |
| Mitigation | Document the multi-provider fall-through pattern in LiteLLM (`fallbacks: [...]`); ship a one-page runbook for LiteLLM restart/rollback; clarify in error messages that generation is the failed surface, not the whole product; publish health-check endpoints and operator-facing dashboards. |

### 10.10 Git-host / storage-pool data loss

| Field | Value |
|---|---|
| Likelihood | **L–M** — ZFS mirror reduces the single-disk-failure risk, but operator error (`zfs destroy`, accidental dataset removal, snapshot retention misconfig) is the leading cause of self-hosted data loss. |
| Impact | **H** — the UI-kit component store *is* the product; loss means starting over from scratch. |
| Mitigation | Document the ZFS snapshot policy in `docs/06-operations-runbook.md`; require off-pool replication (`zfs send` to a second machine or rsync.net); publish a recovery drill that operators must run before going to production; treat backups as a release-blocker for the shared-deploy path. |

### 10.11 License drift in transitive dependencies

| Field | Value |
|---|---|
| Likelihood | **M** — npm tree changes weekly; a single transitive dependency relicensing to GPL/AGPL or business-source contaminates the MIT promise. |
| Impact | **M** — adopters in regulated industries can be forced to rip the server out; the MIT positioning that anchors Pillar 4 fragments. |
| Mitigation | Run `license-checker` in CI on every PR with an MIT/BSD/Apache/ISC allowlist; pin dependencies in `package-lock.json`; publish SBOM with every release; review every new direct dependency for license compatibility before merge. |

### 10.12 OIDC provider churn breaks auth

| Field | Value |
|---|---|
| Likelihood | **M** — OIDC providers can change discovery metadata, token claims, or admin APIs across major releases. |
| Impact | **M** — shared deployments become unable to log in until the operator pins a known-good IdP version. |
| Mitigation | Test against last-known-good versions of each reference IdP in CI; document the supported version matrix in `docs/06-operations-runbook.md`; emit clear diagnostic errors when an unexpected token shape arrives; keep the static-bearer fallback path always-available so an OIDC outage is recoverable in minutes. |

### 10.13 Optional gallery privacy exposure

| Field | Value |
|---|---|
| Likelihood | **M** — a future opt-in preview gallery can ingest user-generated UI, which can include screenshots, names, copy, and brand IP from EU residents. |
| Impact | **H** — a single complaint can trigger DSAR/erasure obligations the maintainer team is not staffed to handle. |
| Mitigation | Keep any gallery opt-in and self-hostable by default; publish a privacy notice and a DPA template before any managed URL goes live; require explicit operator opt-in for any data leaving the operator's own infrastructure; treat managed gallery launch as a separate go/no-go gate. |

---

## 11. Success criteria for the next 12 months

| # | Criterion | Threshold | Measurement method |
|---|---|---|---|
| 1 | The 7-harness smoke test passes on every release | 100% green for ≥ 12 consecutive monthly releases | CI matrix in GitHub Actions; per-harness screenshots in `tests/screenshots/` |
| 2 | Weekly active component-store mutations | ≥ 2,500 distinct (repo, week, harness) triples by end of month 12 | Anonymized telemetry from self-hosted deployments (opt-in) + public GitHub event sampling |
| 3 | Non-Claude-Code harness share of mutations | ≥ 40% of mutations originate from Codex CLI / Copilot / Cursor / Cline / Continue / Claude Desktop combined | Same telemetry segmentation |
| 4 | Median `preview` latency | ≤ 600 ms p50, ≤ 1500 ms p95 | Built-in `@ambitresearch/genie-viewer` telemetry; OTel traces in reference deployment |
| 5 | `validate` failure rate per project per week | ≤ 3% | Aggregated from `validate` calls |
| 6 | Public adopter case studies | ≥ 3 named external teams with public blog post, talk, or testimonial | Tracked in `docs/case-studies/` |
| 7 | npm download trajectory | ≥ 1,000 weekly downloads of `genie` by month 12 | npmtrends.com snapshots |
| 8 | Round-trip with hosted Claude Design verified | At least one documented end-to-end test where a project authored in genie uploads cleanly via real `/design-sync` and re-imports back | Test recording + project artifact in `tests/round-trip/` |

---

## 12. What "done" looks like for v1.0

The GA shipping checklist. v1.0 ships when all 15 items are checked.

- [ ] **All 13 genie verbs implemented** — `list_kits`, `get_kit`,
      `list_files`, `read_file`, `create_kit`, `plan`, `write_files`,
      `delete_files`, `validate`, `list_components`, plus the generation verbs
      `conjure`, `refine`, `preview`.
- [ ] **The plan-vs-write guard rejects out-of-plan paths** — automated tests
      mirror the bundled skill's "Calling write, delete, register, or
      unregister without a valid planId, or with paths outside the plan, is
      rejected" contract.
- [ ] **The five-step atomic upload sequence works correctly** — sentinel first,
      content chunks ≤ 256, deletes, re-arm sentinel, anchor last; recovery
      from mid-sequence failure has integration tests.
- [ ] **`@genie` validator passes genie's own regex test fixtures** —
      `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/` against the fixture suite.
- [ ] **`manifest.json` compiles deterministically** from the component store,
      reproducibly across runs.
- [ ] **The configured LLM endpoint routes through `design-default` alias by default**
      with environment-driven override.
- [ ] **Vite-backed viewer ships as `@ambitresearch/genie-viewer`** with HMR on
      `preview.html` saves; opens to a grouped card grid.
- [ ] **`ui://genie/grid` resource registers and renders in Claude
      and VS Code (Stable, Jan 2026 milestone)** — manual screenshot suite
      attached to the release.
- [ ] **`.mcpb` bundle installs in Claude Desktop on macOS, Windows, Linux** —
      double-click flow proven.
- [ ] **OAuth 2.0 + Dynamic Client Registration works for Claude Code and Codex
      CLI over Streamable HTTP** — tested against a reference OIDC provider.
- [ ] **Static `Authorization: Bearer` works for VS Code Copilot, Cline,
      Continue.dev** — per-harness README snippets verified.
- [ ] **7-harness compatibility matrix in CHANGELOG** — every entry is `✅`,
      `⚠️ degraded`, or `❌ not supported`, with screenshots.
- [ ] **Git-host backend reference deployment proven on a self-hosted storage pool** —
      `docs/06-operations-runbook.md` includes the exact commands.
- [ ] **Round-trip with hosted `claude.ai/design` proven** — one external user
      uploads a genie project via real `/design-sync` and reports
      success.
- [ ] **MIT license, MIT-licensed dependencies only, SBOM published, npm
      provenance signed.**

---

## 13. Glossary

**MCP** — Model Context Protocol. An open spec at
[modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)
that standardizes transport, lifecycle, and security principles for connecting
AI clients (harnesses) to capability servers. The spec defines the envelope; tool
names and schemas are declared by individual servers.

**DesignSync** — Anthropic's internal MCP tool, bundled with Claude Code, that
exposes a 12-method protocol for pushing a code-defined UI kit into a
`claude.ai/design` project. Its schema is injected into the model's tool catalog
at session start and is not in the public developer docs.

**`@dsCard`** — *Anthropic's* first-line HTML comment marker
(`<!-- @dsCard group="…" -->`) that registers a preview file as a Claude Design
card. Validated by the regex `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/` in
`package-validate.mjs`; missing it raises `[DSCARD_MISSING]` and fails the build.
genie's **native** equivalent is `@genie` (D-B); the `@dsCard` form is read/written
only by the optional interop adapter.

**`manifest.json` / `_ds_manifest.json` / `ds_manifest`** — The compiled index
of all cards in a Claude Design project. In Anthropic's product, this is
regenerated server-side by `claude.ai/design`'s self-check from each
`<Name>.d.ts` and `<Name>.html`. genie compiles its own index **client-side** to
`.genie/manifest.json` (D-D); the Anthropic-side `_ds_manifest.json` is only an
interop target.

**`_ds_needs_recompile`** — *Anthropic's* sentinel file, written first in an
upload sequence to fence the server's manifest/copy machinery. genie's native
equivalent is `.genie/recompile` (D-C), body `{"by": "genie"}`; the `_ds_*` name
is interop-only.

**`_ds_sync.json`** — *Anthropic's* verification anchor, written **last** in an
upload sequence, carrying `sourceHashes`, `renderHashes`, and a `verified` array.
genie's native equivalent is `.genie/sync.json` (D-C). A mid-plan failure must
leave the anchor absent so the next sync can repair from the diff.

**`ui://` resource** — A URI scheme defined by the MCP Apps spec *(targeted Jan
2026; see INDEX honest-uncertainty #4)* for delivering inline interactive UI as
part of a tool result. MIME type `text/html;profile=mcp-app`. Linked from a tool
result via `_meta.ui.resourceUri`. Rendered inline in **4 first-class targets
(Claude, VS Code Stable Jan 2026, ChatGPT, Cursor) + 3 ecosystem renderers
(Goose, Postman, MCPJam) that also render `ui://` but are not v1.0 launch
targets**.

**`.mcpb`** — The Model Context Protocol Bundle format, used for double-click
install into Claude Desktop. Packaged via `npx @modelcontextprotocol/mcpb pack`.
Successor to the earlier `anthropics/dxt` toolchain.

**LiteLLM** — Open-source OpenAI-compatible gateway that routes LLM requests
across providers and enforces per-key budgets and rate limits. It is genie's
**reference** generation endpoint — the operator points genie at their own
gateway URL (env-configured; nothing hardcoded). It replaces Anthropic's
subscription metering with operator-owned
budgets.

**Harness** — An AI client that hosts an MCP server connection. Our Tier-0
harnesses: Claude Code, Claude Desktop, Codex CLI, GitHub Copilot in VS Code
agent mode, Cursor, Cline, Continue.dev.

**stdio transport** — The simplest MCP transport, where the server is a child
process and JSON-RPC flows over stdin/stdout. Used by Claude Desktop and
local-dev configurations.

**Streamable HTTP transport** — The remote MCP transport (alias `streamable-http`
in Claude Code's JSON config). Supports OAuth and long-lived connections. Our
recommended transport for any non-local deployment.

**`plan`** — The single user-visible permission grant in genie's native
protocol. Locks an allowlist of write/delete paths and a local source
directory. Returns a `planId`. Every subsequent write/delete must reference that
`planId` and stay inside the allowlist.

**Adherence config** — The `_adherence.oxlintrc.json`-shaped rule set generated
from a UI kit's `.d.ts` files. Used by the canvas agent to score
generated UI against the team's real components. Schema is undocumented by
Anthropic; we reconstruct ours via `ts-morph` and treat it as ownable.

**Tier-0 / Tier-1 / Tier-2** — Our shorthand for MCP capability tiers across
harnesses. Tier-0 is universal (tools + structured JSON). Tier-1 adds resources
and prompts (Claude Code, Cursor, VS Code). Tier-2 adds `ui://` inline
rendering (Claude, VS Code Stable Jan 2026, ChatGPT, Cursor).

**`PROJECT_TYPE_DESIGN_SYSTEM`** — The `claude.ai/design` project type, used to
filter Claude Design projects in the future interop bridge. Immutable at creation
in Anthropic's hosted product; not part of genie's native `.genie/` contract.

**Interop bridge** — A future opt-in adapter that reads/writes Anthropic-compatible
project shapes so users can migrate in either direction. This replaced the earlier
"reversibility as a pillar" assumption.

**Tier-0 universal harnesses** — The seven harnesses we commit to supporting on
day one: Claude Code, Claude Desktop, Codex CLI, GitHub Copilot (VS Code agent
mode), Cursor, Cline, Continue.dev.

**Gitea** — Self-hostable git server. One supported shared-store backend, not the
native assumption. In any git-host backend, a "project" is a repo, a `planId` is a
branch, `plan` opens a PR where supported, `write_files` commits, and merge is atomic publish.

**`@genie` regex** — `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`. genie's native
card-validator test (D-B). The Anthropic `@dsCard` regex
(`/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/`, from `package-validate.mjs`) lives
only in the optional interop adapter.

**Tool-name shape** — `mcp__genie__<verb>`. Mandated by Claude
Code's MCP page; characters outside `[A-Za-z0-9_-]` are rewritten to `_`. Tool
descriptions truncate at 2 KB.

---

[^claude-design]: Per the Anthropic launch announcement,
    <https://www.anthropic.com/news/claude-design-anthropic-labs> — re-verify
    URL pre-publication; "Opus 4.7" is the marketing label, and LiteLLM
    resolves it to the `anthropic/claude-opus-4-8` SKU.
