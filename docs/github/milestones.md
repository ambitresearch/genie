# genie — Milestone Catalog

Generated 2026-06-21. Derived from research report §7 (12-step build plan) and the
six-phase split in INDEX.md.

| ID  | Name                              | Window      | Issues | Theme                                                   |
|-----|-----------------------------------|-------------|--------|---------------------------------------------------------|
| M0  | Discovery & Scaffold              | wk 0–1      | 4      | Repo, governance, CI, dev-env                           |
| M1  | Kit + Project Foundation          | wk 1–3      | 19     | 13 kit verbs + 6 project verbs, storage, tests           |
| M2  | LLM Generation Surface            | wk 3–4      | 9      | `conjure`, `refine`, model routing |
| M3  | @genie Validator + Manifest      | wk 4–5      | 6      | First-line `@genie` marker contract + atomic write sequence |
| M4  | Preview Viewer (Vite + ui://)     | wk 5–7      | 10     | `@ambitresearch/genie-viewer` + MCP-Apps fallback          |
| M5  | Auth + Distribution + Smoke Tests | wk 7–11     | 16     | OAuth/bearer, .mcpb/npm/Docker, 7-harness smoke         |
| M6  | GA Hardening                      | wk 11–12    | 6      | Observability, perf, security, supply chain, launch     |

**Total issues: 70** (target was 58–70; this lands at the top of the band).

---

## M0 — Discovery & Scaffold

- **Window:** week 0–1 (≈4 working days)
- **Scope summary:** sign off the research report, stand up
  `roshangautam/genie` (MIT, TypeScript, ESM, Node ≥ 22), add
  CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / governance, wire CI, freeze the
  dev environment.
- **Exit criteria:**
  - [ ] Empty repo green on CI (lint + typecheck + placeholder test)
  - [ ] LICENSE = MIT, CODEOWNERS in place
  - [ ] `npm run dev` boots an MCP server scaffold (no tools registered yet)
- **Dependencies:** none.

## M1 — Kit + Project Foundation (genie's own 19-tool M1 surface)

- **Window:** week 1–3 (≈6 working days)
- **Scope summary:** genie's own 19-tool M1 surface: the 13 kit/component verbs —
  `list_kits` · `get_kit` · `list_files` · `read_file` · `create_kit` ·
  `plan` · `write_files` · `delete_files` · `validate` · `list_components` ·
  `conjure` · `refine` · `preview`
  (the inherited `register_assets`/`unregister_assets` are dropped — the
  `@genie` marker IS the registration; `report_validate` +
  `validate_design_system` are merged into `validate`), plus six project verbs —
  `list_projects` · `get_project` · `create_project` · `delete_project` ·
  `bind_kit` · `conjure_screen` — plus a storage
  abstraction (local FS for solo dev, any git host for shared) and the read → plan →
  write capability guard: write/delete calls without a valid `planId`, or with
  paths outside the plan, are rejected.
- **Exit criteria:**
  - [ ] All M1 tools implemented and unit-tested (≥90 % branch coverage)
  - [ ] Projects and blueprint projects persist `.genie/project.json`
  - [ ] `conjure_screen` resolves explicit/default/sole kit bindings and fails clearly when a kit is required
  - [ ] Plan-vs-write guard rejects out-of-plan paths and invalid `planId`
  - [ ] `write_files` caps at 256 files/call and reads from `localPath` (file
        contents never enter model context)
  - [ ] `read_file` 256 KiB cap enforced
  - [ ] git-host adapter passes the same conformance test suite as local FS
- **Dependencies:** M0.

## M2 — LLM Generation Surface

- **Window:** week 3–4 (≈4 working days)
- **Scope summary:** wire `openai` client to the configured OpenAI-compatible endpoint, define
  `COMPONENT_SCHEMA`, implement `conjure` + `refine`, ship
  retry/backoff + structured-output validation, default model
  `design-default` model alias.
- **Exit criteria:**
  - [ ] `conjure({ prompt })` returns files conforming to
        `COMPONENT_SCHEMA`
  - [ ] Model routing via operator-defined aliases (`design-default`, `design-best`,
        `design-local`)
  - [ ] Integration test against `GENIE_LLM_BASE_URL` passes in CI
- **Dependencies:** M1 (`write_files` is the consumer).

## M3 — @genie Validator + Manifest Compiler

- **Window:** week 4–5 (≈3 working days)
- **Scope summary:** implement genie's own `@genie` first-line marker validator
  with the regex `/^<!--\s*@genie\s+group="[^"]*"[^>]*-->/`, ship `validate`, watch the
  components tree with chokidar, recompile `manifest.json` on any preview HTML
  change, implement the 5-step atomic write sequence (sentinel · chunks · deletes
  · re-arm sentinel · anchor last).
- **Exit criteria:**
  - [ ] `[GENIE_MARKER_MISSING]` raised on first-line failure, exit code 1
  - [ ] `manifest.json` regenerated on save (< 100 ms)
  - [ ] Atomic write sequence verified via fault-injection tests
- **Dependencies:** M1 (`write_files`), M2 (generation produces HTML to validate).

## M4 — Preview Viewer (Vite + ui://)

- **Window:** week 5–7 (≈6 working days)
- **Scope summary:** build `@ambitresearch/genie-viewer` (Vite multi-page entry,
  chokidar HMR, sandboxed iframe grid), ship `preview` tool that returns
  `_meta.ui.resourceUri` for hosts that render `ui://`, register MIME
  `text/html;profile=mcp-app`, inline `manifest.json` into the iframe payload so
  no network fetch is needed in the sandbox.
- **Exit criteria:**
  - [ ] `npx @ambitresearch/genie-viewer ui_kits/<kit>` boots on `:5173` with HMR
  - [ ] `preview` rendered inline in VS Code Insiders + Claude Code
  - [ ] Viewer accessibility audit (axe-core) passes
- **Dependencies:** M3 (manifest is the input).

## M5 — Auth + Distribution + Smoke Tests

- **Window:** week 7–11 (≈10 working days)
- **Scope summary:** OAuth 2.0 with Dynamic Client Registration (Claude Code,
  Codex), static `Authorization: Bearer` fallback (VS Code, Cline, Continue),
  env-var secret handling, OIDC provider integration test, package as `.mcpb`,
  publish to npm + Docker + Smithery + mcpb.dev, per-harness config snippet docs
  for the 7 Tier-0 targets, end-to-end Playwright smoke test per harness.
- **Exit criteria:**
  - [ ] OAuth round-trip works in Claude Code and Codex CLI
  - [ ] `.mcpb` install works by double-click into Claude Desktop
  - [ ] `npm i -g genie` + `docker run roshangautam/genie` both produce a working server
  - [ ] All 7 harness config snippets copy-paste verified
  - [ ] Playwright smoke tests green across 7 harnesses (or honest matrix in CHANGELOG with the gap noted)
- **Dependencies:** M2, M3, M4.

## M6 — GA Hardening

- **Window:** week 11–12 (≈4 working days)
- **Scope summary:** observability (Prometheus exporter, Grafana dashboard),
  load test, security audit, supply-chain hardening (sigstore + npm provenance),
  public-facing docs site, launch checklist.
- **Exit criteria:**
  - [ ] Grafana dashboard JSON imports cleanly with at least p50/p95/p99 tool
        latency + error rate panels
  - [ ] Load test report: server handles 100 concurrent plans without OOM
  - [ ] `npm audit --omit=dev` clean
  - [ ] sigstore signatures on every release artefact, npm `--provenance` flag
        set in CI
- **Dependencies:** M5.
