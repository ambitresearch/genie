# Genie — Product Requirements Document (PRD)

## 1. Document control

| Field            | Value                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document         | genie — Product Requirements Document (PRD)                                                                                                                 |
| Version          | 0.9 (review draft)                                                                                                                                          |
| Status           | DRAFT — pending engineering sign-off                                                                                                                        |
| Created          | 2026-06-21                                                                                                                                                  |
| Last updated     | 2026-06-24                                                                                                                                                  |
| Owner            | Product (maintainer)                                                                                                                                        |
| Engineering lead | TBD                                                                                                                                                         |
| Design lead      | TBD                                                                                                                                                         |
| Source of truth  | `docs/plan/00-decisions.md`, `docs/research/`                                                                                                             |
| Related docs     | `docs/plan/00-decisions.md` (authority), `docs/plan/01-product-vision.md`, `docs/plan/02-brd.md`, `docs/plan/04-tech-design-rfc.md`, `github/milestones.md` |
| Repo             | `genie` (MIT)                                                                                                                                             |
| Tracker          | GitHub Projects v2 — milestones M0..M5                                                                                                                      |
| Reviewers        | The maintainer (wearing product / eng / design / devex / security / docs hats), AI review agents, plus anyone who opens a PR                                |
| Approvers        | The maintainer (self-sponsored)                                                                                                                             |

Change log:

| Version | Date       | Author         | Change                                                                                                                                                             |
| ------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1     | 2026-06-21 | Product (auto) | Initial scaffold derived from BRD + research report                                                                                                                |
| 1.0     | 2026-06-21 | Product (auto) | Full draft for engineering review                                                                                                                                  |
| 1.1     | 2026-06-24 | Product (auto) | Raised minimum Node.js from 18 to 22 (Node 18 & 20 reached EOL; Node 22 is the current Active LTS). Modern toolchain (pnpm 10.34, Vitest 4) requires Node ≥ 20+.   |
| 1.2     | 2026-06-24 | Product (auto) | Aligned to `00-decisions.md`: own conventions A–E (13 kit/component verbs, `@genie` marker, `.genie/` bookkeeping, `genie://` URI), projects-as-peer, generalized endpoints/git. |
| 1.3     | 2026-06-27 | Product (auto) | BRD-feedback sweep: UI-kit terminology (not "design system"), native conventions (blueprints not templates), M1 19-tool surface with projects-as-peer tooling. |

## 2. Product summary

**genie** is a harness-agnostic, open-source TypeScript MCP server
that any MCP-aware coding agent — Claude Code, Claude Desktop, OpenAI Codex CLI,
GitHub Copilot (VS Code agent mode), Cursor, Cline, and Continue.dev — can call
to generate, refine, validate, and visually preview React/Vue/HTML components
that conform to a versioned, git-backed UI kit.

It exists because Claude Design itself is a hosted-only product locked to
`claude.ai/design`, available only on Anthropic's Pro / Max / Team / Enterprise
subscriptions, with a canvas-side generation loop that is publicly undocumented
and a `DesignSync` MCP tool whose schema is private. Teams that already pay for
OpenAI-compatible model access, run their own self-hosted or VPC infrastructure, or
need to integrate a UI-kit feedback loop into non-Anthropic harnesses
(Codex CLI, Cursor, Cline, Continue) have no native way to consume Claude
Design today. This product fills that gap.

genie adapts three load-bearing mechanics from Claude Design's protocol _shape_,
expressed in genie's **own** native conventions — (1) a 19-tool M1 surface with
its strict `read → plan → write/delete` capability boundary, (2) the first-line
`<!-- @genie group="…" -->` HTML marker that registers preview cards in the
component grid, (3) the 5-step atomic write sequence ending with a
`.genie/sync.json` verification anchor — and adds a portable preview pane that
ships in three delivery vehicles from a single artifact set: `file://`
(universal), `http://localhost:5173` (Vite-backed live viewer with HMR,
universal), and `ui://genie/grid` (MCP-UI Apps payload for
Claude/VS Code/ChatGPT/Cursor inline rendering). (Round-trip interop with
Anthropic's verbatim `@dsCard` / `_ds_*` / `DesignSync` shapes is a post-v1
opt-in bridge, not genie's native surface — see `00-decisions.md` D0.)

genie operates on **two things**: a **kit** (the component library — Button,
Card, Input, tokens) and a **project** (the screens you build _with_ a kit,
including reusable blueprint projects). The kit loop and the project loop are the same
generate → preview → refine → commit motion, one step apart.

Generation is routed through a **configurable OpenAI-compatible
chat-completions endpoint** (LiteLLM is the reference; Ollama, OpenAI, vLLM, or
any compatible gateway also work via `GENIE_LLM_BASE_URL`) so model choice,
budgets, rate limits, and observability all reuse the gateway's existing
per-key controls rather than reinventing them. Distribution
is npm + `.mcpb` bundle (Claude Desktop double-click install) + Docker image +
Smithery listing, with per-harness configuration snippets in the README.

Primary users are designer-engineers maintaining a component library, product
designers with code literacy, platform/DX engineers administering AI tooling
for a team, and OSS plugin authors who want to integrate a UI-kit
feedback loop. v1 targets English-only, with framework hooks for later
localization.

## 3. Personas

Four personas drive the PRD. Each table includes anti-persona guidance so
scope discussions can quickly disqualify out-of-scope use cases.

### 3.1 Persona A — Designer-Engineer (primary)

| Field              | Value                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name (archetype)   | Priya — Senior Designer-Engineer                                                                                                                                                                                                                                                                  |
| Demographics       | 28–40, 6–12 years front-end experience, holds half-design / half-engineering reputation on the team. Title varies: "Design Engineer", "UI Engineer", "Staff Front-End"                                                                                                                            |
| Primary harness    | Claude Code (CLI) at workstation; opens Cursor or VS Code for IDE-grade refactors                                                                                                                                                                                                                 |
| OS / hardware      | macOS 14+ on Apple Silicon; some teammates on Windows 11 with WSL2; secondary Linux dev box                                                                                                                                                                                                       |
| Codebase shape     | Monorepo (pnpm/Turborepo) containing one or more React or Vue component packages, a tokens package, a Storybook or Ladle viewer, a Tailwind/CSS-Modules layer                                                                                                                                     |
| Goals              | (1) Maintain a single source of truth for components; (2) Generate variants and new components without manually writing boilerplate; (3) Prove visually that every component renders before merging; (4) Keep AI-generated code consistent with existing patterns; (5) Avoid lock-in to one model |
| Frustrations       | Claude Design is gated to a hosted UI they can't reach from Codex CLI or Cursor; copy-paste shuttling between chat and IDE; no visual preview in Codex CLI; LLM "hallucinates" components that ignore their tokens; no verifiable contract that AI output respects their library                  |
| Success indicators | Generation P50 < 4s end-to-end; viewer first-paint < 500ms for 100 components; zero `@genie` marker regressions across a 30-day window; ≥ 80% of new components committed are AI-generated and approved as-is                                                                                     |
| Anti-persona       | NOT for designers who don't open a terminal; NOT for back-end engineers who only consume the component package without building it                                                                                                                                                                |

### 3.2 Persona B — Product Designer with code literacy

| Field              | Value                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name (archetype)   | Marco — Senior Product Designer                                                                                                                                                                                                                                                                |
| Demographics       | 27–45, 5–15 years design experience, can read JSX and tweak CSS, comfortable with git on the command line for branch/commit/push; prefers UI-first tools                                                                                                                                       |
| Primary harness    | Claude Desktop (chat) for ideation; Cursor for live editing; VS Code Copilot Chat when paired with engineering                                                                                                                                                                                 |
| OS / hardware      | macOS 14+; iPad as second screen for the preview pane                                                                                                                                                                                                                                          |
| Codebase shape     | Reads (does not own) the UI-kit monorepo; owns Figma libraries; writes Markdown docs; occasionally lands token-only PRs                                                                                                                                                                        |
| Goals              | (1) Prototype interaction states visually without filing tickets; (2) Annotate components with intent ("this should be the empty state") and have an engineer-grade follow-up; (3) See every component variant in one grid; (4) Share a single URL with the rest of the design team for review |
| Frustrations       | Claude Design's hosted canvas locks them out of the team's actual codebase tokens; Figma never matches production CSS; no way to point a non-engineer at the live components; Storybook is engineer-y and slow                                                                                 |
| Success indicators | Time-to-first-prototype < 90s from idea to rendered card; viewer URL openable by any teammate without setup; designer-authored prompts produce code an engineer accepts without rewrite ≥ 60% of the time                                                                                      |
| Anti-persona       | NOT for designers who refuse to install a CLI or look at JSX; NOT for visual-only Figma workflows that never touch code                                                                                                                                                                        |

### 3.3 Persona C — Platform / DX Engineer

| Field              | Value                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name (archetype)   | Devika — Staff Platform Engineer                                                                                                                                                                                                                                                                                                  |
| Demographics       | 30–50, 10+ years infra/devex experience; owns the team's AI tooling, model gateway, secrets, and per-team budgets; reports to a CTO or VP Eng                                                                                                                                                                                     |
| Primary harness    | All seven — needs to validate that the server runs on every harness their team uses; runs CI smoke tests against the matrix                                                                                                                                                                                                       |
| OS / hardware      | Linux (Debian/Ubuntu) servers + macOS workstation; manages a self-hosted or VPC stack running a git host, LLM gateway, and existing OIDC provider (e.g. Gitea + LiteLLM + IdP)                                                                                                                                                                                                   |
| Codebase shape     | Owns no component code directly; owns deployment manifests, Docker compose, Kubernetes Helm charts, Terraform; integrates secrets and OAuth client registration                                                                                                                                                                   |
| Goals              | (1) Single deploy that serves N teams; (2) Predictable budget per-team via LLM endpoint keys or gateway teams; (3) OAuth + audit log against IdP, no per-seat fees; (4) Prometheus metrics that fit the operator's dashboard stack; (5) Roll back gracefully when a model alias changes; (6) Pass security review (OWASP, CSP, sandbox) |
| Frustrations       | Most MCP servers ship with bring-your-own-key burned into source; no per-team budgets; nothing emits Prom metrics; tool authors hard-code Anthropic API endpoints; OAuth DCR support is rare; .mcpb bundles are poorly tested on Windows                                                                                          |
| Success indicators | Zero-downtime upgrade across two minor versions; per-team budget enforced before tokens hit Anthropic; OAuth flow completes in <30s; Prom scrape returns ≥ 12 metric series; 7/7 harnesses pass smoke test in CI                                                                                                                  |
| Anti-persona       | NOT for shops with no AI infrastructure today; NOT for hobbyist single-user setups (they will use the npm package directly)                                                                                                                                                                                                       |

### 3.4 Persona D — OSS Plugin Author

| Field              | Value                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name (archetype)   | Ren — Indie OSS Maintainer                                                                                                                                                                             |
| Demographics       | 22–45, 3–20 years experience, ships open-source MCP servers, Claude Code plugins, VS Code extensions; not paid by any one company                                                                      |
| Primary harness    | Claude Code (primary), Claude Desktop (secondary), Codex CLI (occasional)                                                                                                                              |
| OS / hardware      | Mix: macOS, Linux, Windows; tests on all three                                                                                                                                                         |
| Codebase shape     | Their own component library or design language they want to ship as a public preset; contributes adapters (Storybook, Ladle, Histoire); maintains an `llms-install.md`                                 |
| Goals              | (1) Treat genie as a substrate to embed in their own plugin; (2) Have stable public APIs for `list_components`, `conjure`, `validate`; (3) Predictable semver; (4) MIT license so they can fork freely |
| Frustrations       | Plugins frequently break on upstream renames; undocumented schema changes; ESM/CJS shenanigans; lack of `*.d.ts` typings; no contribution guide                                                        |
| Success indicators | Successful third-party plugin published against v0.5; no breaking schema change in any minor release between v1.0 and v1.5; published types pass `tsc --strict`                                        |
| Anti-persona       | NOT for closed-source vendor integrations; NOT for one-off internal forks that diverge from main                                                                                                       |

## 4. Jobs-to-be-done (JTBD)

Eighteen jobs, each tagged by persona (A, B, C, D) and prioritized M (must,
v1), S (should, v1 or v1.x), C (could, v1.x+).

| JTBD ID | Statement                                                                                                                                                                                   | Persona | Priority |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| JTBD-01 | When I'm starting a new component, I want to describe it in one sentence, so I can skip the boilerplate and review a working preview in under five seconds.                                 | A, B    | M        |
| JTBD-02 | When the UI kit already has a Button, I want to refine just the hover state, so I can iterate without losing the rest of the component.                                                     | A, B    | M        |
| JTBD-03 | When I'm not at my own machine, I want to use any MCP-aware client (Claude Code, Codex CLI, Cursor) and still get identical output, so my workflow is portable.                             | A, D    | M        |
| JTBD-04 | When I commit a component, I want validation to fail noisily if the `@genie` marker is missing, so the preview pane never silently loses a card.                                            | A, D    | M        |
| JTBD-05 | When I'm reviewing the kit, I want a single URL that renders every component in a grid with HMR, so I can shake the tree without context-switching to chat.                                 | A, B    | M        |
| JTBD-06 | When I'm in a chat that supports MCP Apps (Claude / VS Code / ChatGPT / Cursor), I want the preview to render inline, so I don't have to alt-tab.                                           | A, B    | S        |
| JTBD-07 | When my team has a git repo for the kit, I want each plan to land as a branch and each finalize as a PR, so I get free diff/review/rollback.                                                | A, C    | S        |
| JTBD-08 | When a colleague tries to write outside the plan's allowed paths, I want the server to reject the write, so the kit never desyncs.                                                          | A, C    | M        |
| JTBD-09 | When the LLM endpoint is down or rate-limited, I want a friendly error and a retry-after hint, so I don't burn my own time guessing.                                                        | A, D    | M        |
| JTBD-10 | When I want to swap models from Sonnet to Opus, I want a single config change, so I don't rewrite prompts.                                                                                  | A, C    | M        |
| JTBD-11 | When my team has 4 separate kits, I want each kit to have its own viewer port and its own LLM endpoint key or gateway team, so per-team budgets are enforced before tokens leave the proxy. | C       | M        |
| JTBD-12 | When I install the server in Claude Desktop, I want a double-click .mcpb install with no terminal, so non-engineers can onboard.                                                            | C, B    | M        |
| JTBD-13 | When I'm auditing the kit, I want one tool call to list every "thin" or duplicate component, so I can clean up tech debt without a manual walk.                                             | A, C    | S        |
| JTBD-14 | When I integrate the server into my own plugin, I want stable typings and semver-respecting tool names, so a minor bump doesn't break my plugin.                                            | D       | M        |
| JTBD-15 | When my org uses an OIDC provider, I want OAuth Dynamic Client Registration for HTTP deployments, so individual users don't share a bearer.                                                  | C       | S        |
| JTBD-16 | When I'm exploring a kit a teammate built, I want to browse `genie://components/...` resources without writing any tool call, so I can ramp quickly.                                        | A, D    | S        |
| JTBD-17 | When I generate a component, I want every artifact (`.tsx`, `.d.ts`, `.html`, `prompt.md`, `meta.json`) written atomically, so a mid-write crash never half-lands.                          | A, C    | M        |
| JTBD-18 | When I prompt genie with a region rect on a card, I want only that region to refine, so I keep the rest of the component frozen.                                                            | A, B    | S        |

## 5. User stories with acceptance criteria

Stories use the ID prefix `DS-NNN`. Acceptance criteria use Given/When/Then.
Estimates: S = ≤1 day, M = 1–3 days, L = 3–7 days, XL = >7 days. Priority:
P0 (v1 blocker) · P1 (v1 stretch) · P2 (post-v1).

Epics map to milestones M0–M5 from the research report §7.

### Epic E0 — Discovery & scaffold (M0)

#### DS-001 — Initialize TypeScript MCP server scaffold

- **Persona:** D
- **Narrative:** As an OSS Plugin Author, I want a clean `npm init` + `@modelcontextprotocol/sdk` scaffold with ESM, Node ≥ 22, and strict TS, so the project is forkable on day one.
- **Acceptance criteria:**
  - Given a clean checkout, When I run `npm ci && npm run build`, Then `dist/server.js` is emitted with no `any` warnings under `tsc --strict`.
  - Given a clean checkout, When I run `npm test`, Then the unit-test runner executes a smoke test confirming the server registers ≥ 1 tool.
  - Given `package.json`, Then `engines.node >= 22`, `type: module`, and the `bin` entry `genie` resolves.
  - Given the repo, Then `LICENSE` is MIT and `README.md` opens with the one-liner from the BRD.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M0

#### DS-002 — Dual transport (stdio + Streamable HTTP)

- **Persona:** C, D
- **Narrative:** As a Platform Engineer, I want the server to speak both stdio (for local) and Streamable HTTP (for remote), so a single binary serves Claude Desktop and a remotely-hosted deployment.
- **Acceptance criteria:**
  - Given `--transport stdio`, When the process starts, Then stdin/stdout JSON-RPC framing initializes and `initialize` returns the documented capabilities.
  - Given `--transport http --port 8780`, When a client POSTs `tools/list`, Then a 200 response with the catalog returns within 200 ms cold.
  - Given a Claude Code `.mcp.json` with `type: "streamable-http"`, Then the alias resolves to the http transport.
  - Given the HTTP transport, Then OPTIONS preflight succeeds with permissive CORS.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M0

#### DS-003 — CLI surface (`genie`)

- **Persona:** A, C
- **Narrative:** As a Designer-Engineer, I want a single CLI command with `--transport`, `--port`, `--config`, `--data-dir`, `--git-remote`, `--llm-base-url` flags, so I never have to read source to launch it.
- **Acceptance criteria:**
  - Given `genie --help`, Then every flag is listed with default and env-var equivalent.
  - Given `--data-dir ./my-kits`, Then file operations resolve to that directory and never escape via `..`.
  - Given `--git-remote https://git.example.tld/api` (any git host — GitHub / Gitea / GitLab), Then that backend is preferred for shared state; absent means local FS only.
  - Given `--version`, Then semver matches `package.json`.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M0

### Epic E1 — Kit + project foundation (M1)

#### DS-010 — list_kits

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want to enumerate every kit I can edit, so I can pick one without leaving the chat.
- **Acceptance criteria:**
  - Given the local FS data dir contains 3 kit directories, When `list_kits` is called, Then exactly 3 entries return with `id`, `name`, `owner`, `updatedAt`, `canEdit`.
  - Given a git-host backend with 2 repos visible to the auth token, Then both repos appear, deduped against local FS entries by `id`.
  - Given no kits exist, Then `[]` returns (not an error).
  - Given an unreachable git host, Then local FS entries still return with a warning in `_meta.warnings`.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-011 — get_kit

- **Persona:** A
- **Narrative:** As a Designer-Engineer, I want to confirm a `kitId` exists and is editable before I plan, so I never waste a `plan` round-trip.
- **Acceptance criteria:**
  - Given a valid `kitId`, Then `{ id, name, type: "GENIE_KIT", canEdit }` returns.
  - Given an invalid `kitId`, Then `ERR_KIT_NOT_FOUND` raises with the kitId echoed.
  - Given a read-only kit, Then `canEdit: false` returns and downstream `plan` is rejected pre-emptively.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-012 — list_files

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want a path-sorted file listing with sizes and hashes, so I can diff against my local working tree.
- **Acceptance criteria:**
  - Given a kit with 250 files, Then all return in a single response (no pagination needed at this scale).
  - Given each entry, Then `path` is kit-root-relative POSIX style, `size` is bytes, `hash` is `sha256-…`, `lastModified` is ISO-8601 UTC.
  - Given a kit with files outside `ui_kits/<kit>/`, Then those are filtered out.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-013 — read_file (256 KiB cap)

- **Persona:** A
- **Narrative:** As a Designer-Engineer, I want to fetch the literal content of a single file under 256 KiB, so I can render or diff it.
- **Acceptance criteria:**
  - Given a 100 KiB file, Then `{ content: string }` returns with raw text (utf-8 assumed).
  - Given a 300 KiB file, Then `ERR_FILE_TOO_LARGE` raises with `maxBytes: 262144`.
  - Given a binary file (PNG, woff2), Then `content` is base64-encoded and `_meta.encoding = "base64"`.
  - Given a path that escapes the kit dir (`../../etc/passwd`), Then `ERR_PATH_OUTSIDE_KIT` raises.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-014 — create_kit

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want to spin up a new kit with a fresh `ui_kits/<kit>/` skeleton, so I don't hand-author the directory tree.
- **Acceptance criteria:**
  - Given `create_kit({ name: "Acme Kit" })`, Then a `kitId` returns and disk shows `ui_kits/acme-kit/{.genie/manifest.json, styles.css, README.md, components/, tokens/, _vendor/}`.
  - Given a git-host backend, Then a corresponding repo is created with the same skeleton committed to `main`.
  - Given a kit nested inside an existing git repo working tree, Then `create_kit` refuses (hard invariant: never a repo inside a repo — D-G); use a subtree scope or a standalone repo instead.
  - Given a duplicate name, Then `ERR_KIT_EXISTS` raises with a suggestion to pass `--force` or pick another name.
  - Given the new kit, Then a default `.genie/manifest.json` with `schemaVersion: 1` and `cards: []` is written.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M1

#### DS-015 — plan with strict allow-list

- **Persona:** A, C
- **Narrative:** As a Designer-Engineer, I want a single permission grant pinning `writes`, `deletes`, and `localDir`, so subsequent writes are bounded.
- **Acceptance criteria:**
  - Given `plan({ kitId, writes: ["components/**", ".genie/sync.json"], deletes: [], localDir: "/tmp/ws" })`, Then a `planId` returns (uuid v7) with TTL = 15 minutes default (configurable up to 24 hours via `GENIE_PLAN_TTL_MIN` env var).
  - Given `writes` containing 257 patterns, Then `ERR_PLAN_TOO_MANY_PATTERNS` raises.
  - Given a single pattern with 4 wildcards (`**/*/*/*`), Then `ERR_PATTERN_TOO_WILD` raises with max=3.
  - Given the planId, When `write_files` is called with a path matching `writes`, Then the write proceeds; for a path outside, `ERR_PATH_NOT_IN_PLAN` raises.
  - Given a planId older than its TTL, Then `ERR_PLAN_EXPIRED` raises.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M1

#### DS-016 — write_files (≤256 files, payload bytes cap, localPath)

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want to write up to 256 files per call from `localPath`, so contents never enter model context and large kits chunk safely.
- **Acceptance criteria:**
  - Given 256 files each ≤ 1 KiB, Then all written and `writtenPaths` returns the list in input order.
  - Given 257 files, Then `ERR_TOO_MANY_FILES_PER_CALL` raises with `maxFiles: 256`.
  - Given a payload exceeding the byte cap (default 16 MiB; hard ceiling 64 MiB configurable via `GENIE_WRITE_BYTE_CAP` env var), Then `ERR_PAYLOAD_TOO_LARGE` raises with HTTP 500 wire-shape mapped to error code so client can halve+retry.
  - Given a file with `localPath`, Then the server reads from disk; with `data` (base64), Then the server writes the decoded buffer.
  - Given a file without a valid plan, Then `ERR_NO_PLAN` raises.
  - Given a `.html` write whose first line fails `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`, Then `ERR_MARKER_MISSING` raises with the failing path and the regex pattern echoed.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M1

#### DS-017 — delete_files

- **Persona:** A
- **Narrative:** As a Designer-Engineer, I want to delete files only if they are in the plan's `deletes`, so a stale delete never wipes a teammate's recently-committed component.
- **Acceptance criteria:**
  - Given paths all in `deletes`, Then they are removed and `deletedPaths` echoes them.
  - Given a path not in `deletes`, Then `ERR_PATH_NOT_IN_PLAN` raises.
  - Given a path that doesn't exist remotely, Then it is silently treated as success (idempotent per the DesignSync convention).
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-019 — validate (counter persistence facet)

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want `validate` to persist its run counters, so the server can advertise validation state on the next read without re-running.
- **Acceptance criteria:**
  - Given a `validate({ kitId })` run, Then the counts `{ total, bad, thin, variantsIdentical, iterations }` are persisted to `.genie/validation.json` and surfaced on the next `get_kit`.
  - Counts schema is open-ended for additive future fields; missing fields default to 0.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M1
- **Note:**
  - This is the persistence half of the single merged `validate` verb (D-A); the full-scan report half is specified in DS-042.
  - The `register_assets`/`unregister_assets` legacy verbs are **dropped** — the `@genie` marker IS the registration (D-B); to remove a card, delete the file.

#### DS-020 — Atomic 5-step write sequence

- **Persona:** A, C
- **Narrative:** As a Designer-Engineer, I want the server to enforce the 5-step sequence (sentinel → writes ≤256 → deletes → re-arm sentinel → `.genie/sync.json` last), so a partial failure leaves the kit recoverable.
- **Acceptance criteria:**
  - Given any plan's first write call, Then the sentinel file `.genie/recompile` is written before user content.
  - Given a `write_files` mid-sequence failure, Then `.genie/sync.json` is NOT written.
  - Given the final write, Then `.genie/sync.json` is the last byte to land on disk and contains a `writtenAt` ISO timestamp + the hashes documented in §6.6.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M1

#### DS-021 — list_projects

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to enumerate the screen/app workspaces and blueprint projects visible to genie, so I can choose the right consumer target before generating UI.
- **Acceptance criteria:**
  - Given local projects exist, Then `list_projects` returns `id`, `name`, `kind`, `defaultKitId`, `kitBindings`, `updatedAt`, and `canEdit`.
  - Given a mix of `workspace` and `blueprint` projects, Then both are returned and can be filtered client-side by `kind`.
  - Given no projects exist, Then `[]` returns, not an error.
  - Given an unreachable git-host backend, Then local projects still return with a warning in `_meta.warnings`.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-022 — get_project

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to inspect a project manifest before binding kits or conjuring a screen, so tool calls target the right workspace.
- **Acceptance criteria:**
  - Given a valid `projectId`, Then `{ id, name, kind, defaultKitId, kitBindings, screens, canEdit }` returns.
  - Given a project with `kind: "blueprint"`, Then the response clearly identifies it as a reusable project template.
  - Given an invalid `projectId`, Then `ERR_PROJECT_NOT_FOUND` raises with the projectId echoed.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-023 — create_project

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to create a blank workspace, create a reusable blueprint, or instantiate a workspace from a blueprint, so projects become first-class targets instead of implicit folders.
- **Acceptance criteria:**
  - Given `create_project({ name, kind: "workspace" })`, Then a project root with `.genie/project.json` is created.
  - Given `create_project({ name, kind: "blueprint" })`, Then the manifest records `kind: "blueprint"`.
  - Given `create_project({ name, kind: "workspace", fromBlueprintId })`, Then starter files and kit bindings copy into the new workspace and `sourceBlueprintId` is recorded.
  - Given later edits to the source blueprint, Then existing derived workspaces do not mutate silently.
  - Given duplicate names in the same scope, Then `ERR_PROJECT_EXISTS` raises with a suggested slug.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M1

#### DS-024 — delete_project

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want to remove a project target explicitly, so old workspaces and blueprints do not clutter discovery.
- **Acceptance criteria:**
  - Given a valid editable `projectId`, Then the project is removed and the deleted id is echoed.
  - Given a missing project, Then the call is idempotent and reports the missing id in `_meta.warnings`.
  - Given a read-only project, Then `ERR_PROJECT_READONLY` raises.
  - Given a project with derived workspaces, Then deleting the blueprint does not delete derived workspaces.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M1

#### DS-025 — bind_kit

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to bind one or more UI kits to a project and name the default, so screen generation uses my library rather than generic components.
- **Acceptance criteria:**
  - Given `bind_kit({ projectId, kitId, default: true })`, Then `.genie/project.json` records the binding and sets `defaultKitId`.
  - Given a second binding with `default: true`, Then it becomes the only default.
  - Given an invalid `kitId` or `projectId`, Then the error names the missing target directly.
  - Given a blueprint project, Then bindings are allowed and copied when the blueprint is instantiated.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M1

#### DS-026 — conjure_screen

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to generate a screen inside a project, constrained by the project's bound UI kit, so full-page work uses the same adherence model as component generation.
- **Acceptance criteria:**
  - Given `conjure_screen({ projectId, prompt })`, Then genie resolves the kit by explicit request, project default, then sole reachable binding.
  - Given no bound kit and a prompt that asks for kit-specific components, Then genie stops with `ERR_PROJECT_KIT_REQUIRED` instead of inventing a kit.
  - Given no bound kit and a prompt for basic structure, Then genie may generate framework-neutral screen structure without pretending it used a kit.
  - Given a blueprint id, Then the screen may be seeded from that reusable project template before writing the workspace artifact.
  - Given success, Then the generated screen artifact is recorded in `.genie/project.json` and returned with usage metadata.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M1

### Epic E2 — Generation surface (M2)

#### DS-030 — conjure (prompt-driven, the first clay moment)

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to describe a component in natural language and have the server generate a full, kit-conformant artifact set, so I can skip boilerplate **and** get code that's provably mine — not generic AI output.
- **The machine (D-I):** `conjure` is grounding-in, validation-out.
  - (1) **Assemble the grounding** — the bound kit's tokens, the `.d.ts` contracts of existing primitives, the adherence rules, one or two existing components as few-shot.
  - (2) **Build the system prompt** — grounding + the 5-file artifact contract + the `@genie` marker requirement + framework.
  - (3) **Constrained generation** — the one model call to the configured endpoint with `response_format: json_schema` (forces 5 well-formed files), streamed for progress.
  - (4) **The validation gauntlet** — `@genie` marker on line 1? imports from `tokens/` with **no hardcoded `#hex`**? passes the adherence lint? actually **renders** (Playwright headless — non-trivial body, not blank/thin)? Any failure → **one self-repair retry**, feeding the validator's error back to the model.
  - (5) **Extract the contract** — ts-morph reads the `.tsx` → emits the `.d.ts`, the grounding the _next_ conjure reads.
  - (6) **Seal** — `plan` → `write_files` → anchor; lands as a real, validated git commit.
  - The honest line: genie mechanically verifies _"it's your code"_ (imports tokens, no raw hex, passes adherence, renders) — it cannot verify _"it's beautiful."_ Taste scales with whatever model you point it at; genie is the harness, not the brain.
- **Acceptance criteria:**
  - Given `conjure({ kitId, kit, prompt: "primary button, accent color, 3 sizes" })`, Then within P50 < 4s the server returns `{ componentName, files: [...], manifestEntry }`.
  - Given the returned files, Then exactly five are produced: `<Name>.tsx`, `<Name>.d.ts`, `<Name>.html`, `<Name>.prompt.md`, `meta.json`.
  - Given the returned `<Name>.html`, Then its first line matches the `@genie` regex with `group` derived from prompt context or default `"misc"`.
  - Given the generated `.tsx`, Then it imports from `tokens/` and contains no hardcoded `#hex`; a violation triggers exactly one self-repair retry before `ERR_GENERATION_INVALID`.
  - Given a successful generation, Then the `.d.ts` is extracted via ts-morph and becomes grounding for the next conjure.
  - Given an optional `refImageDataUrl`, Then the image is included in the vision payload (vision-capable models).
  - Given `framework: "vue"`, Then files use `.vue` instead of `.tsx` and the IIFE bundle target is adjusted.
  - Given an invalid `model` alias not routed by the endpoint, Then `ERR_MODEL_NOT_ROUTED` raises with the gateway's error message echoed.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M2

#### DS-031 — refine (instruction + optional region rect, the second clay moment)

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want to mutate one thing about an existing component and provably freeze the rest, optionally constrained to a region rect on the rendered card, so I can iterate without collateral damage.
- **The machine (D-I):** `refine` has three modes of increasing risk.
  - (1) **Diff, not rewrite (solid):** current files + instruction → the model returns a **unified diff**, applied with `patch`, re-validated through the same gauntlet as `conjure`. Asking for a diff is what makes "the rest is untouched" _provable_ — the model can't restate what it didn't change.
  - (2) **Sliders = re-parameterization (solid):** at generation, genie detects the component's axes (size, radius, shadow, accent) and surfaces knobs mapped to token values. Dragging a slider makes **no model call** — instant and free; only a _structural_ change hits the LLM.
  - (3) **Region-scoped refine (R&D edge):** a comment-pin gives a rect; genie annotates the prompt ("limit changes to this region") and scopes the diff where it can. Mapping a _pixel rect → source lines_ is the hard part — **in v1 it is a hint, not a hard constraint.**
- **Acceptance criteria:**
  - Given `refine({ kitId, componentName, instruction: "make hover state lift on shadow" })`, Then a unified diff and updated files return, applied via `patch -p0` with the full validation gauntlet re-run.
  - Given a slider adjustment mapped to a token axis (size/radius/shadow/accent), Then the change is applied by re-parameterization with **no model call**.
  - Given `region: { x, y, w, h }`, Then the prompt is annotated with the region as a **hint** ("limit changes to this area") and the diff is region-scoped where possible; v1 does not guarantee a hard pixel→source boundary.
  - Given the diff, Then it applies cleanly via `patch -p0` and validation passes.
  - Given a non-existent componentName, Then `ERR_COMPONENT_NOT_FOUND` raises.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M2

#### DS-032 — list_components

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want to enumerate components, optionally filtered by group, so I can browse without opening every file.
- **Acceptance criteria:**
  - Given `list_components({ kitId })`, Then every component returns with `{ name, group, path, viewport, hash, lastModified }`.
  - Given `group: "actions"`, Then only that group returns.
  - Sort order is `group, name` ascending.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M2

#### DS-033 — Generation client wired to a configurable endpoint

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want the server to call a configurable OpenAI-compatible chat-completions endpoint (LiteLLM / Ollama / OpenAI / vLLM), so model routing, budgets, and rate-limits all reuse my chosen gateway.
- **Acceptance criteria:**
  - Given `GENIE_LLM_BASE_URL=https://your-llm-gateway.example/v1` and `GENIE_LLM_API_KEY=…`, Then `conjure` issues a POST to `/chat/completions` with `model: alias`, `response_format: { type: "json_schema" }` and `stream: true`.
  - Given a 429 response, Then the server respects `Retry-After` and surfaces `ERR_RATE_LIMITED` with the seconds remaining.
  - Given a 5xx, Then up to 3 retries with exponential backoff (1s, 2s, 4s) execute before `ERR_UPSTREAM_5XX` raises.
  - Given a 401, Then `ERR_LLM_AUTH` raises immediately (no retry).
  - Given streaming, Then `_meta.stream = true` and chunks are surfaced via MCP `notifications/progress` for harnesses that support it; otherwise concatenated.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M2

#### DS-034 — Structured output JSON schema for COMPONENT_SCHEMA

- **Persona:** D
- **Narrative:** As an OSS Plugin Author, I want the model output to be schema-validated, so generation always returns well-formed artifacts.
- **Acceptance criteria:**
  - Given a successful generation, Then output conforms to `COMPONENT_SCHEMA` (defined in §6.5).
  - Given a schema violation, Then the server attempts one self-repair retry, then raises `ERR_GENERATION_INVALID` with the validator's error path.
  - Given the schema, Then it is JSON Schema Draft 7 — no `$ref` chains, no `anyOf` discriminators.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M2

### Epic E3 — `@genie` validator + manifest compiler (M3)

#### DS-040 — @genie regex validator

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want every `.html` first-line to match the exact `@genie` marker regex, so previews never silently lose registration.
- **Acceptance criteria:**
  - Given a file whose first line is `<!-- @genie group="actions" -->`, Then validator passes.
  - Given a file whose first line is `<!-- @genie group="actions" viewport="480x240" -->`, Then validator passes.
  - Given any first line failing `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`, Then `ERR_MARKER_MISSING` raises with path + line content.
  - Given the validator integrated into `write_files`, Then a violation aborts the entire `write_files` call before any file lands.
- **Priority:** P0 · **Estimate:** S · **Milestone:** M3

#### DS-041 — Manifest compiler

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want `.genie/manifest.json` to be recompiled on every `write_files` that touches a `.html`, so the viewer always renders the latest state.
- **Acceptance criteria:**
  - Given a `write_files` call that touches `.html`, Then `.genie/manifest.json` is regenerated by scanning `components/**/*.html`, extracting first-line attrs, and writing the result.
  - Given the regenerated manifest, Then each card has `id`, `name`, `subtitle?`, `group`, `path`, `viewport`, `tags?`, `hash`, `lastModified` populated.
  - Given a component without an explicit `viewport`, Then a sensible default `{ width: 480, height: 240 }` is used.
  - Given two components with the same name in different groups, Then `ERR_DUPLICATE_COMPONENT_NAME` raises.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M3

#### DS-042 — validate (full-scan report facet)

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer, I want a single tool call that reports every violation, so I don't run validators one-by-one.
- **Acceptance criteria:**
  - Given `validate({ kitId })`, Then `{ markerMissing, thin, variantsIdentical, total, bad }` returns.
  - Given a "thin" component (preview HTML body shorter than 200 bytes excluding whitespace), Then its path appears in `thin[]`.
  - Given two `.html` files with identical image hashes (Playwright-rendered), Then both appear in `variantsIdentical[]`.
  - Given a clean kit, Then `bad: 0` and arrays are empty.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M3
- **Note:**
  - `validate` is the single verb merged from the inherited `report_validate` + `validate_design_system` (D-A).
  - The counter-persistence facet is DS-019.

#### DS-043 — `.genie/sync.json` verification anchor

- **Persona:** A, C
- **Narrative:** As a Designer-Engineer, I want a tail file pinning hashes of every source + render, so I can detect drift across syncs.
- **Acceptance criteria:**
  - Given a successful atomic write sequence, Then `.genie/sync.json` is the last file written.
  - Given its schema, Then `{ version, writtenAt, by, sourceHashes, renderHashes, verified }` is populated per §6.6 (with `by: "genie"`).
  - Given a teammate's machine has a different `.genie/sync.json`, Then `remote-diff` produces a delta showing only files whose hash changed.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M3

### Epic E4 — Preview viewer (Vite + ui://) (M4)

#### DS-050 — `npx genie-viewer <kit-dir>` dev mode

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want a single command to spin up the viewer with HMR, so I can save → see refresh.
- **Acceptance criteria:**
  - Given `npx genie-viewer ui_kits/acme`, Then Vite starts and prints `Local: http://localhost:5173`.
  - Given a `preview.html` save, Then the corresponding iframe reloads within 100 ms via `postMessage`.
  - Given a `.genie/manifest.json` change, Then the grid re-flows without a full reload.
  - Given the port is busy, Then the viewer picks the next free port and prints it.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M4

#### DS-051 — Iframe grid renderer

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want each card rendered in a sandboxed iframe at its declared viewport, so cards are isolated from each other.
- **Acceptance criteria:**
  - Given the viewer index, Then each card is wrapped in `<iframe sandbox="allow-scripts" loading="lazy" src="components/.../preview.html">`.
  - Given a card without a viewport in meta, Then default 480×240.
  - Given the viewer URL opened in Safari/Chrome/Firefox/Edge, Then the layout renders identically.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M4

#### DS-052 — `file://` fallback (offline / no-Vite)

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want the viewer to work when I double-click `index.html` from Finder, so a designer can preview a kit without running anything.
- **Acceptance criteria:**
  - Given `file:///.../ui_kits/acme/index.html`, Then the viewer fetches `.genie/manifest.json` and renders the grid.
  - Given `file://`, Then the viewer functions even with no relative-fetch hacks (relies on a classic `<script>` — NOT `type="module"`, whose relative-`src` fetch is CORS-blocked under `file://`'s opaque per-document origin, verified empirically in DRO-749 — plus the inlined manifest fallback for the still-open `fetch()`-under-`file://` gap, M4-05/DS-053).
- **Priority:** P0 · **Estimate:** M · **Milestone:** M4

#### DS-053 — `preview` MCP tool with `ui://` MCP App payload

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer using a host that renders MCP Apps (Claude, VS Code, ChatGPT, Cursor), I want preview, generate, refine, and audit inline in chat, so I don't alt-tab.
- **Acceptance criteria:**
  - Given `preview({ kitId })`, Then the tool result includes both `content[].text` with the viewer URL AND `_meta.ui.resourceUri: "ui://genie/grid?kitId=…"`.
  - Given the `ui://` resource is fetched by the host, Then a single self-contained HTML payload returns with MIME `text/html;profile=mcp-app`.
  - Given that HTML, Then it inlines `.genie/manifest.json` as `<script type="application/json" id="manifest">…</script>`, so the iframe needs no fetch.
  - Given a user clicks Generate, Refine, or Audit inside the MCP App, Then it emits a `ui/message` payload the host maps to `conjure`, `refine`, or `validate`.
  - Given a host that does not render MCP Apps, Then it falls back to the text URL and never errors.
- **Priority:** P0 · **Estimate:** L · **Milestone:** M4

#### DS-054 — Chokidar watch + postMessage refresh

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want only the changed card to refresh, so I don't lose scroll position.
- **Acceptance criteria:**
  - Given a chokidar watcher on `components/**/preview.html`, When a file is saved, Then the parent emits `{type:'refresh', id}` via the dev server's WebSocket.
  - Given the iframe receives the postMessage, Then it reloads itself via `location.reload()`.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M4

### Epic E5 — Auth + distribution + smoke tests (M5)

#### DS-060 — Static bearer auth (per-harness header)

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want a simple `Authorization: Bearer <token>` path for VS Code, Cline, Continue, so I don't need OAuth for low-trust shops.
- **Acceptance criteria:**
  - Given `GENIE_TOKEN=secret`, Then a POST without the header returns 401; with the header returns 200.
  - Given a token rotation, Then the server picks up the new token within 60 s without restart (env-watcher) OR documents that a restart is required (decision: restart-required is acceptable for v1).
- **Priority:** P0 · **Estimate:** S · **Milestone:** M5

#### DS-061 — OAuth 2.0 + Dynamic Client Registration for HTTP

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want OAuth DCR (RFC 7591) for shared Streamable HTTP deployments, so each user gets their own client_id and audit log.
- **Acceptance criteria:**
  - Given a Claude Code HTTP `claude mcp add` flow pointed at an already-running genie URL, Then DCR is invoked and a per-user client_id is registered.
  - Given a Codex CLI `codex mcp login genie`, Then the OAuth flow completes within 30 s and a token is stored in `~/.codex/credentials`.
  - Given OAuth, Then the IdP is configurable via `OIDC_DISCOVERY_URL`.
  - Given a revoked token, Then subsequent calls return 401 and the client re-prompts.
- **Priority:** P1 · **Estimate:** L · **Milestone:** M5

#### DS-062 — `.mcpb` bundle for Claude Desktop

- **Persona:** B, C
- **Narrative:** As a Product Designer, I want a double-click install on Claude Desktop, so I never open Terminal.
- **Acceptance criteria:**
  - Given `npx @modelcontextprotocol/mcpb pack`, Then a `.mcpb` is produced.
  - Given the bundle, When double-clicked on macOS and Windows, Then Claude Desktop installs the server and prompts to enable it.
  - Given the bundle, Then it includes `manifest.json`, `server.js`, and a minimal vendored `node_modules` such that no `npm install` is needed.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M5

#### DS-063 — Docker image (linux/amd64, linux/arm64)

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want a multi-arch container image, so I can deploy it to my self-hosted server or k8s cluster.
- **Acceptance criteria:**
  - Given `docker pull ghcr.io/roshangautam/genie:1.0`, Then both amd64 and arm64 variants resolve.
  - Given `docker run -p 8780:8780 -e GENIE_LLM_BASE_URL=… ghcr.io/…`, Then the server starts in <2 s and `GET /healthz` returns 200.
  - Given the image, Then it runs as non-root UID 1000.
- **Priority:** P0 · **Estimate:** M · **Milestone:** M5

#### DS-064 — Smithery listing

- **Persona:** D
- **Narrative:** As an OSS Plugin Author, I want the server discoverable via Smithery, so users can one-click install.
- **Acceptance criteria:**
  - Given a `smithery.yaml` at repo root, Then the Smithery registry indexes the server.
  - Given a Smithery install, Then the snippet emitted is correct for at least Claude Code, Cursor, Cline, Continue, Codex CLI.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M5

#### DS-065 — Per-harness smoke tests in CI

- **Persona:** C, D
- **Narrative:** As a Platform Engineer, I want CI to connect each of 7 harnesses to the server and run `conjure → write_files → preview → validate`, so regressions are caught pre-release.
- **Acceptance criteria:**
  - Given a GitHub Actions matrix `{harness: [claude-code, claude-desktop, codex-cli, vscode-copilot, cursor, cline, continue]}`, Then each cell runs the smoke flow against the built binary.
  - Given any cell failing, Then the release is blocked.
  - Given the matrix passes, Then a status badge updates in README.
- **Priority:** P1 · **Estimate:** XL · **Milestone:** M5

#### DS-066 — Git-host backend (per-team kits)

- **Persona:** A, C
- **Narrative:** As a Designer-Engineer working with a team, I want each kit to be a git repo on any git host (GitHub / Gitea / GitLab), so I get diff/PR/rollback for free.
- **Acceptance criteria:**
  - Given `--git-remote https://git.example.tld/api` and a host token, Then `list_kits` enumerates editable repos.
  - Given `plan`, Then a branch `plan/<planId>` is created from `main`.
  - Given `write_files`, Then commits land on `plan/<planId>`.
  - Given a successful sequence ending in `.genie/sync.json`, Then a PR is opened from `plan/<planId>` to `main`.
  - Given the PR is merged externally, Then subsequent `list_files` reflects merged state.
- **Note (D-G):** This full-fidelity mapping (`plan`→branch, `write_files`→commits, finalize→PR, merge→publish):
  - holds in **Shape A** (genie owns the repo as a standalone repo).
  - In **Shape B** (monorepo subtree, genie scoped to e.g. `packages/ui/`) it degrades gracefully — `plan` still scopes and validates, but the commit is yours and no PRs are opened behind your back.
  - **Shape C** (local folder, `git init` optional) is the solo case.
  - **Hard invariant:** never a repo nested inside a repo (`create_kit` refuses it).
- **Priority:** P1 · **Estimate:** L · **Milestone:** M5

#### DS-067 — `genie://components/{group}/{name}` resource

- **Persona:** A, D
- **Narrative:** As a Designer-Engineer in Claude Code/Cursor/VS Code, I want to `@genie:genie://components/actions/Button` as context, so the model has the latest API contract.
- **Acceptance criteria:**
  - Given a resource URI, Then the server returns the `.d.ts` content as MIME `application/typescript`.
  - Given `genie://manifest`, Then the current `.genie/manifest.json` returns.
  - Given `genie://tokens/<file>`, Then the file under `tokens/` returns.
- **Priority:** P1 · **Estimate:** M · **Milestone:** M5

#### DS-068 — fallback MCP prompts `/genie__new-component` and `/genie__audit`

- **Persona:** A
- **Narrative:** As a Designer-Engineer in a host without MCP Apps support, I want one-keystroke prompt templates as a fallback.
- **Acceptance criteria:**
  - Given `/genie__new-component`, Then the prompt is parameterized with `kit`, `description`, `group?`, `framework?`.
  - Given `/genie__audit`, Then it invokes `validate` and formats the result.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M5

#### DS-069 — Prometheus metrics

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want `/metrics` exposing standard counters and histograms, so my Grafana dashboards work.
- **Acceptance criteria:**
  - Given `GET /metrics`, Then a Prometheus exposition returns with `genie_tool_calls_total`, `genie_tool_latency_seconds`, `genie_generate_tokens_total`, `genie_validation_failures_total`, `genie_plan_active`, `genie_write_files_throughput`.
  - Given a tool call, Then `genie_tool_calls_total{tool="..."}` increments.
  - Given a latency, Then `genie_tool_latency_seconds_bucket{tool="..."}` records.
- **Priority:** P1 · **Estimate:** M · **Milestone:** M5

#### DS-070 — Structured logs with trace IDs

- **Persona:** C
- **Narrative:** As a Platform Engineer, I want JSON logs with a trace ID per request, so I can correlate across services.
- **Acceptance criteria:**
  - Given any tool call, Then a `traceId` is generated (uuid v7) and propagated to the configured LLM endpoint as `X-Trace-Id` header.
  - Given logs, Then they emit as one JSON object per line with `ts, level, traceId, tool, msg, durationMs`.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M5

#### DS-071 — `llms-install.md` per harness

- **Persona:** D, B
- **Narrative:** As an OSS Plugin Author, I want a single Markdown file with per-harness install snippets, so AI assistants can install the server unattended.
- **Acceptance criteria:**
  - Given `llms-install.md`, Then it includes valid JSON/TOML/YAML for each of 7 harnesses copy-pasted from the research report §7.
  - Given the file, Then it is referenced from `package.json#mcp.llmsInstall`.
- **Priority:** P1 · **Estimate:** S · **Milestone:** M5

### Epic E6 — Project preview and review enhancements (post-M5)

> **Sequencing (D-F / D-J):** A **project** is the screens you build _with_ a
> kit — full pages and flows, not library primitives. The project and blueprint
> tool contract ships in M1. This later epic deepens full-page preview and review
> UX without changing the nouns or adding a separate blueprint tool family.

#### DS-080 — project preview/review polish

- **Persona:** A, B
- **Narrative:** As a Designer-Engineer, I want generated screens to get the same preview, comment, refine, and commit ergonomics as component cards.
- **Acceptance criteria:**
  - Given a generated project screen, Then preview can render a full-page surface rather than only the component-card grid.
  - Given a selected screen region, Then refine can target the screen artifact without changing the M1 project schema.
  - Given a blueprint-derived workspace, Then the preview indicates the source blueprint without coupling future edits.
- **Scope note:** A "screen" is still generated → previewed → refined → committed; it is not a freeform drag-to-reflow canvas.
- **Priority:** P2 (post-M5 enhancement) · **Estimate:** XL · **Milestone:** post-M5

## 6. Functional requirements per surface

Numbered `FR-NNN`. Grouped by sub-surface. Where the research report
contains verbatim content, this section restates it as a contract.

### 6.1 MCP server tool catalog

The server exposes **19 M1 tools**: the 13 kit/component verbs from D-A plus six
project verbs from D-F. The 13 kit verbs collapse the 16 inherited Claude Design
verbs: two validate verbs merged, two legacy register verbs dropped. All tool names follow the shape
`mcp__genie__<verb>` and respect the `[A-Za-z0-9_-]`, ≤64-char Claude rewrite
rules. Each tool description ≤2 KB. All input/output uses JSON Schema Draft 7 — no
`$ref` chains, no `anyOf` discriminators.

| FR-ID  | Tool              | Behavior                                                                                                                                             | Idempotent? | Side effects                    | Errors                                                                                                                                  |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | `list_kits`       | Enumerates all kits visible across local FS + git-host backends                                                                                      | yes         | none                            | `ERR_BACKEND_UNREACHABLE` (warning, not fatal)                                                                                          |
| FR-002 | `get_kit`         | Returns kit metadata + `canEdit`                                                                                                                     | yes         | none                            | `ERR_KIT_NOT_FOUND`                                                                                                                     |
| FR-003 | `list_files`      | POSIX paths, sha256, ISO-8601                                                                                                                        | yes         | none                            | `ERR_KIT_NOT_FOUND`                                                                                                                     |
| FR-004 | `read_file`       | 256 KiB cap, utf-8 by default, base64 for binaries                                                                                                   | yes         | none                            | `ERR_FILE_TOO_LARGE`, `ERR_PATH_OUTSIDE_KIT`, `ERR_FILE_NOT_FOUND`                                                                      |
| FR-005 | `create_kit`      | Spawns kit skeleton (local FS + optional git-host repo); refuses a repo-inside-a-repo                                                                | no          | writes skeleton dir             | `ERR_KIT_EXISTS`, `ERR_BACKEND_WRITE_FAILED`, `ERR_NESTED_REPO`                                                                         |
| FR-006 | `plan`            | Locks capability grant; max 256 patterns, max 3 wildcards each                                                                                       | no          | persists plan                   | `ERR_KIT_NOT_FOUND`, `ERR_PLAN_TOO_MANY_PATTERNS`, `ERR_PATTERN_TOO_WILD`                                                               |
| FR-007 | `write_files`     | ≤256 files/call; reads from localPath so contents never enter model context                                                                          | partly      | writes files atomically         | `ERR_NO_PLAN`, `ERR_PLAN_EXPIRED`, `ERR_PATH_NOT_IN_PLAN`, `ERR_TOO_MANY_FILES_PER_CALL`, `ERR_PAYLOAD_TOO_LARGE`, `ERR_MARKER_MISSING` |
| FR-008 | `delete_files`    | Path must be in plan's deletes; non-existent paths are silent success                                                                                | yes         | deletes files                   | `ERR_NO_PLAN`, `ERR_PATH_NOT_IN_PLAN`                                                                                                   |
| FR-011 | `validate`        | Runs the full validator suite **and** persists its run counters (single verb merged from the inherited `report_validate` + `validate_design_system`) | yes         | writes `.genie/validation.json` | `ERR_KIT_NOT_FOUND`                                                                                                                     |
| FR-012 | `conjure`         | Endpoint-backed generation returning 5 artifacts through the validation gauntlet                                                                     | no          | issues generation call          | `ERR_MODEL_NOT_ROUTED`, `ERR_GENERATION_INVALID`, `ERR_UPSTREAM_5XX`, `ERR_RATE_LIMITED`, `ERR_LLM_AUTH`                                |
| FR-013 | `refine`          | Endpoint-backed refinement (diff-not-rewrite) with optional region rect hint                                                                         | no          | issues generation call          | as above + `ERR_COMPONENT_NOT_FOUND`                                                                                                    |
| FR-014 | `list_components` | Sorted (group, name)                                                                                                                                 | yes         | none                            | `ERR_KIT_NOT_FOUND`                                                                                                                     |
| FR-015 | `preview`         | Returns text URL + `ui://genie/grid?kitId=…` for MCP Apps hosts                                                                                      | yes         | none                            | `ERR_KIT_NOT_FOUND`                                                                                                                     |
| FR-052 | `list_projects`   | Enumerates workspaces and blueprint projects with kit bindings                                                                                       | yes         | none                            | `ERR_BACKEND_UNREACHABLE` (warning, not fatal)                                                                                          |
| FR-053 | `get_project`     | Returns project metadata, `kind`, bound kits, default kit, screens, and `canEdit`                                                                    | yes         | none                            | `ERR_PROJECT_NOT_FOUND`                                                                                                                 |
| FR-054 | `create_project`  | Creates blank workspace, blank blueprint, or workspace from blueprint                                                                                | no          | writes project skeleton         | `ERR_PROJECT_EXISTS`, `ERR_BLUEPRINT_NOT_FOUND`, `ERR_BACKEND_WRITE_FAILED`                                                             |
| FR-055 | `delete_project`  | Removes a project target; deleting a blueprint never deletes derived workspaces                                                                      | yes         | deletes project files           | `ERR_PROJECT_READONLY`                                                                                                                  |
| FR-056 | `bind_kit`        | Records a kit binding and optional default in `.genie/project.json`                                                                                  | partly      | writes project manifest         | `ERR_PROJECT_NOT_FOUND`, `ERR_KIT_NOT_FOUND`, `ERR_PROJECT_READONLY`                                                                    |
| FR-057 | `conjure_screen`  | Generates a project screen artifact with project/default-kit resolution                                                                              | no          | issues generation call          | `ERR_PROJECT_NOT_FOUND`, `ERR_PROJECT_KIT_REQUIRED`, `ERR_GENERATION_INVALID`, `ERR_LLM_AUTH`                                           |

_Catalog is 19 M1 tools: 13 kit/component verbs (D-A) plus 6 project verbs (D-F).
The inherited `register_assets` (FR-009) and
`unregister_assets` (FR-010) are **dropped** — the `@genie` marker IS the
registration. The inherited `report_validate` (FR-011) and
`validate_design_system` (FR-016) are **merged** into the single `validate` verb,
which retains FR-011; FR-009/FR-010/FR-016 are intentionally vacant to keep every
surviving FR number stable._

**Signatures (TypeScript):**

```ts
// Kit/component tools — genie's own names (D-A)
list_kits(): Array<{ id: string; name: string; owner: string; updatedAt: string; canEdit: boolean }>;
get_kit(args: { kitId: string }): { id: string; name: string; type: "GENIE_KIT"; canEdit: boolean };
list_files(args: { kitId: string }): Array<{ path: string; size: number; hash: string; lastModified: string }>;
read_file(args: { kitId: string; path: string }): { content: string; _meta?: { encoding: "base64" } };

create_kit(args: { name: string }): { kitId: string };
plan(args: { kitId: string; writes: string[]; deletes?: string[]; localDir?: string }): { planId: string };
write_files(args: {
  planId: string;
  files: Array<{ path: string; localPath?: string; data?: string; encoding?: "utf-8" | "base64"; mimeType?: string }>;
  _meta?: { final?: boolean };
}): { writtenPaths: string[] };
delete_files(args: { planId: string; paths: string[] }): { deletedPaths: string[] };
list_components(args: { kitId: string; group?: string }): Array<{
  name: string; group: string; path: string; viewport: { width: number; height: number };
  hash: string; lastModified: string;
}>;

// validate — single verb merged from the inherited report_validate + validate_design_system (D-A).
// Runs the full scan AND persists the run counters to .genie/validation.json.
validate(args: { kitId: string; planId?: string; counts?: { total: number; bad: number; thin: number; variantsIdentical: number; iterations: number } }): {
  markerMissing: string[]; thin: string[]; variantsIdentical: string[]; total: number; bad: number;
};

// genie-specific generation verbs (the two clay moments — D-I)
conjure(args: {
  kitId: string; kit: string; prompt: string;
  group?: string; refImageDataUrl?: string; refUrl?: string;
  framework?: "react" | "vue" | "html";
  model?: "design-default" | "design-best" | "design-local" | string;
}): { componentName: string; files: Array<{ path: string; content: string }>; manifestEntry: ManifestCard };

refine(args: {
  kitId: string; componentName: string; instruction: string;
  region?: { x: number; y: number; w: number; h: number };
}): { diff: string; files: Array<{ path: string; content: string }> };

preview(args: { kitId: string; componentName?: string; group?: string }): {
  content: Array<{ type: "text"; text: string }>;
  _meta: { ui: { resourceUri: string } };
};

// project verbs (D-F)
type ProjectKind = "workspace" | "blueprint";
type ProjectSummary = {
  id: string;
  name: string;
  kind: ProjectKind;
  defaultKitId?: string;
  kitBindings: Array<{ kitId: string; default?: boolean }>;
  updatedAt: string;
  canEdit: boolean;
};

list_projects(): ProjectSummary[];
get_project(args: { projectId: string }): ProjectSummary & {
  screens: Array<{ id: string; path: string; title: string; updatedAt: string }>;
  sourceBlueprintId?: string;
};
create_project(args: {
  name: string;
  kind: ProjectKind;
  fromBlueprintId?: string;
  kitBindings?: Array<{ kitId: string; default?: boolean }>;
}): { projectId: string };
delete_project(args: { projectId: string }): { deletedProjectId: string; warnings?: string[] };
bind_kit(args: { projectId: string; kitId: string; default?: boolean }): ProjectSummary;
conjure_screen(args: {
  projectId: string;
  prompt: string;
  kitId?: string;
  blueprintId?: string;
  model?: "design-default" | "design-best" | "design-local" | string;
}): {
  screenId: string;
  files: Array<{ path: string; content: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };
};
```

**FR-017 — Atomic write contract.** Every `write_files` call follows the
5-step sequence: (a) `.genie/recompile` sentinel first (only on first
call of a plan), (b) content writes ≤ 256/call, (c) deletes, (d) re-arm
sentinel, (e) `.genie/sync.json` last (only on the call marked `_meta.final: true`).

**FR-018 — Plan TTL.** Plans expire after a configurable TTL — 15 minutes
default, configurable up to 24 hours via `GENIE_PLAN_TTL_MIN` env var. v1 has
no `renew_plan`; clients re-finalize. Error string is `Plan {id} expired
(TTL N min). Re-finalize.` where `N` reflects the configured value.

**FR-019 — Plan persistence.** Plans persist in
`<data-dir>/.genie/plans.sqlite` so a server restart does not lose
in-flight plans. SQLite chosen for zero-dependency embed; it is the only
sqlite and holds throwaway server scratch only (no content — the git log is
the audit log, D-G).

**FR-020 — Tool description budget.** Each tool description is ≤ 2 KB
including any embedded examples to avoid Claude Code's silent truncation.

### 6.2 MCP resources

**FR-021 — `genie://components/{group}/{name}`.** Returns the component's
`<Name>.d.ts` file as MIME `application/typescript`. Used by host
autocomplete in Claude Code (`@genie:genie://components/actions/Button`),
Cursor, VS Code.

**FR-022 — `genie://manifest`.** Returns the current `.genie/manifest.json` for the
default kit (or the kit named in a `?kitId=` query string).
MIME `application/json`.

**FR-023 — `genie://tokens/{file}`.** Returns any file under the kit's
`tokens/` directory (e.g. `colors.css`, `space.json`). MIME inferred from
extension.

**FR-024 — Resource `list_changed`.** When a `write_files` lands, the
server emits `notifications/resources/list_changed` so Claude Code
re-indexes.

### 6.3 Fallback MCP prompts

**FR-025 — fallback `/genie__new-component`.** Parameters:
`{ kit: string, description: string, group?: string, framework?: "react"|"vue"|"html" }`.
Expands to a prompt that calls `conjure` then `preview`.

**FR-026 — fallback `/genie__audit`.** Parameters:
`{ kitId: string }`. Calls `validate` and formats the
result as a Markdown table grouped by violation type.

### 6.4 MCP-UI Apps payload (`ui://genie/grid`)

**FR-027 — Resource URI.** `ui://genie/grid?kitId=<id>&componentName=<opt>&group=<opt>`.

**FR-028 — MIME.** `text/html;profile=mcp-app` exactly, per the MCP Apps
spec (targeted 2026-01-26 — see INDEX honest-uncertainty #4).

**FR-029 — Tool linkage.** `preview` returns
`_meta.ui.resourceUri = "ui://genie/grid?kitId=…"`. Hosts
that support MCP Apps fetch the resource and embed it.

**FR-030 — Self-contained HTML.** The returned HTML inlines `.genie/manifest.json`
as `<script type="application/json" id="manifest">…</script>` so the
sandboxed iframe needs no fetch.

**FR-031 — Sandboxing.** The host wraps the payload in `<iframe sandbox>`
with MCP-Apps default sandbox flags. Our HTML adds a CSP `<meta>` tag:
`default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; frame-src 'self'`.

**FR-032 — postMessage bridge.** The HTML registers a `PostMessageTransport`
JSON-RPC 2.0 bridge per the MCP Apps spec, exposing `ui/message` to send
events back to the host (e.g. "user clicked Refine on card X").

### 6.5 Generation endpoint integration (configurable OpenAI-compatible)

genie calls a **configurable OpenAI-compatible chat-completions endpoint** (D-H).
LiteLLM is the reference implementation; Ollama, OpenAI, vLLM, or any compatible
gateway work identically. You own the model, the budget, the rate limits — no
provider URL or IP is baked into the product.

**FR-040 — Model alias.** Default model alias `design-default` (mapped by the
gateway's own config to a coding-capable chat model). Additional aliases
`design-best` (a higher-quality model) and `design-local` (a local model, e.g.
via Ollama). _Aliases are placeholders — confirm against your gateway's
`/v1/models`. The alias concept is endpoint-agnostic: only the gateway-side
mapping changes when you swap backends._

**FR-041 — Endpoint.** `GENIE_LLM_BASE_URL` (e.g.
`https://your-llm-gateway.example/v1`, no default baked in) + `/chat/completions`.
Any OpenAI-compatible base URL is accepted.

**FR-042 — Auth.** `Authorization: Bearer <GENIE_LLM_API_KEY>`. The
key is supplied via env / `user_config`; never logged, never hardcoded.

**FR-043 — Prompt template scaffolding.** The system prompt is loaded from
`prompts/system.md` and includes: tokens summary, existing component
Props signatures, the 5-file artifact contract, the `@genie` marker
requirement.

**FR-044 — Structured output schema.** `COMPONENT_SCHEMA`:

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["componentName", "group", "framework", "files"],
  "properties": {
    "componentName": { "type": "string", "pattern": "^[A-Z][A-Za-z0-9]+$" },
    "group": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "framework": { "enum": ["react", "vue", "html"] },
    "viewport": {
      "type": "object",
      "properties": {
        "width": { "type": "integer" },
        "height": { "type": "integer" },
      },
    },
    "files": {
      "type": "array",
      "minItems": 5,
      "maxItems": 5,
      "items": {
        "type": "object",
        "required": ["path", "content"],
        "properties": {
          "path": { "type": "string" },
          "content": { "type": "string" },
        },
      },
    },
  },
}
```

Server validates the endpoint response against this schema, attempts one
self-repair retry, then raises `ERR_GENERATION_INVALID`.

**FR-045 — Streaming.** `stream: true` on the endpoint POST. Server
forwards chunk events as MCP `notifications/progress`.

**FR-046 — Retry policy.** 429 → respect `Retry-After` header; do NOT
auto-retry; surface `ERR_RATE_LIMITED` to the caller with the retry-after
value. 5xx → 3 retries exponential backoff (1 s, 2 s, 4 s); other 4xx → no
retry.

**FR-047 — Trace propagation.** Server adds `X-Trace-Id: <uuid v7>` to
the endpoint request; the same id appears in logs and metric labels.

**FR-048 — Budget headers.** When the endpoint is LiteLLM, the optional
`x-litellm-key` and `x-litellm-team` headers are passed through when present
so per-team budgets are charged; other endpoints ignore them harmlessly.

### 6.6 Local component store schema

The on-disk layout is genie's **own** (D-C/D-D): all server bookkeeping lives
in one tidy `.genie/` directory rather than scattered `_ds_*` files at the kit
root. (The Anthropic `_ds_*` / `manifest.json`-at-root layout is read/written
**only** by the future interop adapter, never natively.)

```
ui_kits/<kit-name>/
├── _genie_bundle.js            # IIFE; window.<global>.<Component> exports
├── _genie_bundle.css           # bundle styles
├── styles.css                 # import-closure root previews consume
├── README.md                  # kit docs (human)
├── .genie/                    # all server bookkeeping (D-C)
│   ├── manifest.json          # client-side card index (server compiles — D-D)
│   ├── sync.json              # verification anchor (always last)
│   ├── recompile              # sentinel: { "by": "genie" }
│   ├── validation.json        # persisted validate() counters
│   └── plans.sqlite           # in-flight plan/TTL scratch (throwaway)
├── tokens/                    # token files (CSS variables, JSON tokens)
│   ├── colors.css
│   ├── space.css
│   └── typography.json
├── fonts/                     # font files (woff2, ttf)
├── _vendor/                   # vendored React/Vue runtime for previews
│   ├── react.production.min.js
│   └── react-dom.production.min.js
├── _preview/                  # generated preview helpers
│   └── chrome.css
├── guidelines/                # UI-kit guidelines (Markdown)
├── index.html                 # viewer entrypoint (Vite + file://)
├── viewer/
│   ├── viewer.js
│   └── viewer.css
└── components/
    └── <group>/<Name>/
        ├── <Name>.tsx         # source (React) or .vue (Vue) or .html
        ├── <Name>.jsx         # IIFE stub re-exporting from window global
        ├── <Name>.d.ts        # extracted via ts-morph — API contract
        ├── <Name>.prompt.md   # first line = element-index summary
        ├── <Name>.html        # preview; FIRST LINE = @genie marker
        └── meta.json          # per-component metadata
```

Project roots use their own manifest instead of nesting project state inside a kit:

```
projects/<project-name>/
├── .genie/
│   └── project.json           # kind, kit bindings, default kit, screen inventory
├── screens/
│   └── <screen-id>/
│       ├── screen.html
│       ├── screen.prompt.md
│       └── meta.json
└── README.md
```

**FR-050 — `.genie/manifest.json` schema** (`schemaVersion: 1`):

```jsonc
{
  "$schema": "https://genie.dev/manifest.schema.json",
  "schemaVersion": 1,
  "name": "Acme UI Kit",
  "generatedAt": "2026-06-21T12:00:00Z",
  "groups": [
    { "id": "actions", "label": "Actions" },
    { "id": "surfaces", "label": "Surfaces" },
  ],
  "cards": [
    {
      "id": "button-primary",
      "name": "Primary buttons",
      "subtitle": "Primary / secondary / ghost, 3 sizes",
      "group": "actions",
      "path": "components/actions/Button/Button.html",
      "viewport": { "width": 480, "height": 240 },
      "tags": ["interactive", "core"],
      "hash": "sha256-3f1e…",
      "lastModified": "2026-06-21T11:58:14Z",
    },
  ],
}
```

**FR-051 — meta.json per component schema:**

```jsonc
{
  "id": "Button",
  "name": "Primary buttons",
  "group": "actions",
  "viewport": { "width": 480, "height": 240 },
  "deps": ["../../tokens/colors.css"],
  "renderCheck": { "minHeight": 80, "expectVariants": 3 },
}
```

**FR-052 — `<Name>.html` first line** MUST match
`/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`. Optional attributes after
`group=` include `viewport="WxH"`, `name="..."`, `subtitle="..."`,
`tags="..."`.

**FR-053 — `<Name>.d.ts` extraction.** On every `write_files` of a
`<Name>.tsx`, the server runs `ts-morph` to emit a `<Name>.d.ts` exposing
the `<Name>Props` interface — what the canvas-side design agent reads as
the API contract.

**FR-054 — `.genie/sync.json` schema:**

```jsonc
{
  "version": 1,
  "writtenAt": "2026-06-21T12:00:00Z",
  "by": "genie",
  "sourceHashes": {
    "components/actions/Button/Button.tsx": "sha256-…",
    "components/actions/Button/Button.d.ts": "sha256-…",
  },
  "renderHashes": {
    "components/actions/Button/Button.html": "sha256-…",
  },
  "verified": ["actions/Button", "surfaces/Card"],
}
```

**FR-055 — `.genie/recompile` sentinel** contents: `{ "by": "genie" }`.
Cleared by the server-side self-check after manifest recompile.

**FR-056 — `_genie_bundle.js` header.** First line:
`/* @genie-bundle: { "schemaVersion": 1, "global": "AcmeKit" } */`. The
bundle is an IIFE assigning every component to `window.AcmeKit.<Component>`.

**FR-057 — Reserved file names.** The following are reserved and may not be
overwritten outside the canonical flow: the entire `.genie/` directory
(including `.genie/manifest.json`, `.genie/sync.json`, `.genie/recompile`,
`.genie/plans.sqlite`), plus the kit-root `_genie_bundle.js`, `_genie_bundle.css`,
`styles.css`, `index.html`.

**FR-058 — `<Name>.prompt.md` first-line convention.** The first line of
each `<Name>.prompt.md` is the element-index summary the design agent
reads at indexing time; subsequent lines are the per-component prompt /
docs that the design agent loads into context when refining.

### 6.7 The `@genie` marker regex contract

**FR-060 — Exact regex.** `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`.
Anchored to start of line. Matching tool is JavaScript's `RegExp.test` on
`firstLine = text.split('\n', 1)[0]`. (The Anthropic `@dsCard` regex lives
only in the future interop adapter.)

**FR-061 — Required attribute.** `group="<value>"` where `<value>` may be
empty string but the quotes MUST be present.

**FR-062 — Optional attributes.** `viewport="WxH"`, `name="..."`,
`subtitle="..."`, `tags="..."` (comma-separated). The `[^>]*` portion
allows any additional attributes.

**FR-063 — Validation sites.** The regex runs in three places:
(1) every `write_files` that includes a `.html` path under `components/`,
(2) `validate`, (3) the manifest compiler (which skips
non-matching files with a warning rather than aborting).

**FR-064 — Error code.** `ERR_MARKER_MISSING` (also surfaces as
`[MARKER_MISSING]` in human-formatted errors).

**FR-065 — Error message shape.**
`[MARKER_MISSING] <path>: first line isn't a \`<!-- @genie group="…" -->\` comment`.

### 6.8 Atomic write sequence

**FR-070 — Step 1 (sentinel first).** On the first `write_files` call of
a new plan, the server writes `.genie/recompile` BEFORE any
user-content file lands. Reason: the sentinel fences genie's own
manifest/copy machinery.

**FR-071 — Step 2 (content chunks ≤ 256).** Subsequent `write_files`
calls write user content in chunks of at most 256 files. Each call honors
the plan's `writes` allow-list.

**FR-072 — Step 3 (deletes).** `delete_files` calls run after content
writes. Non-existent deletes are silent success (idempotent).

**FR-073 — Step 4 (re-arm sentinel).** Before the final step, the
sentinel is touched again so its mtime is after every other write.

**FR-074 — Step 5 (`.genie/sync.json` last).** `.genie/sync.json` is written as
the final byte to land. A mid-sequence failure leaves the kit in a
verifiable "uncertified" state (no anchor → next sync re-uploads).

**FR-075 — Failure → STOP.** If any step except a not-found delete
fails, the sequence STOPS without writing `.genie/sync.json`. Client is
returned the error code and the list of files that did land.

**FR-076 — Final-call marker.** The client marks the terminal
`write_files` call with `_meta.final: true` so the server knows to write
the anchor and clear the sentinel.

### 6.9 The Vite-backed preview viewer (`@ambitresearch/genie-viewer`)

**FR-080 — CLI.** `npx genie-viewer <kit-dir> [--port N]
[--no-open] [--once]`. `--once` builds the static site and exits (used by
CI). `--no-open` skips opening the browser.

**FR-081 — Dev mode.** Runs `vite` against `kit-dir` with chokidar
watching `components/**/preview.html` and `.genie/manifest.json`. HMR pushes
`{type:'refresh', id}` over Vite's WebSocket.

**FR-082 — Build mode.** `--once` produces a static `dist/` directory
deployable to any static host. Output is fully self-contained.

**FR-083 — HMR contract.** On a `preview.html` save → server emits via
WebSocket → all listening iframes filter by id and reload self.
On a `.genie/manifest.json` save → grid re-flows without full page reload.

**FR-084 — Iframe sandboxing.** Every card iframe uses
`sandbox="allow-scripts"` with `loading="lazy"`. CSP `<meta>` on the
viewer page disallows `eval` and external scripts.

**FR-085 — Port selection.** Default 5173. If busy, walks up
(5174, 5175, ...) until a free port is found. Up to 100 attempts.

**FR-086 — File watching exclusions.** `.git/`, `.genie/`, `node_modules/`
excluded (the `.genie/` bookkeeping dir is server-owned, not a preview source).

**FR-087 — Accessibility.** Viewer chrome meets WCAG AA contrast. Each
iframe carries a `title` attr equal to the card name.

**FR-088 — Search filter.** A search input in the header filters cards
by name/group/tag, debounced 100 ms.

**FR-089 — Dark mode toggle.** The viewer chrome supports a light/dark
toggle; per-card iframes are unaffected (the UI kit owns its theme).

### 6.10 Distribution surfaces

**FR-090 — npm package.** `genie` published to public npm.
`main`: `dist/server.js`, `bin`: `dist/cli.js`, `exports.["./viewer"]`
pointing to the viewer entry. `peerDependencies`: none.
`dependencies` ≤ 20.

**FR-091 — `.mcpb` bundle.** Built via
`npx @modelcontextprotocol/mcpb pack`. Includes minimal vendored deps so
double-click install on Claude Desktop works without npm.

**FR-092 — Docker image.** `ghcr.io/roshangautam/genie:1.0`.
Multi-arch (amd64, arm64). Non-root UID 1000. Base: distroless node 22.
Exposes 8780/tcp.

**FR-093 — Smithery listing.** `smithery.yaml` at repo root declares
install snippets for each of 7 harnesses.

**FR-094 — Homebrew formula (post-v1).** `brew install genie`
shipping the npm binary wrapped as a formula.

**FR-095 — Per-harness install snippets.** `llms-install.md` contains
copy-pasteable JSON/TOML/YAML for Claude Code, Claude Desktop, Codex CLI,
VS Code Copilot, Cursor, Cline, Continue, per research §7.

## 7. Non-functional requirements

Numbered `NFR-NNN`. Targets are P50 unless otherwise noted.

### 7.1 Performance

| NFR-ID  | Requirement                                                                                    | Measurement                                                 |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| NFR-001 | Cold-start to first `tools/list` response < 2 s on stdio transport                             | bench harness against the binary                            |
| NFR-002 | Generation Time-To-First-Token < 800 ms via configured LLM endpoint                            | Prom histogram `genie_generate_ttft_seconds`                |
| NFR-003 | Generation end-to-end P50 < 4 s for typical components (≤ 200 LOC), P95 < 9 s                  | Prom histogram `genie_tool_latency_seconds{tool="conjure"}` |
| NFR-004 | Viewer first paint < 500 ms for a 100-card kit on M1 MacBook                                   | Lighthouse on `http://localhost:5173`                       |
| NFR-005 | `write_files` throughput ≥ 256 files in ≤ 2 s for files averaging 4 KiB                        | bench harness                                               |
| NFR-006 | `validate` runs in ≤ 5 s for a 100-component kit                                               | bench harness                                               |
| NFR-007 | Memory ceiling: server RSS ≤ 256 MiB at idle, ≤ 512 MiB under load (100 concurrent tool calls) | `process.memoryUsage().rss` polled                          |

### 7.2 Security

| NFR-ID  | Requirement                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-010 | Every preview iframe MUST use `sandbox="allow-scripts"`; never `allow-same-origin`                                                                                                |
| NFR-011 | No `eval`, no `new Function`, no dynamically constructed `<script>` anywhere in the viewer or `ui://` payload                                                                     |
| NFR-012 | CSP meta on `index.html`: `default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; frame-src 'self'`                                      |
| NFR-013 | All secrets via env vars (`GENIE_LLM_API_KEY`, `GENIE_TOKEN`, `GIT_TOKEN` for any git host); never accept secrets via tool params, never write them to logs or disk               |
| NFR-014 | OAuth DCR (RFC 7591) for hosts that support it (Claude Code, Codex CLI, Cursor); static `Authorization: Bearer` for the rest                                                      |
| NFR-015 | Path traversal protection on every file verb (`read_file`, `write_files`, `delete_files`): resolve and confirm prefix matches kit root; reject `..` segments before normalization |
| NFR-016 | TLS termination at the edge (Caddy / nginx / Cloudflare). HTTP transport never serves unencrypted in production                                                                   |
| NFR-017 | Rate limiting at the HTTP transport: max 60 req/min per token, configurable via `RATE_LIMIT_PER_MIN`                                                                              |
| NFR-018 | Token redaction in all logs: `Authorization`, `x-litellm-key`, `x-litellm-team` headers redacted to `***REDACTED***`                                                              |
| NFR-019 | `npm audit --audit-level high` passes in CI; supply-chain pinned via `package-lock.json`                                                                                          |
| NFR-020 | Container image scans pass against Trivy in CI (no HIGH/CRITICAL CVEs)                                                                                                            |

### 7.3 Reliability

| NFR-ID  | Requirement                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-030 | Graceful 429 from LLM endpoint → respect `Retry-After` header; do NOT auto-retry; surface `ERR_RATE_LIMITED` to the caller with the retry-after value |
| NFR-031 | Graceful 5xx from LLM endpoint → 3 retries with exponential backoff; on exhaustion, `ERR_UPSTREAM_5XX`                                                |
| NFR-032 | `plan` and `write_files` are idempotent for identical `planId` + identical payload: re-calls do not duplicate writes                                  |
| NFR-033 | Plan storage durable across restart (SQLite under `<data-dir>/.genie/`)                                                                               |
| NFR-034 | Healthcheck `GET /healthz` returns 200 within 100 ms when server is up                                                                                |
| NFR-035 | Readiness `GET /readyz` returns 200 only after the LLM endpoint is reachable (or 503 with an "llm endpoint unreachable" body)                         |
| NFR-036 | Server shuts down cleanly on SIGTERM within 5 s: drains in-flight, flushes plan state                                                                 |
| NFR-037 | At-least-once semantics on Prom metric writes (a missed scrape is acceptable; double-counting is not)                                                 |
| NFR-038 | A crashed worker is auto-restarted (process supervisor) without losing plan state                                                                     |

### 7.4 Accessibility

| NFR-ID  | Requirement                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------- |
| NFR-040 | Viewer chrome meets WCAG 2.1 AA contrast for all text vs background                                     |
| NFR-041 | Keyboard navigation: every interactive element in the viewer reachable via Tab, with visible focus ring |
| NFR-042 | Each card iframe has a `title` attribute equal to the card name                                         |
| NFR-043 | Search input has a programmatic label                                                                   |
| NFR-044 | No relying on color alone — group separators use text labels as well                                    |
| NFR-045 | Reduced motion: respects `prefers-reduced-motion: reduce` — HMR refresh skips fade animations           |

### 7.5 Localization

| NFR-ID  | Requirement                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| NFR-050 | v1: English-only chrome. All UI strings in the viewer use a `t(key)` helper backed by a single `en.json` catalog |
| NFR-051 | Catalog format keyed `category.key = "value"` so v1.x can add `es.json`, `ja.json`, etc., with no code change    |
| NFR-052 | All dates rendered with `Intl.DateTimeFormat` in user locale; not hardcoded format strings                       |
| NFR-053 | All tool descriptions and error messages in English; translation hook deferred to v1.x                           |

### 7.6 Observability

| NFR-ID  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-060 | Prometheus exposition at `GET /metrics` with: `genie_tool_calls_total`, `genie_tool_latency_seconds`, `genie_generate_tokens_total`, `genie_generate_ttft_seconds`, `genie_validation_failures_total`, `genie_plan_active`, `genie_write_files_throughput`, `genie_llm_endpoint_errors_total`, `genie_llm_endpoint_retries_total`, `genie_oauth_logins_total`, `genie_oauth_failures_total`, `genie_resource_fetches_total` |
| NFR-061 | Structured JSON logs to stdout — one event per line with `{ts, level, traceId, tool, msg, durationMs, …}`                                                                                                                                                                                                                                                                                                                   |
| NFR-062 | Trace IDs (uuid v7) generated on every tool call, propagated to the configured LLM endpoint as `X-Trace-Id`                                                                                                                                                                                                                                                                                                                 |
| NFR-063 | Log level configurable via `GENIE_LOG_LEVEL` env: debug, info, warn, error                                                                                                                                                                                                                                                                                                                                                  |
| NFR-064 | OpenTelemetry exporter optional (post-v1) — when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans flow to a collector                                                                                                                                                                                                                                                                                                            |

### 7.7 Compatibility

| NFR-ID  | Requirement                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-070 | Node.js ≥ 22 (LTS); ESM-only; no CommonJS interop                                                                                                                                                                                                                     |
| NFR-071 | macOS 13+, Linux (Debian 11+, Ubuntu 22.04+), Windows 11 with PowerShell ≥ 7 for stdio transport                                                                                                                                                                      |
| NFR-072 | Remote HTTP transport universal across OSes via Docker                                                                                                                                                                                                                |
| NFR-073 | _Version floors are current-stable estimates as of 2026-06-21; verify in CI matrix before GA._ Harness compatibility: Claude Code ≥ 2.0, Claude Desktop ≥ 1.20, Codex CLI ≥ 0.10, VS Code ≥ 1.102 (Copilot agent mode GA), Cursor ≥ 0.45, Cline ≥ 3.0, Continue ≥ 1.0 |
| NFR-074 | Tested against MCP spec revision 2025-11-25 (latest); forward-compat with 2026-q2 revision                                                                                                                                                                            |
| NFR-075 | JSON Schema Draft 7 only (avoids dialect issues in Continue / Cline)                                                                                                                                                                                                  |
| NFR-076 | UTF-8 file paths everywhere; do not rely on locale-dependent path encoding                                                                                                                                                                                            |

## 8. UX flows

Numbered. Each flow uses a sequence-style step list. The default path is local
stdio; HTTP examples are loopback dev or operator-managed self-hosting.

### Flow 1 — First-time local install in Claude Code

1. Designer-Engineer Priya opens Claude Code and types `/help mcp`.
2. She runs `claude mcp add genie -- npx -y genie --transport stdio`.
3. Claude Code launches the `genie` process when the MCP session starts.
4. `claude mcp list` shows `genie   ✓ ready (19 tools)`.
5. She runs `list_kits` from the MCP tool picker.
6. Result: an empty list.
7. She runs `create_kit({name:"acme-kit"})` → `{kitId:"acme-kit"}`.
8. Priya can now reference `@genie:genie://manifest` to view the
    kit's compiled card index.

**Failure modes:**

- `npx` package fetch fails → Claude Code reports process startup failure; user
  installs `genie` globally or retries with a pinned package version.
- Local config is invalid → `genie` exits non-zero with a JSON diagnostic on stderr.
- HTTP URL supplied without a running server → connection refused; use stdio for
  local first-run or start `genie serve --transport http` first.

### Flow 1a — Optional local HTTP dev install in Claude Code

1. Devika starts a loopback HTTP server:
   `genie serve --transport http --host 127.0.0.1 --port 8787`.
2. Priya runs
   `claude mcp add --transport http genie http://127.0.0.1:8787/mcp`.
3. Claude Code connects to the already-running local server.
4. `claude mcp list` shows `genie   ✓ ready (19 tools)`.
5. If HTTP auth is enabled, the harness uses the configured bearer/OIDC flow
   for that operator-managed endpoint; first-time local installs still use
   Flow 1.

### Flow 2 — Generate a new Button component from the MCP App

1. Priya runs `preview({kitId:"acme-kit"})` from Claude Code.
2. The result includes `_meta.ui.resourceUri:
   "ui://genie/grid?kitId=acme-kit"`.
3. The harness renders the MCP App inline; fallback hosts show the local viewer
   URL.
4. Priya opens the MCP App's **Generate** pane and enters:
   "Primary Button, actions group, three sizes, disabled state."
5. The MCP App posts a `ui/message` event with `{type:"conjure", kitId,
   group, prompt}`.
6. The host invokes
   `conjure({kitId:"acme-kit", kit:"acme-kit", prompt:"...", group:"actions"})`.
7. Server validates the request, streams progress, validates output, writes the
   five artifacts through the existing `plan`/`write_files` path, then updates
   `.genie/manifest.json`.
8. The MCP App refreshes from the updated manifest and shows the Button card.

**Failure modes:**

- Endpoint 429 → `ERR_RATE_LIMITED`; the MCP App shows retry-after.
- Schema repair fails → `ERR_GENERATION_INVALID`; the MCP App keeps the
  Generate pane open with the last input.
- `@genie` marker missing → `ERR_MARKER_MISSING`; the host retries only after
  Priya confirms the amended generation request.

### Flow 3 — Refine an existing component via region rect

1. Priya opens the Button card inside `ui://genie/grid?kitId=acme-kit`.
2. She clicks **Refine**; the MCP App overlay captures her drag-rect:
   `{x:120, y:80, w:200, h:60}`.
3. She enters "lift the shadow on hover."
4. The MCP App posts `{type:"refine", componentName:"Button", region,
   instruction}` through `ui/message`.
5. The host invokes `refine({kitId, componentName:"Button",
   instruction:"lift the shadow on hover", region:{x:120,y:80,w:200,h:60}})`.
6. Server constructs the endpoint prompt: includes existing `<Name>.tsx`, the
   instruction, and the region rect as a **hint** ("limit changes to the area at
   x=120,y=80,w=200,h=60 in the rendered preview"); the model is asked for a
   unified diff (not a rewrite) so the untouched rest is provable.
7. The endpoint returns a unified diff + updated files.
8. Server validates the `@genie` marker regex still passes on the updated `.html`.
9. Server runs the atomic 5-step write sequence.
10. The MCP App refreshes the Button card from the updated manifest.
11. Priya sees the new hover state without leaving the harness.

### Flow 4 — Open the preview pane from any harness

| Harness         | What happens                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Claude Code     | `preview` returns text URL + `_meta.ui.resourceUri`; inline MCP App when the host supports Apps. |
| Claude Desktop  | Inline MCP App when supported; otherwise opens the local viewer URL.                              |
| Codex CLI       | Text URL only; user opens the local viewer in a browser.                                          |
| VS Code Copilot | Inline MCP App in the chat panel when MCP Apps support is present; text URL remains as fallback.  |
| Cursor          | Inline MCP App when its Apps extension supports `ui://`; text URL remains as fallback.            |
| Cline           | Text URL only; user opens the local viewer in a browser.                                          |
| Continue        | Text URL only; user opens the local viewer in a browser.                                          |

All paths converge on the same `index.html` and same `.genie/manifest.json`.

### Flow 5 — Sync a kit to a git-host repo (Shape A)

1. Devika configures the server with `--git-remote <git-host-api-url>` and a
   git-host token.
2. Priya creates `acme-kit` from the MCP App's kit picker.
3. Server creates the `acme-kit` repo on the git host with initial commit on `main`.
4. Priya generates the Button through Flow 2.
5. Server creates a branch `plan/<planId>` from `main`.
6. Server commits each `write_files` batch to `plan/<planId>` with message
   `chore(genie): write_files batch N (planId=<id>)`.
7. After the terminal `_meta.final:true`, server opens a PR from
   `plan/<planId>` to `main` titled `feat(actions): add Button component`.
8. The MCP App shows a "PR opened" state with the git-host link.
9. Priya's teammate reviews + merges the PR in the git host's UI.
10. Subsequent `list_files({kitId})` reflects the merged state.

> This full-fidelity `plan`→branch / `write_files`→commits / finalize→PR mapping
> is **Shape A** (genie owns the repo). In **Shape B** (monorepo subtree) `plan`
> still scopes and validates, but the commit is yours and no PR is opened behind
> your back; **Shape C** is a local folder with `git init` optional (D-G).

### Flow 6 — Audit a kit for missing @genie markers

1. Priya opens the MCP App's **Audit** panel for `acme-kit`.
2. The MCP App posts `{type:"validate", kitId:"acme-kit"}` through
   `ui/message`; the host invokes `validate({kitId:"acme-kit"})`.
3. Server walks `components/**/*.html`, applies the regex to the first line,
   collects any failures into `markerMissing[]`.
4. Server hashes each preview's Playwright render and reports duplicates
   in `variantsIdentical[]`.
5. Server reports any preview body < 200 bytes in `thin[]`.
6. Server returns the report.
7. The MCP App renders a grouped table.
8. Priya sees: 2 missing `@genie`, 1 thin component, 0 duplicates.
9. She clicks **Fix markers**.
10. The host amends the first line of each failing file and re-runs the audit.

### Flow 7 — Upgrade from one model alias to another

1. Devika edits her gateway config (LiteLLM `config.yaml`, an Ollama
   model file, etc.): remaps `design-default` from a faster model to a
   higher-quality one.
2. She reloads the gateway (e.g. `litellm proxy reload`) — no MCP server restart needed.
3. Priya's next MCP App generation routes through the new model.
4. Latency, cost, and quality differ; she can override the model in the MCP
   App Generate pane or set the alias back.
5. Roll back: revert the gateway config, reload. Zero server change.

**Per-call override:** Priya can choose `design-best` or `design-local` (a
local model via Ollama) for any single generation or refine request.

### Flow 8 — Handle a generation-endpoint outage

1. The configured endpoint goes down (network blip, container restart).
2. Priya submits a generation from the MCP App.
3. Server attempts the POST; gets `ECONNREFUSED`.
4. Server treats this as 5xx and retries 3 times with exponential backoff
   (1 s, 2 s, 4 s).
5. All retries fail. Server raises `ERR_UPSTREAM_5XX` with the underlying
   error message echoed.
6. The MCP App shows: "Generation gateway unreachable. Underlying:
   `ECONNREFUSED <GENIE_LLM_BASE_URL host>`."
7. Priya checks her gateway's health endpoint (returns 503).
8. She restarts the gateway container.
9. `GET /readyz` on the MCP server returns 503 ("endpoint unreachable")
   until the gateway is back; then 200.
10. Priya clicks **Retry** in the MCP App and generation succeeds.

Prompt templates (`/genie__new-component`, `/genie__audit`) remain optional
fallbacks for hosts without MCP Apps support; they are not the primary UX.

## 9. Edge cases & error handling

Numbered `EC-NNN`. Minimum 25 entries. Trigger → expected behavior → error
code → user-facing message → recovery action.

| EC-ID  | Trigger                                                                                                                        | Expected behavior                                                                                            | Error code                       | User-facing message                                                                          | Recovery                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| EC-001 | `planId` expired (older than configured TTL; default 15 min, configurable up to 24h via `GENIE_PLAN_TTL_MIN`)                  | Reject `write_files`; clear plan from KV                                                                     | `ERR_PLAN_EXPIRED`               | "Plan abc123 expired (TTL 15 min). Re-plan." (N reflects configured value)                   | Client calls `plan` again with same writes/deletes; receives a new planId.                                                                    |
| EC-002 | File path outside the plan's `writes` allow-list                                                                               | Reject the entire `write_files` call (no partial writes)                                                     | `ERR_PATH_NOT_IN_PLAN`           | "Path components/widgets/Foo.html not in plan abc123's writes."                              | Re-`plan` with the missing pattern included.                                                                                                  |
| EC-003 | `write_files` exceeding 256 files in one call                                                                                  | Reject before any file lands                                                                                 | `ERR_TOO_MANY_FILES_PER_CALL`    | "256 files max per write_files call; got 311."                                               | Client chunks into multiple calls.                                                                                                            |
| EC-004 | Sentinel file race: two clients write `.genie/recompile` concurrently                                                          | Server uses POSIX `O_EXCL` semantics; second writer becomes a touch (mtime bump)                             | (no error)                       | n/a                                                                                          | n/a                                                                                                                                           |
| EC-005 | LLM endpoint 401 (invalid API key)                                                                                             | No retry; surface immediately                                                                                | `ERR_LLM_AUTH`                   | "LLM endpoint returned 401 — API key invalid or expired."                                    | Devika rotates `GENIE_LLM_API_KEY` in env; restart server.                                                                                    |
| EC-006 | LLM endpoint 429 (rate limit)                                                                                                  | Respect `Retry-After` header; do NOT auto-retry; surface `ERR_RATE_LIMITED` to caller with retry-after value | `ERR_RATE_LIMITED`               | "LLM endpoint rate-limited (retry in 12 s)."                                                 | Wait or adjust the endpoint/gateway budget.                                                                                                   |
| EC-007 | LLM endpoint 5xx                                                                                                               | 3 retries exponential backoff; then surface                                                                  | `ERR_UPSTREAM_5XX`               | "LLM endpoint returned 502 after 3 retries: \\"upstream timeout\\"."                         | Restart the gateway/provider route or check network connectivity.                                                                             |
| EC-008 | Harness disconnects mid-stream (Claude Code crash during generation)                                                           | Server completes the endpoint call and discards the response (no orphan files)                               | (no error to client)             | n/a                                                                                          | Client reconnects and retries the tool call.                                                                                                  |
| EC-009 | Vite port 5173 collision                                                                                                       | Viewer walks up to 5174, 5175, …; prints chosen port                                                         | (no error)                       | "Port 5173 busy; using 5174."                                                                | n/a                                                                                                                                           |
| EC-010 | Iframe sandbox blocks an inline script                                                                                         | Browser console logs the CSP violation; viewer chrome reports "card failed to render"                        | (no error to server)             | "Card button-primary failed to render — check console for CSP errors."                       | Author updates `preview.html` to comply with CSP.                                                                                             |
| EC-011 | Git host unreachable                                                                                                           | `list_kits` returns local FS entries with a warning in `_meta.warnings`                                      | `ERR_BACKEND_UNREACHABLE` (warn) | "Git host https://git.example.tld/api unreachable; showing local kits only."                 | Devika fixes the git host; subsequent calls auto-recover.                                                                                     |
| EC-012 | Malformed `@genie` line                                                                                                        | Validator rejects on first failing file; aborts entire `write_files`                                         | `ERR_MARKER_MISSING`             | "[MARKER_MISSING] components/actions/Button/Button.html: first line isn't a @genie comment." | Author prepends the correct first line.                                                                                                       |
| EC-013 | `.genie/manifest.json` schemaVersion mismatch (v1 server sees v2 manifest on disk)                                             | Server treats as upgrade; reads as v1 with warnings; v2-only fields ignored                                  | (no error)                       | "manifest.json schemaVersion=2 read by v1 server; some fields ignored."                      | Upgrade server.                                                                                                                               |
| EC-014 | Duplicate component name across groups (`actions/Button` + `widgets/Button`)                                                   | Manifest compiler raises on second; first one wins                                                           | `ERR_DUPLICATE_COMPONENT_NAME`   | "Duplicate component name 'Button' in groups actions, widgets."                              | Rename one of them or move into a single group.                                                                                               |
| EC-015 | `.genie/sync.json` written mid-sequence (client violates atomic contract)                                                      | Server detects (writes outside the canonical step 5); raises                                                 | `ERR_ANCHOR_OUT_OF_ORDER`        | ".genie/sync.json may only be written as the terminal step (\_meta.final:true)."             | Client re-issues with correct ordering.                                                                                                       |
| EC-016 | `localDir` outside server's allowed paths                                                                                      | `plan` rejects                                                                                               | `ERR_LOCALDIR_FORBIDDEN`         | "localDir /etc not under allowed roots."                                                     | Use a directory under `--data-dir`.                                                                                                           |
| EC-017 | `read_file` on a 300 KiB file                                                                                                  | Reject; do not stream partial                                                                                | `ERR_FILE_TOO_LARGE`             | "File 300000 bytes > 262144 byte cap."                                                       | Use `list_files` for metadata only; fetch via git for full content.                                                                           |
| EC-018 | Binary file in `read_file`                                                                                                     | Return base64 with `_meta.encoding: "base64"`                                                                | (no error)                       | n/a                                                                                          | Client decodes.                                                                                                                               |
| EC-019 | `conjure` returns a 4-file response (one missing)                                                                              | Schema repair retry; if still 4, raise                                                                       | `ERR_GENERATION_INVALID`         | "Generation missing required file <Name>.html (got 4 of 5)."                                 | Re-prompt with stricter system instructions.                                                                                                  |
| EC-020 | Plan SQLite corruption                                                                                                         | Server logs corruption; recreates empty DB; warns                                                            | `ERR_PLAN_STATE_RESET`           | "Plan state DB corrupted; reset. Active plans lost."                                         | Re-`plan` active plans.                                                                                                                       |
| EC-021 | Stale chokidar handle after kit rename                                                                                         | Viewer restart needed; CLI exits with code 2 and prints kit-not-found                                        | `ERR_KIT_DIR_MISSING`            | "Kit directory ui_kits/acme moved or deleted; restart the viewer with the new path."         | Re-run `npx genie-viewer <newpath>`.                                                                                                          |
| EC-022 | Two simultaneous `plan` for same kitId                                                                                         | Both succeed; both planIds valid; writes to overlapping paths are last-write-wins                            | (no error)                       | n/a                                                                                          | Client serializes its own plans.                                                                                                              |
| EC-023 | OAuth client refresh token expired                                                                                             | Server returns 401 with `WWW-Authenticate` directing re-auth                                                 | `ERR_OAUTH_EXPIRED`              | "OAuth token expired; please re-authenticate."                                               | Harness re-runs DCR flow.                                                                                                                     |
| EC-024 | Streaming response disconnect mid-token                                                                                        | Server treats as 5xx; retries 3x                                                                             | `ERR_UPSTREAM_5XX`               | "Generation endpoint stream disconnected."                                                   | Retry the call.                                                                                                                               |
| EC-025 | `ui://` resource fetched but harness doesn't recognize MIME                                                                    | Server returns 200; harness falls back to text                                                               | (no error)                       | n/a                                                                                          | n/a — by design.                                                                                                                              |
| EC-026 | Two kits with same `name` on disk                                                                                              | `create_kit` rejects                                                                                         | `ERR_KIT_EXISTS`                 | "Kit 'acme' already exists. Use --force or pick another name."                               | Rename or pass `--force`.                                                                                                                     |
| EC-027 | `refine` with non-existent componentName                                                                                       | Reject                                                                                                       | `ERR_COMPONENT_NOT_FOUND`        | "Component 'Foo' not found in kitId 'acme-kit'."                                             | Use `list_components` to confirm names.                                                                                                       |
| EC-028 | `conjure`/`refine` emits a viewport `{width:0,height:0}`                                                                       | Reject                                                                                                       | `ERR_INVALID_VIEWPORT`           | "viewport.width and viewport.height must be ≥ 1."                                            | Provide a non-zero viewport.                                                                                                                  |
| EC-029 | `write_files` exceeding payload byte cap (default 16 MiB; hard ceiling 64 MiB configurable via `GENIE_WRITE_BYTE_CAP` env var) | Reject                                                                                                       | `ERR_PAYLOAD_TOO_LARGE`          | "Payload 18 MiB > 16 MiB cap; halve chunk size."                                             | Client halves and retries (halve-and-retry recovery: on HTTP 500 from `write_files`, halve the file batch and retry; abort after 3 halvings). |
| EC-030 | Server clock skew vs generation endpoint (> 5 min)                                                                             | OAuth signing may reject                                                                                     | `ERR_CLOCK_SKEW`                 | "System clock differs from the endpoint by > 5 min; sync via NTP."                           | `sudo ntpdate -u pool.ntp.org`.                                                                                                               |

## 10. Out of scope (v1)

The following are deliberately excluded from v1 with rationale:

| Out-of-scope item                                                    | Rationale                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full freeform design canvas beyond the MCP App                       | A standalone hosted canvas and undocumented freeform prompt loop are open-ended R&D unrelated to the portable MCP substrate                                                               |
| Localization beyond English chrome                                   | Catalog hook is in place (NFR-051); content translation deferred to v1.x                                                                                                                  |
| Per-card screenshot diffing (image-hash sameness only)               | Pixel-level diffing requires headless Chromium in every install; deferred to v1.x. Image-hash sameness is enough to flag obvious duplicates                                               |
| Storybook integration (`--renderer=storybook`)                       | Greenfield gap (no canonical Storybook MCP); planned as v1.x adapter behind a flag                                                                                                        |
| Figma import (`ingest_figma`)                                        | Defer to Figma Dev Mode MCP server (already exists at `https://mcp.figma.com/mcp`); compose, don't subsume                                                                                |
| Component publishing to npm                                          | Out of scope; users own their own publish pipeline                                                                                                                                        |
| Real-time multi-user collaboration on the same plan                  | Single-user-per-plan in v1; plan storage SQLite, no CRDTs                                                                                                                                 |
| SAML/SCIM enterprise SSO                                             | OIDC covers the shared-deployment auth path; SAML deferred until enterprise demand surfaces                                                                                               |
| Mobile (iOS/Android) clients of the viewer                           | Desktop browsers only in v1; mobile is a v2 question                                                                                                                                      |
| Cost/billing dashboards                                              | Gateway/provider dashboards cover this; we expose Prom metrics but no UI                                                                                                                  |
| Cline/Continue-specific rich UI affordances                          | Both are tools-only per research §4; we don't optimize for them                                                                                                                           |
| AI-assisted naming of `group` taxonomy                               | First-version uses the model's suggestion or defaults to `misc`; taxonomy curation is a designer task                                                                                     |
| Auto-rollback on validation failure                                  | Plan-based atomicity means validation failures simply abort `.genie/sync.json`; the kit is recoverable but not auto-rolled-back                                                           |
| Plugin marketplace (Claude Code plugin form)                         | Plugin packaging is post-v1 — server stands alone first; plugin shape adds wrapping that risks marketplace review                                                                         |
| HTTP server clustering (multi-process / multi-replica)               | v1 is single-node; SQLite plan state precludes trivial horizontal scaling. Future: swap SQLite for Postgres + Redis                                                                       |
| Bespoke per-provider SDKs (bypassing the OpenAI-compatible contract) | genie speaks one OpenAI-compatible chat-completions contract (D-H); a gateway (LiteLLM/Ollama/OpenAI/vLLM) gives uniform retry, budget, audit. Per-provider SDK adapters are out of scope |
| Server-Sent Events transport                                         | Deprecated in Claude Code; only "legacy" in Cline; not worth the complexity (research §4)                                                                                                 |
| Bundled IdP                                                          | Users bring their own IdP; we document the OIDC discovery URL hook                                                                                                                        |

## 11. Release plan

Dates are relative to T+0 (project kickoff). Capacity assumption: one maintainer using AI agents.

| Release                 | Target date  | Scope                                                                                                                                                | Exit criteria                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1                    | T + 2 weeks  | M0 (scaffold + dual transport + CLI) + M1 (kit + project foundation)                                                                                 | Internal dogfood: Priya can create a kit, create a project, bind the kit, write files, and record a stubbed screen from Claude Code stdio                                                                                                                                                         |
| v0.5                    | T + 5 weeks  | + M2 (generation surface) + M3 (`@genie` validator + manifest compiler) — single-harness Claude Code stdio focus                                     | Alpha: external testers can generate a Button + Card kit end-to-end in Claude Code; `@genie` validation gating works; endpoint 429/5xx handled                                                                                                                                                    |
| v0.9                    | T + 8 weeks  | + M4 (Vite viewer + ui:// fallback) + tools-only smoke tests across 7 harnesses                                                                      | Beta: all 7 harnesses pass tools-only smoke test; Vite viewer ships; `ui://` payload registered; OAuth DCR available behind a flag                                                                                                                                                                |
| v0.95 (M6 GA Hardening) | T + 11 weeks | + M6 (GA Hardening: load test, security audit, supply-chain — sigstore + npm provenance, public docs site, launch checklist)                         | Release-candidate: M6 exit criteria met — load test passes targets (p95 < 500 ms reads, < 2 s writes, 100 concurrent for 5 min, error rate < 0.1%); Trivy + `npm audit` HIGH/CRITICAL clean; sigstore + npm provenance attestations published; public docs site live; launch checklist signed off |
| v1.0                    | T + 12 weeks | + M5 (auth + distribution + .mcpb + Smithery + ui:// rich rendering live in Claude/VS Code/ChatGPT/Cursor); incorporates M6 exit criteria from v0.95 | GA: npm published, `.mcpb` notarized, Docker image multi-arch, Smithery listed, CI matrix green, README has per-harness install snippets, semver-stable APIs, and every M6 exit criterion above carried forward                                                                                   |
| v1.1                    | T + 16 weeks | First post-GA iteration: pixel-diff variant detection, Storybook adapter behind flag, dark-mode viewer chrome, localization catalog wired            | Per-feature DoD; no breaking schema changes                                                                                                                                                                                                                                                       |

## 12. Open product questions

Tagged "decision", "user research", or "technical spike".

1. **Default model alias choice — sonnet-4-6 vs opus-4-8?**
   - Sonnet is faster/cheaper; Opus is higher quality.
   - Pick one as the default the user sees.
   - _Tag: needs a decision._
2. **`.genie/sync.json` "final" semantics — implicit (server tracks plan
   completion) or explicit (`_meta.final: true` flag on terminal
   write)?**
   - v1 prefers explicit.
   - _Tag: needs technical spike._
3. **~~Should `register_assets` / `unregister_assets` ship in v1?~~
   **Resolved (D-A):** both verbs are **dropped\*\* — the `@genie` marker IS the
   registration; to remove a card, delete the file. Hand-authored kits simply
   include the first-line marker.
4. **Should the viewer ship as a separate package (`@ambitresearch/genie-viewer`)
   or be bundled into the main npm package?**
   - Separate gives users the option to skip Vite/chokidar; bundled is one-command.
   - _Tag: needs decision._
5. **Should we adopt the "Anthropic Labs" branding (now killed per
   research vote), or just describe it as "an open-source tool inspired by Claude Design"?**
   - Affects positioning copy on README.
   - _Tag: needs a decision._
6. **Plan TTL default of 15 min — is that long enough for designer-driven
   flows where the user pauses to read?**
   - TTL is now configurable up to 24 hours via `GENIE_PLAN_TTL_MIN` env var; question is whether to bump the default and/or add a `renew_plan` verb.
   - _Tag: needs user research._
7. **Per-team budget enforcement — should the server short-circuit the
   call when the gateway's reported budget is exhausted, or always let
   the gateway (e.g. LiteLLM) be the authority?**
   - The latter is simpler; the former gives faster failure.
   - _Tag: needs technical spike._
8. **Should the viewer expose a "share" link that bakes the kit's
   `.genie/manifest.json` into a single static URL on a CDN, so designers can
   drop a link in Slack without `localhost`?**
   - _Tag: needs user research._
9. **Auth fallback for OSS users without an IdP — accept a simple
   pre-shared `GENIE_TOKEN` as the only auth path?**
   - v1 already does this; question is whether we deprecate it in v2.
   - _Tag: needs decision._
10. **Should `conjure` accept multi-file outputs (a Button
    plus its CSS module + storybook story) for v1, or restrict to the
    canonical 5-file output?**
    - Sticking with 5 is portable; flexible is powerful.
    - _Tag: needs technical spike._
11. **MCP-UI `ui://` rich rendering in Claude Code — verified or
    aspirational?**
    - Per research uncertainty #3.
    - If unverified at launch, we should ship the text URL fallback by default and add a `--ui` flag.
    - _Tag: needs technical spike._
12. **Should we ship a Claude Code plugin wrapping the server (so
    `claude /plugin install genie` works) or only the
    plain MCP server?**
    - _Tag: needs a decision._
