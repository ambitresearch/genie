# Changelog

All notable changes to genie are recorded here. This file is the project-level
history; per-document changelogs live in each doc's own header (e.g. BRD §1.3,
PRD §1). Once releases begin, [release-please](https://github.com/googleapis/release-please)
manages versioned entries from Conventional Commits.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project aims to follow [Semantic Versioning](https://semver.org/) from 1.0.

## [Unreleased]

### Changed

- **Raised the minimum Node.js version from 18 to 22.** _(2026-06-24)_
  Node 18 reached end-of-life in April 2025 and Node 20 in April 2026; Node 22
  ("Jod") is the current Active LTS, with Node 24 also Active. The modern
  toolchain forced the move — pnpm 11 requires Node ≥ 22.13 (`node:sqlite`) and
  Vitest 4 requires Node ≥ 20 (`node:util` `styleText`). Rather than pin every
  tool to an older line indefinitely, the floor was raised to the current LTS.
  pnpm is pinned to 10.34.4 (which still supports Node ≥ 18.12) for now; the CI
  matrix now tests Node 22 and 24 on Ubuntu and macOS. Updated across all plan
  docs, INDEX, milestones, the M0-03/M0-04 issues, README, and CONTRIBUTING.

### Added

- **M0 — Discovery & Scaffold.** _(2026-06-24)_
  - Bootable MCP server (`@genie/server`) with a stdio/HTTP transport
    multiplexer (RFC §5.2) and a built-in `ping` health tool. Speaks MCP
    end-to-end: `initialize → tools/list → tools/call ping → "pong"`.
  - pnpm workspace (`server` / `viewer` / `e2e`), TypeScript strict/ESM/NodeNext,
    ESLint flat config, Prettier, Vitest. `pnpm i / dev / build / test / lint /
    typecheck` all green.
  - CI (GitHub Actions): lint/typecheck/test/build matrix + release-please.
  - Governance: LICENSE (MIT), NOTICE, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT,
    root README.
  - `docs/traceability.md` — research claims → milestones matrix (M0-01).
  - Design folder restructured to `docs/designs/design-1/` (canonical) with
    Copilot variants `design-2|3|4/` for later A/B.

[Unreleased]: https://github.com/roshangautam/genie/commits/main
