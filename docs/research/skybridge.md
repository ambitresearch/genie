# Resource — Skybridge (React framework for MCP Apps)

> **Type:** External tool / framework evaluation
> **Added:** 2026-06-22 · **Researched:** 2026-06-23
> **Source:** <https://www.skybridge.tech/> (found via Product Hunt)
> **Status of this note:** ✅ deep-research verification pass complete (98 agents,
> 75 claims → 25 adversarially verified → 16 confirmed / 9 killed → 7 findings).
> Raw report: `docs/research/skybridge.json`. **Verified findings**
> + **Recommendation** are in §6–§8 below; §1–§4 are the original pre-research capture.
> **Verdict:** 🟡 **PARTIALLY ADOPT (spike-then-decide, guardrails required).**
> **Decision owner:** Roshan. **Affects:** RFC §5.2, §6.5, §6.9, G-5; PRD preview-surface stories; M4 milestone.

---

## 1. What it is (per vendor site, unverified)

Skybridge bills itself as **"the full-stack React framework for MCP apps and MCP
servers"** / **"The React framework for MCP Apps."** It is a *framework / developer
toolkit* — **not** a server, host, gateway, auth layer, or hosting platform. You
use it to *build* MCP servers and the MCP-Apps UI that renders inside MCP clients.

- **License:** MIT ("Every line of Skybridge is MIT-licensed"). Open source.
- **Getting started:** `npm create skybridge`.
- **Made by:** self-described "active contributors to the official MCP Apps
  extension" / "Built by MCP Apps contributors." Claims to be recommended in
  OpenAI docs / dev blog.
- **Deployment:** appears to lean on a separate platform, **Alpic** (relationship
  + whether it's required vs optional is an open question → research angle 3).

### Named capabilities (vendor copy)
- **Write once, run everywhere** — abstracts client differences across Claude,
  ChatGPT, VS Code, Cursor, Goose.
- **Type-safe end-to-end** — "tRPC-style inference from MCP server tool definition
  to React view."
- **React friendly** — react-query–style hooks for binding views to server tools.
- **Delightful dev environment** — emulator, HMR, tunnel.
- **Agent-ready** — Skills, CLI, and devtools APIs aimed at coding agents.
- **Example library** — production-ready examples.

### DevTools (vendor copy)
- **Hot module reload**
- **Local emulator** — run Claude/ChatGPT surfaces locally
- **Public tunnel** — stable HTTPS URL
- **Server audit** — tests a server against Claude/ChatGPT guidelines

### Vendor metrics — **UNVERIFIED, flagged for research**
- "Powering **10%** of the MCP apps in Claude and ChatGPT" ⚠️
- "**100K** monthly npm downloads" ⚠️
- "**1K+** GitHub stars" ⚠️
- Community: GitHub, Discord, X.

---

## 2. Why it matters to genie

genie's wedge is **harness-agnostic MCP-App UI** — the live component-preview grid
+ UI-kit browser that renders inside Claude Code / Cursor / VS Code / ChatGPT. The
current plan **hand-rolls** exactly the layer Skybridge productizes:

| genie plan (RFC) | Skybridge equivalent | Overlap |
|---|---|---|
| §6.9 Vite multi-page viewer (`@genie/viewer`) + chokidar HMR | "Delightful dev environment" — emulator, HMR, tunnel | **High** |
| §6.5 `ui://genie/grid` MCP-App payload + postMessage protocol | core "MCP Apps" React view binding | **High** |
| G-5 "one artifact, three vehicles" (file://, localhost, ui://) | "Write once, run everywhere" | **High** |
| §6.2 hand-written Zod tool schemas → manual `_meta.ui` wiring | "tRPC-style inference, tool def → React view" | **Medium** |
| §6.10 OAuth-DCR / bearer auth | (Skybridge is not an auth layer) | **None** |
| §6.6 LiteLLM client, §6.7 Gitea store, §6.8 manifest compiler | (server-side, framework-agnostic) | **None** |

**The decision is scoped to the preview/UI tier only.** genie's server core
(LiteLLM, Gitea store, DesignSync 12-method mirror, `@dsCard` compiler, atomic sync)
is unaffected either way.

---

## 3. Open questions the research must answer

1. **Architecture reality** — what does a Skybridge MCP App actually look like in
   code? Does the tRPC-style binding hold up? (angle 1)
2. **Cross-harness parity** — does "write once, run everywhere" actually deliver
   across Claude Desktop / ChatGPT / Cursor / VS Code / Goose **and** the MCP-Apps
   display modes (inline / fullscreen / pip)? Where does it leak? (angle 2)
3. **vs hand-rolled / mcp-ui** — tradeoffs, lock-in, the **Alpic deployment
   dependency**, and crucially whether the **embedded-tier CSP constraints**
   (`default-src 'none'`, no web fonts, `connect-src 'none'`) are handled. genie's
   two-tier design system depends on this. (angle 3)
4. **Maturity & risk** — verify the 10% / 100K / 1K-star claims; production
   readiness; governance; how tightly coupled to the **still-draft** MCP Apps
   extension (genie deliberately tracks the 2026-01-26 spec). (angle 4)
5. **Concrete fit** — would genie's two-surface app (preview grid + UI-kit file
   browser) with refine/generate flows net gain or lose vs the current plan? (angle 5)

## 4. Pre-research lean (to be confirmed/overturned)

Provisional, **not** a decision — recorded so the research can challenge it:

- **Likely "partially adopt" or "spike-then-decide."** Skybridge maps cleanly onto
  the *most speculative, least-built* part of genie (M4 preview tier), so the
  switching cost is low today and rises after M4 is hand-built. That argues for
  deciding **before** M4 starts.
- **Two genuine risks to weigh:** (a) coupling genie to a young framework tracking
  a *draft* spec genie already tracks directly; (b) the **Alpic** dependency
  potentially pulling genie toward a hosted-deploy story that conflicts with the
  npm + `.mcpb` + Docker self-host distribution (G-8) and the "harness-native, no
  app to open" positioning.
- **Hard constraint:** anything adopted must preserve **G-5 byte-identical cards
  across file:// / localhost / ui://** and the **embedded-tier CSP** limits, or it
  is disqualified regardless of DX wins.

---

## 5. Links
- Site: <https://www.skybridge.tech/> · Docs: <https://docs.skybridge.tech/> · Repo: <https://github.com/alpic-ai/skybridge>
- npm: `skybridge` + `create-skybridge` · Deploy platform: <https://www.alpic.ai/>
- MCP Apps spec (SEP-1865, **Final** 2026-01-28): <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865>
- MCP Apps ext (2026-01-26 spec genie tracks): <https://github.com/modelcontextprotocol/ext-apps>
- mcp-ui (vendor-neutral alternative, same lineage): <https://github.com/idosal/mcp-ui> · <https://mcpui.dev>
- OpenAI Apps SDK custom-UX: <https://developers.openai.com/apps-sdk/build/custom-ux>
- MCP Apps announcement: <https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/>

---

## 6. Verified findings (deep-research, 2026-06-23)

> Method: 5 search angles → 16 sources fetched → 75 falsifiable claims → 3-vote
> adversarial verification (≥2/3 refutes kills a claim) → 7 synthesized findings.
> Confidence + vote tallies are the workflow's; full evidence in the raw JSON.

**F1 — Skybridge is a real full-stack framework, not a thin SDK wrapper.** `[high, 3-0]`
MIT-licensed TypeScript/React. tRPC-style type inference binds MCP server tool
definitions to React views (typed hooks `useToolInfo<"…">()`, declarative
`view:{component:…}` registration; server schema changes surface instantly as
widget typecheck errors). Real DevTools at `localhost:3000`, instant HMR, and
`npm run dev -- --tunnel` → public URL + live LLM playground for real MCP clients.
*(The advertised "server audit" feature is NOT documented — vendor copy overstates.)*

**F2 — "Write once, run everywhere" is a direction, not a guarantee.** `[high, 3-0]`
The MCP Apps spec **explicitly refuses** to promise cross-host parity: its goal is
to *reduce* fragmentation, "hosts can gradually adopt UI support at their own pace,"
and servers "should provide text-only fallback." OpenAI's own docs call
`window.openai` a ChatGPT-only "compatibility layer" you "shouldn't depend on for
baseline MCP Apps compatibility." **This is the finding that most affects genie's
harness-agnostic identity** — the parity genie's wedge assumes is nobody's contract.

**F3 — Lock-in risk is low: Skybridge is sugar over a standard genie can implement directly.** `[high, 3-0]`
The MCP Apps standard models UI as predeclared `ui://` resources (mimeType
`text/html+mcp`) referenced by tool metadata, rendered in sandboxed iframes,
talking via JSON-RPC over postMessage — buildable with the raw
`@modelcontextprotocol/sdk`. Skybridge README confirms self-hosting "on any
Node.js-compatible platform"; **Alpic is optional, not required.** genie keeps a
cheap ejection path to raw `ui://` at any time.

**F4 — mcp-ui is a viable vendor-neutral fallback — and now the *same lineage* as the standard.** `[high, 3-0]`
MIT SDK (`@mcp-ui/server` + `@mcp-ui/client`), no hosted-platform dependency, binds
tools to UI via `ui://` + `_meta.ui.resourceUri`. SEP-1865 was **authored by
mcp-ui's creator (Ido Salomon)** and absorbed mcp-ui's approach — so "Skybridge vs
mcp-ui vs hand-rolled" are three points on *one* standard, not rival bets.

**F5 — The spec is finalized but young; the "still-draft" framing was outdated.** `[high, 3-0]`
SEP-1865 is **Status: Final** (created 2025-11-21, merged 2026-01-28). But it's
self-described as "intentionally lean… core patterns we plan on expanding," an
"optional extension" with an "early access SDK." A maturity risk any dependent
framework inherits — finalized core, expanding edges.

**F6 — Adoption metrics partially check out; the headline ones do NOT.** `[high, 3-0]`
Core `skybridge` npm: **97,332 downloads/30d** — matches "~100K monthly" within 3%.
But the honest proxy for *new projects* is `create-skybridge`: **52,929/30d (~53K)**;
the core number is inflated by CI/transitive pulls (90-day ratio ~2:1). **The
"~10% of MCP apps" and "1K+ GitHub stars" claims were NOT verified** (excluded from
confirmation). Treat vendor marketing figures as unproven.

**F7 — Concrete fit for genie: material benefit, but adopt partial + guarded.** `[medium, synthesized]`
*Gains:* type-safe tool→view binding maps cleanly onto generate/refine round-trips;
DevTools + `--tunnel` let genie test the preview-grid + file-browser against real
MCP clients pre-ship; MIT + optional self-host avoid hard lock-in; the `ui://`+iframe
escape hatch stays open. *Losses/risks:* genie's harness-agnostic claim leans on
cross-harness parity nobody guarantees (F2) and Skybridge's docs only demonstrate
ChatGPT/Claude/VSCode; **embedded-tier CSP handling and inline/fullscreen/pip parity
are unproven in the evidence.**

---

## 7. Caveats & open questions

**Verification caveats (weigh before acting):**
- The workflow's **WebSearch tool was degraded** across most verifications, so
  independent external corroboration is thinner than the source count implies —
  confirmed claims lean on *primary* fetches (official spec/blog, PR #1865, OpenAI
  Apps SDK docs, Skybridge's own docs/repo, npm API) and self-descriptions.
- **npm figures are a single 30-day snapshot** (ending 2026-06-21), CI-inflated —
  not sustained or human-only adoption.

**Question-critical items that came back UNKNOWN (not negative — just unproven):**
1. **Embedded-tier CSP** (`default-src 'none'`, no web fonts, `connect-src 'none'`):
   no evidence Skybridge handles genie's hard constraint. **Must be validated by spike.**
2. **Display-mode parity** (inline / fullscreen / pip): Skybridge docs only show
   `inline`/`fullscreen` examples; pip unaddressed.
3. **Cross-harness reach beyond ChatGPT/Claude/VSCode:** **Cursor and Goose are not
   named** in any Skybridge doc. genie's harness-agnostic claim needs hands-on
   per-harness validation.
4. **Self-host completeness off Alpic:** README asserts Node.js self-hosting but
   defers actual steps to an external guide; Alpic's premium add-ons (analytics,
   tunneling, store-compliance) may carry hidden ops caveats.

**Notable refutations (claims the panel KILLED):**
- ✗ "Skybridge npm is ISC-licensed" → killed 0-3 (it **is** MIT).
- ✗ "OpenAI's Apps SDK docs reference Skybridge by name" → killed 0-3 (unconfirmed).
- ✗ "Deploy can target Cloudflare Workers / any infra" → killed 0-3 (only Node.js
  self-host + Alpic confirmed; broader targets unproven).
- ✗ "mcp-ui's iframe rendering addresses genie's CSP concern at the renderer level"
  → killed 0-3 (iframe isolation ≠ confirmed CSP-constraint handling).

---

## 8. Recommendation — 🟡 PARTIALLY ADOPT (spike-then-decide)

**Bottom line:** Skybridge is genuinely good and low-lock-in, but its core selling
point for genie — cross-harness parity — is exactly the thing *no one guarantees*
and Skybridge doesn't demonstrate past three hosts. So **prototype on it for
velocity, but gate the real bet on a spike that proves genie's hard constraints.**

**Do this, in order:**
1. **Time-boxed spike (before M4 hand-build starts).** Stand up genie's `ui://genie/grid`
   preview surface in Skybridge and **prove or disprove** the three UNKNOWNs: embedded
   CSP (`default-src 'none'` + no web fonts), inline/fullscreen/pip parity, and
   real rendering inside **Cursor + VS Code** (genie's actual target harnesses).
2. **Keep the escape hatch explicit.** Because Skybridge is sugar over `ui://`+iframe
   (F3), architect genie's viewer so the card payload is framework-agnostic — ejectable
   to raw `@modelcontextprotocol/sdk` or **mcp-ui** (F4) without touching server core.
3. **Disqualify on constraint failure, not DX.** If the spike shows CSP or
   byte-identical-card (G-5) violations that Skybridge can't cleanly satisfy, **don't
   adopt** regardless of the velocity win — fall back to the hand-rolled §6.9 viewer.
4. **Never put Alpic on genie's critical path.** Self-host only; Alpic stays an
   optional convenience, never a dependency (protects G-8 npm/.mcpb/Docker distribution).
5. **Treat vendor metrics as unproven.** The "~10% of MCP apps" / "1K+ stars" claims
   didn't verify; decide on the architecture (F1–F4), not the marketing (F6).

**Why not "adopt" outright:** the cross-harness guarantee genie's identity needs
isn't real (F2), and the genie-specific blockers (CSP, pip, Cursor/Goose) are
*unproven*, not *solved*. **Why not "don't adopt":** lock-in is genuinely low (F3),
the DX gains are real and land on genie's least-built tier (F7), and the ejection
path to a standardized primitive stays open. Spike-then-decide captures the upside
while keeping genie's harness-agnostic wedge falsifiable instead of assumed.
