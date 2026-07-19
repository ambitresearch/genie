---
title: "[M5-07] Docker image (multi-arch amd64/arm64)"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:infra", "area:ci", "priority:P1-high", "size:M"]
assignees: []
estimate: "5h"
---

## Summary
Build multi-arch Docker images for amd64 + arm64. Publish
`docker.io/roshangautam/genie` and `ghcr.io/ambitresearch/genie` on every
release. Includes a `docker-compose.yml` reference for self-hosters.

## Context
- INDEX.md: distribution includes Docker.

## Acceptance Criteria
- [ ] AC1 — `Dockerfile` uses `node:22-alpine` base, multi-stage
      (build + runtime).
- [ ] AC2 — Runtime image < 200 MB.
- [ ] AC3 — Runs as UID 1000, not root.
- [ ] AC4 — Healthcheck: `curl -f http://localhost:8080/health || exit 1`.
- [ ] AC5 — `docker buildx build --platform linux/amd64,linux/arm64`
      succeeds and pushes to both registries.
- [ ] AC6 — `deploy/docker-compose.yml` includes the MCP server +
      commented kit-root volume/env examples; no git host sidecar by default.
- [ ] AC7 — Image signed via sigstore cosign (keyless).

## Implementation Notes
- File: `Dockerfile`, `deploy/docker-compose.yml`.

## Out of Scope
- Helm chart (v2).
- Kubernetes manifests (v2).

## Dependencies
- Blocks: nothing critical.
- Blocked by: M0-04, M5-06.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — image starts; healthcheck green.
- [ ] Docs updated — README Docker section.
- [ ] Manual verification — `docker run -p 8080:8080 ...` works.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
