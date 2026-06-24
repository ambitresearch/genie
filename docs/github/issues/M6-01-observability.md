---
title: "[M6-01] Observability: Prometheus exporter + Grafana dashboard"
milestone: "M6 — GA Hardening"
labels: ["type:infra", "area:mcp-server", "priority:P1-high", "size:M"]
assignees: []
estimate: "6h"
---

## Summary
Expose Prometheus metrics from the MCP server (`/metrics` endpoint) and ship
a Grafana dashboard JSON for the homelab Grafana (per CLAUDE.md). Metrics
cover the four golden signals plus per-tool latency / count / error rate.

## Context
- CLAUDE.md homelab context: Grafana already runs on TrueNAS.
- Research report §6: "LiteLLM's per-key/per-team budget + rate-limit
  middleware. Gained: real Prometheus metrics on your homelab Grafana."

## Acceptance Criteria
- [ ] AC1 — `/metrics` endpoint serves Prometheus text format with at
      least: `genie_tool_calls_total{tool,status}`,
      `genie_tool_latency_seconds{tool}` (histogram, p50/p95/p99),
      `genie_plan_count{state}`, `genie_llm_tokens_total{model,
      kind}`.
- [ ] AC2 — Endpoint is auth-gated by the bearer-token middleware (M5-02)
      with `scope: metrics`.
- [ ] AC3 — `deploy/grafana/dashboard.json` defines panels: tool latency
      p50/p95/p99 by verb, error rate, plan lifecycle, LLM token usage,
      LiteLLM cost estimate.
- [ ] AC4 — Dashboard imports cleanly into Grafana 11+; documented in
      `docs/06-operations-runbook.md`.
- [ ] AC5 — Scrape config sample in `deploy/prometheus/scrape.yml`.

## Implementation Notes
- File: `packages/server/src/metrics/{registry,middleware}.ts`,
  `deploy/grafana/dashboard.json`.
- Use `prom-client` v15+.

## Out of Scope
- Tracing (OTLP) — defer to v2.

## Dependencies
- Blocks: nothing.
- Blocked by: M5 milestone close.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — `/metrics` content snapshot.
- [ ] Docs updated.
- [ ] Manual verification — dashboard live with real data.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
