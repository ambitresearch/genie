# genie — Decision Record (the spine)

> **Status: accepted (2026-06-24)** · Establishes genie's native conventions and
> positions round-trip interop with hosted tools (e.g. Claude Design) as an optional,
> opt-in bridge rather than the product foundation.
>
> This is the **source of truth** for genie's own conventions. It was ratified
> visually first in `docs/research/how-genie-works.svg` (the "How genie works"
> explainer), then written down here. All plan docs and the GitHub issue backlog
> derive from this file. When a downstream doc disagrees with this one, this one
> wins until amended.

---

## Why this exists

genie is **an independent, MIT-licensed** tool for harness-native UI-component
generation, inspired by familiar MCP UI patterns rather than tied to any hosted
product. It speaks its **own conventions natively**: a self-hostable MCP server with
no hosted lock-in in the critical path. Round-trip interop with hosted tools like
Claude Design (and import from Google Stitch) is a **future opt-in bridge**, not the
foundation.

This record captures those native conventions, plus the product-shape decisions that
fell out of designing them.

---

## D0 — Posture: own conventions native, interop is a future bridge

- genie's native protocol, marker, file layout, and URI scheme are **its own** (D-A..D-E below).
- **Reversibility is demoted** from a Pillar to an optional, post-v1 **interop mode**:
  an opt-in adapter that can read/write Anthropic's `@dsCard` / `_ds_*` shapes to
  round-trip a Claude Design project, and (separately) import from Google Stitch.
- We still **describe** Claude Design accurately as the inspiration, and we still
  **preserve Anthropic's exact terms** (`@dsCard`, `DesignSync`, `_ds_*`, `design-sync`)
  *as references* — in explanatory prose and in the future interop adapter — never as
  genie's own native surface.

**Consequence:** genie's native surface is "own conventions, optional bridges": the
product is defined by genie's own verbs, marker, and file names, while interop with
DesignSync shapes lives only in explanatory prose or a future opt-in adapter — never
in the native surface.

---

## D-A — Tool names: 16 inherited verbs → genie's 13

Same protocol *shape* as DesignSync (read freely → one permission gate → write scoped to
a plan), but genie's own names. Structural verbs stay boringly clear; only the generation
verbs carry the genie identity (the same scarcity rule as the clay accent).

| Claude Design verb | genie verb | Note |
|---|---|---|
| `list_projects` | **`list_kits`** | "kit", not "project" — *project* now means screens (D-F) |
| `get_project` | **`get_kit`** | metadata + `canEdit` |
| `list_files` | **`list_files`** | kept — already clear |
| `get_file` | **`read_file`** | verb-first reads better than `get_` |
| `create_project` | **`create_kit`** | scaffold a new kit |
| `list_components` | **`list_components`** | kept |
| `finalize_plan` | **`plan`** | the one permission gate → returns `planId` |
| `write_files` | **`write_files`** | kept — cite `planId`, ≤256/call |
| `delete_files` | **`delete_files`** | kept — cite `planId` |
| `report_validate` + `validate_design_system` | **`validate`** | **two verbs merged into one** |
| `register_assets` | **✕ dropped** | the marker IS the registration (D-B) |
| `unregister_assets` | **✕ dropped** | delete the file instead |
| `generate_component` | **`conjure`** | the front-door CTA already says "Conjure" |
| `refine_component` | **`refine`** | comment-pins + region-scoped sliders |
| `render_preview` | **`preview`** | returns the `ui://` grid for MCP-App hosts |

**Net for the kit/component core: 16 → 13 verbs.** Namespace every harness sees:
`mcp__genie__<verb>`. M1 also adds the project verbs in D-F:
`list_projects`, `get_project`, `create_project`, `delete_project`, `bind_kit`, and
`conjure_screen`. Reusing the freed-up name `list_projects` for *screens* projects is
intentional and safe, since the kit enumerator is now `list_kits`.

---

## D-B — Card marker: `@dsCard` → `@genie`

- Native marker on the first line of a preview file:
  `<!-- @genie group="…" -->`
- Same mechanics (first line registers the card; missing it fails the build), genie's name.
- Native regex: `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`
- The Anthropic `@dsCard` regex `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/` lives **only**
  in the future interop adapter.

---

## D-C — Bookkeeping files: scattered `_ds_*` at root → one `.genie/` dir

- DesignSync litters the kit root with `_ds_sync.json`, `_ds_needs_recompile`, etc.
- genie's improvement: **one tidy `.genie/` directory** holds all server bookkeeping:
  - `.genie/sync.json` — verification anchor, written last (was `_ds_sync.json`)
  - `.genie/recompile` — sentinel (was `_ds_needs_recompile`)
  - `.genie/manifest.json` — compiled card index (D-D)
  - `.genie/plans.sqlite` — in-flight plan/TTL scratch (the only sqlite, throwaway)
- The atomic write *sequence* is unchanged: sentinel → writes ≤256 → deletes → re-arm → anchor last.

---

## D-D — Manifest: `manifest.json` at root → `.genie/manifest.json`

- Compiled from the `@genie` markers; the viewer reads it.
- Moves under `.genie/` with the rest of the bookkeeping (D-C).

---

## D-E — Resource URI scheme: `ds://` → `genie://`

- Native resource scheme: `genie://components/{group}/{name}`, `genie://manifest`,
  `genie://tokens/{file}`.
- **Exception, do not change:** the MCP-App payload stays `ui://genie/grid` — the
  `ui://` prefix is fixed by the MCP Apps spec, not ours to rename.

---

## D-F — Two things genie operates on: kits **and** projects

genie works on **both ends of the library→consumer arrow** that already exists in the world.

- A **kit** is the library — components (Button, Card, Input), tokens, the design language.
  Produces a *card* in the grid.
- A **project** is the screens you build *with* a kit — web / app / mobile pages and flows.
  Produces a *full-page preview*, constrained to the bound kit's components.
- A project binds one or more kits and names a **default**.
- A **blueprint** is a reusable project template: `project.kind = "blueprint"`.
  Instantiating it creates a new `workspace` project with copied starter files and explicit
  kit bindings; later blueprint edits do not silently mutate derived workspaces.
- **Built in M1:** the kit/component core plus the project/blueprint foundation and
  `conjure_screen` contract land together.

### Default-kit resolution (when you ask genie to design a screen)

1. **explicit** — you named a kit in the request → use it
2. **default** — the project's bound default (in `.genie/project.json`) → use it
3. **sole** — exactly one kit is reachable → use it, and name which
4. **none / ambiguous** → **stop and ask** before using UI-kit-specific components.
   A kitless project may generate basic structure, but it must never invent a kit or fall
   back to generic component APIs. e.g. *"No kit bound to `marketing-site`. Bind one, or
   pick: acme-ui, icons-kit."*

A "screen" is a generated, previewed, refined, committed artifact — the **same loop** as a
component, one step up. It is **not** a freeform drag-to-reflow canvas (that remains the
parked NG-1 anti-goal).

---

## D-G — Storage: any git host (not Gitea-specific)

- genie writes to a **git-tracked tree**. The reference backends are local FS / GitHub /
  Gitea / GitLab — **any git host**, swappable. (Generalizes the old Gitea-only language.)
- A kit/project takes one of **three shapes**, and genie is jailed to its root in all three:
  - **A — standalone repo** (team default): kit is its own repo in its own dir; the app
    consumes it as a package (`"@acme/ui": "^4.2.0"`). genie owns the repo fully.
  - **B — monorepo subtree** (common case): a single repo; genie is scoped to e.g.
    `packages/ui/`. genie writes files; **you** commit, your flow.
  - **C — local folder** (solo): a directory genie writes to; `git init` optional.
- **Hard invariant:** never a repo nested inside a repo. A kit is *either* its own repo
  *or* a subtree, never a `git init` inside your working tree. `create_kit` refuses it.
- The slick mapping — `plan`→branch, `write_files`→commits, finalize→PR, merge→publish,
  rollback→`git revert`, `git log`→audit — is **full-fidelity only in Shape A** (genie
  owns the repo). In Shape B it degrades gracefully: `plan` still scopes & validates, but
  the commit is yours; no PRs opened behind your back.
- **No database for content.** The git log is the audit log. sqlite is used *only* for
  throwaway server scratch (`.genie/plans.sqlite`, plan TTLs).

---

## D-H — Generation: any OpenAI-compatible endpoint (not LiteLLM-specific)

- genie calls a **configurable OpenAI-compatible chat-completions endpoint**. LiteLLM is
  the reference, but Ollama / OpenAI / vLLM / any compatible gateway all work.
- You own the model, the budget, the rate limits. The endpoint is configured per
  deployment; no provider URLs or IPs are hardcoded in the docs or the server.

---

## D-I — Inside the two clay moments (the actual machine)

The model writes the code; genie makes it **provably yours**. Grounding in, validation out
— that conjunction is the moat, not the LLM.

### `conjure` — sentence → kit-conformant component (M2, fully spec'd)

1. **Assemble context (the grounding):** the bound kit's tokens, the `.d.ts` contracts of
   existing primitives, the adherence rules, one or two existing components as few-shot.
2. **Build the system prompt:** grounding + the 5-file artifact contract + the `@genie`
   marker requirement + framework.
3. **Constrained generation (the one model call):** to the configured endpoint with
   `response_format: json_schema` (forces 5 well-formed files), streamed for progress.
4. **The validation gauntlet** (where "yours" is enforced, mechanically):
   - `@genie` marker present on line 1?
   - imports from `tokens/`, **no hardcoded `#hex`**?
   - passes the adherence lint?
   - actually **renders**? (Playwright headless — non-trivial body, not blank/thin)
   - any failure → **one self-repair retry**, feeding the validator's error back to the model.
5. **Extract the contract:** ts-morph reads the `.tsx` → emits the `.d.ts` — the grounding
   the *next* generation reads.
6. **Seal:** `plan` → `write_files` → anchor; lands as a real, validated git commit.

### `refine` — mutate one thing, provably freeze the rest

1. **Diff, not rewrite (solid):** current files + instruction → the model returns a
   **unified diff**, applied with `patch`, re-validated through the same gauntlet. Asking
   for a diff is what makes "the rest is untouched" *provable* — it can't restate what it
   didn't change.
2. **Sliders = re-parameterization (solid):** at generation, genie detects the component's
   axes (size, radius, shadow, accent) and surfaces knobs mapped to token values. Dragging
   a slider makes **no model call** — instant & free. Only a *structural* change hits the LLM.
3. **Region-scoped refine (R&D edge):** a comment-pin gives a rect; genie annotates the
   prompt ("limit changes to this region") and scopes the diff where it can. Mapping a
   *pixel rect → source lines* is the hard part — **in v1 it's a hint, not a hard constraint.**

**The honest line:** genie mechanically verifies *"it's your code"* (imports tokens, no raw
hex, passes adherence, renders). It **cannot** verify *"it's beautiful."* Taste scales with
whatever model you point it at; genie is the harness, not the brain. This is exactly the
NG-2 split — genie ships the **headless generation loop** in v1; pixel-precise canvas
refinement stays parked R&D.

---

## D-J — Sequencing

- **Now (M0):** scaffold (done). Make the architecture **kit-and-project-aware** so M1 can
  ship both boundaries cleanly.
- **M1:** the **kit + project foundation**: the 13 kit/component verbs, six project verbs,
  blueprint-as-project manifests, storage abstraction, and conformance tests.
- **M1–M3:** the component-card loop (`@genie` marker, `.genie/` layout, validate +
  manifest compiler).
- **M2:** the `conjure` / `refine` generation mechanics (D-I).
- **M4:** preview viewer (Vite + `ui://`).
- **M5:** auth + distribution + smoke tests.
- **Post-core project UX:** richer full-page previews and review flows build on the M1
  project model rather than introducing new nouns.
- **Parked R&D (Year 2/3):** region→source precision, the visual canvas, the interop bridges.

---

## D-K — Preview filename: the viewer/HMR discovery mirrors the compiler's `*.html` walk

> **Status: accepted (2026-07-09)** · Resolves DRO-821 (M4 follow-up to DRO-266). The
> viewer's Vite entry glob and the HMR card classifier match **any `components/**/*.html`**,
> not a fixed `preview.html`. This is a straight mirror of the manifest compiler's own
> discovery walk — the single filename authority.

**The mismatch.** The M4-02/03 viewer and the M4-04 HMR bridge were first written against a
hand-authored `components/<group>/<Name>/preview.html`, but the **server generates
`<Name>.html`** (e.g. `components/actions/Button/Button.html`). Against a real
server-generated kit the viewer listed zero cards and HMR never fired — every fixture and the
M4-10 e2e kit masked it by using `preview.html`.

**Why `<Name>.html` is the fixed point (not `preview.html`).** The filename is not a free
choice on the server side: the `conjure`/`refine` LLM call uses `response_format:
json_schema`, and that schema's `files[]` `contains` constraint is
`^components/[a-z0-9-]+/([A-Z][A-Za-z0-9]{1,63})/\1\.html$` (`server/src/llm/schema.ts`) —
i.e. the preview MUST be `<Name>/<Name>.html`. The model **cannot** emit `preview.html`. The
`<Name>/<Name>.html` self-consistency is also assumed throughout the RFC (§7.3/§7.4/§9.10),
`validate/*`, `sync/anchor.ts`, and the compiler's `deriveName`. So the server output is the
authority; the viewer must follow it.

**Decision — broaden the viewer/HMR side (issue Option 2), as a compiler-faithful superset.**
- `packages/viewer/src/config.ts` `PREVIEW_GLOB` → `components/**/*.html`.
- `packages/viewer/src/hmr-plugin.ts` `CARD_GLOB_RE` → `/(?:^|\/)components\/.+\.html$/`.
- Both now mirror the compiler's `walkPreviewFiles` (`components/**/*.html`, carded when a
  valid `@genie` marker is present). Matching the compiler's *path* discovery exactly is what
  makes divergence structurally impossible: three surfaces (manifest card `path` → grid iframe
  `data-path`; the Vite preview entry; the HMR `card.changed` path) are now byte-identical for
  a real card. This is a **backward-compatible superset** — it still matches the legacy
  `preview.html` fixtures — so nothing that worked before regresses.

**Why not the other options.**
- **Rename server output → `preview.html` (Option 1): infeasible.** It would require defeating
  the LLM `response_format` schema and rewriting `deriveName` + `validate.ts` `NAMED_HTML_PATH`
  + `sync/anchor.ts` + the RFC-wide `<Name>/<Name>.html` invariant. Largest blast radius, and
  it fights a contract the model is *forced* into rather than following it.
- **Symlink/emit a `preview.html` alongside `<Name>.html` (Option 3): rejected.** A duplicated
  per-card artifact breaks the "one artefact, three vehicles" byte-identity invariant (G-5) and
  adds a bookkeeping file the compiler would then have to reason about.

**Card identity stays owned by the manifest.** The client (`viewer.js`) is already fully
data-driven — it sets `iframe.src`/`data-path` and matches HMR `card.changed.path` entirely
from `.genie/manifest.json`'s `components[].path`, by plain `===`. The glob/regex only decide
which fs paths are *eligible*; a co-located, marker-less `.html` that over-matches is a harmless
no-op (unused Vite entry / an HMR path with no matching `data-path` → zero card reloads). No
client change was needed.

**Regression guard.** `packages/e2e/test/compiler-manifest-contract.test.ts` runs the **real**
`compileManifest` against a `<Name>.html` kit and asserts the manifest path, the Vite entry, and
the HMR classification all agree — so a hand-authored `preview.html` fixture can never hide this
class of divergence again (DRO-821 AC3).

---

## What did NOT change

- The **protocol shape**: read freely → one `plan` permission gate → writes scoped to the
  `planId`; out-of-plan paths rejected.
- The **atomic write sequence**: sentinel → writes ≤256/call → deletes → re-arm → anchor last.
- The **three preview vehicles**, byte-identical: `file://` / `localhost:5173` /
  `ui://genie/grid` (RFC G-5).
- The **clay-accent rule**: clay appears only on generation moments (Conjure, Refine,
  active slider, Apply); structure stays ink / ink-blue / neutral.
- The **anti-goals**: no hosted SaaS, no visual canvas (v1), no Figma rival, no token/color
  tool, no content database, no bundled LLM, no locked file formats.
- **Node ≥ 22**, ESM, MIT, TypeScript, `@modelcontextprotocol/sdk` only.
