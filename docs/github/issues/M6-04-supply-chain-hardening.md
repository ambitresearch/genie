---
title: "[M6-04] Supply-chain hardening (sigstore + npm provenance)"
milestone: "M6 — GA Hardening"
labels: ["type:security", "area:ci", "priority:P0-critical", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Sign every release artefact with sigstore cosign (keyless, OIDC against
GitHub Actions). Enable npm `--provenance` flag (M5-06 already wired — this
issue verifies + documents). Publish SBOM (CycloneDX) alongside each release.

## Context
- Modern supply-chain best practice; defends against the npm token-theft
  pattern.

## Acceptance Criteria
- [ ] AC1 — `.github/workflows/release.yml` runs `cosign sign-blob` against
      every release artefact (`*.mcpb`, `*.tgz`, Docker image digest).
- [ ] AC2 — Cosign signatures published as `*.sig` files next to each
      artefact + uploaded to the Rekor transparency log.
- [ ] AC3 — npm packages publish with `--provenance` and the attestation
      is visible on `https://www.npmjs.com/package/genie`.
- [ ] AC4 — SBOM generated via `@cyclonedx/cdxgen` and attached to each
      Release.
- [ ] AC5 — Docs explain how downstream users verify the chain: `cosign
      verify-blob --certificate-identity-regexp ...`.

## Implementation Notes
- File: `.github/workflows/release.yml`, `docs/supply-chain.md`.

## Out of Scope
- in-toto / SLSA Level 3+ (defer to v2).

## Dependencies
- Blocks: GA tag.
- Blocked by: M5-06, M5-07.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — verify-after-publish in CI.
- [ ] Docs updated.
- [ ] Manual verification — sigstore proof on a real release.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
