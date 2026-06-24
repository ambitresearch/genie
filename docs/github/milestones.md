# genie — Milestone Catalog

Generated 2026-06-21. Derived from research report §7 (12-step build plan) and the
six-phase split in INDEX.md.

| ID  | Name                              | Window      | Issues | Theme                                                   |
|-----|-----------------------------------|-------------|--------|---------------------------------------------------------|
| M0  | Discovery & Scaffold              | wk 0–1      | 4      | Repo, governance, CI, dev-env                           |
| M1  | Tier-0 File Verbs                 | wk 1–3      | 15     | The 12-method DesignSync mirror + storage + tests       |
| M2  | LiteLLM Generation Surface        | wk 3–4      | 9      | `generate_component`, `refine_component`, model routing |
| M3  | @dsCard Validator + Manifest      | wk 4–5      | 6      | First-line regex contract + atomic write sequence       |
| M4  | Preview Viewer (Vite + ui://)     | wk 5–7      | 10     | `@genie/viewer` + MCP-Apps fallback          |
| M5  | Auth + Distribution + Smoke Tests | wk 7–11     | 16     | OAuth/bearer, .mcpb/npm/Docker, 7-harness smoke         |
| M6  | GA Hardening                      | wk 11–12    | 6      | Observability, perf, security, supply chain, launch     |

**Total issues: 66** (target was 58–70; this lands inside the band).

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

## M1 — Tier-0 File Verbs (DesignSync 12-method mirror)

- **Window:** week 1–3 (≈6 working days)
- **Scope summary:** verbatim mirror of DesignSync's 12-method protocol —
  `list_projects` · `get_project` · `list_files` · `get_file` · `create_project` ·
  `finalize_plan` · `write_files` · `delete_files` · `register_assets` ·
  `unregister_assets` · `report_validate` · `list_components`, plus a storage
  abstraction (local FS for solo dev, Gitea for shared) and the read → plan →
  write capability guard enforced exactly as the schema description spells out:
  "Calling write, delete, register, or unregister without a valid `planId`, or
  with paths outside the plan, is rejected."
- **Exit criteria:**
  - [ ] All 12 verbs implemented and unit-tested (≥90 % branch coverage)
  - [ ] Plan-vs-write guard rejects out-of-plan paths and invalid `planId`
  - [ ] `write_files` caps at 256 files/call and reads from `localPath` (file
        contents never enter model context)
  - [ ] `get_file` 256 KiB cap enforced
  - [ ] Gitea adapter passes the same conformance test suite as local FS
- **Dependencies:** M0.

## M2 — LiteLLM Generation Surface

- **Window:** week 3–4 (≈4 working days)
- **Scope summary:** wire `openai` client to LiteLLM gateway, define
  `COMPONENT_SCHEMA`, implement `generate_component` + `refine_component`, ship
  retry/backoff + structured-output validation, default model
  `anthropic/claude-sonnet-4-6` via LiteLLM `design-default` alias.
- **Exit criteria:**
  - [ ] `generate_component({ prompt })` returns files conforming to
        `COMPONENT_SCHEMA`
  - [ ] Model routing via LiteLLM aliases (`design-default`, `design-best`,
        `design-local`)
  - [ ] Integration test against `https://litellm.roshangautam.com` passes in CI
- **Dependencies:** M1 (`write_files` is the consumer).

## M3 — @dsCard Validator + Manifest Compiler

- **Window:** week 4–5 (≈3 working days)
- **Scope summary:** port the regex `/^<!--\s*@dsCard\s+group="[^"]*"[^>]*-->/`
  from `package-validate.mjs`, ship `validate_design_system`, watch the
  components tree with chokidar, recompile `manifest.json` on any preview HTML
  change, implement the 5-step atomic write sequence (sentinel · chunks · deletes
  · re-arm sentinel · anchor last).
- **Exit criteria:**
  - [ ] `[DSCARD_MISSING]` raised on first-line failure, exit code 1
  - [ ] `manifest.json` regenerated on save (< 100 ms)
  - [ ] Atomic write sequence verified via fault-injection tests
- **Dependencies:** M1 (`write_files`), M2 (generation produces HTML to validate).

## M4 — Preview Viewer (Vite + ui://)

- **Window:** week 5–7 (≈6 working days)
- **Scope summary:** build `@genie/viewer` (Vite multi-page entry,
  chokidar HMR, sandboxed iframe grid), ship `render_preview` tool that returns
  `_meta.ui.resourceUri` for hosts that render `ui://`, register MIME
  `text/html;profile=mcp-app`, inline `manifest.json` into the iframe payload so
  no network fetch is needed in the sandbox.
- **Exit criteria:**
  - [ ] `npx genie-viewer ui_kits/<kit>` boots on `:5173` with HMR
  - [ ] `render_preview` rendered inline in VS Code Insiders + Claude Code
  - [ ] Viewer accessibility audit (axe-core) passes
- **Dependencies:** M3 (manifest is the input).

## M5 — Auth + Distribution + Smoke Tests

- **Window:** week 7–11 (≈10 working days)
- **Scope summary:** OAuth 2.0 with Dynamic Client Registration (Claude Code,
  Codex), static `Authorization: Bearer` fallback (VS Code, Cline, Continue),
  env-var secret handling, Authentik OIDC integration test, package as `.mcpb`,
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
  - [ ] Grafana dashboard live on TrueNAS with at least p50/p95/p99 tool
        latency + error rate panels
  - [ ] Load test report: server handles 100 concurrent plans without OOM
  - [ ] `npm audit --omit=dev` clean
  - [ ] sigstore signatures on every release artefact, npm `--provenance` flag
        set in CI
- **Dependencies:** M5.
