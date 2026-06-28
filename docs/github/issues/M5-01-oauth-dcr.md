---
title: "[M5-01] OAuth 2.0 with Dynamic Client Registration"
milestone: "M5 — Auth + Distribution + Smoke Tests"
labels: ["type:security", "area:mcp-server", "priority:P0-critical", "size:L"]
assignees: []
estimate: "12h"
---

## Summary
Implement OAuth 2.0 with Dynamic Client Registration (RFC 7591) on the MCP
HTTP server so shared Claude Code installs and Codex CLI's `codex mcp login`
flow work against an already-running genie URL. Authorisation Server metadata served at
`/.well-known/oauth-authorization-server`; DCR endpoint at `/register`.

## Context
- Research report §3.2 auth table: "OAuth 2.0 + Dynamic Client Registration
  — Claude Code, Codex CLI (first-class)".
- §4 Codex CLI section: "Run `codex mcp login <server-name>`. Top-level
  `mcp_oauth_callback_port` and `mcp_oauth_callback_url` for callback
  overrides. Codex prefers server-advertised `scopes_supported`."
- §7 step 8: "OAuth + static-bearer auth … per MCP spec
  modelcontextprotocol.io/specification".

## Acceptance Criteria
- [ ] AC1 — `/.well-known/oauth-authorization-server` returns RFC 8414
      metadata: `authorization_endpoint`, `token_endpoint`,
      `registration_endpoint`, `scopes_supported`,
      `code_challenge_methods_supported: ["S256"]`.
- [ ] AC2 — `/register` accepts a DCR request and returns
      `{ client_id, client_secret, client_secret_expires_at: 0 }`.
- [ ] AC3 — `/authorize` shows a consent screen listing requested scopes
      (`read`, `write`); redirects back with `code` on accept.
- [ ] AC4 — `/token` accepts authorization code + PKCE verifier; returns
      `{ access_token, token_type: "Bearer", expires_in: 3600,
      refresh_token }`.
- [ ] AC5 — Bearer access tokens are JWTs signed with HS256, scope claim
      present.
- [ ] AC6 — Claude Code `claude mcp add --transport http genie
      <url>` against an already-running server triggers DCR + browser auth
      without manual intervention.
- [ ] AC7 — `codex mcp login genie` round-trips successfully.

## Implementation Notes
- File: `packages/server/src/auth/oauth/{metadata,dcr,authorize,token}.ts`.
- JWT signing key from env `OAUTH_HS256_KEY`; refuse to start if missing or
  < 32 chars.
- Consent screen is a minimal server-rendered HTML page (no SPA).

## Out of Scope
- OIDC ID-token issuance (M5-04 covers that via the provider integration test).
- Refresh-token rotation (RFC 6749 §6 — defer to v2).

## Dependencies
- Blocks: M5-09 (Claude Code smoke), M5-11 (Codex smoke).
- Blocked by: M0-04.

## Agent Workflow

**Follow the full SDLC in [`AGENTS.md`](../../../AGENTS.md)** (repo root): orient →
plan-on-issue → TDD (failing test first) → test against the local live service →
adversarial self-review → open PR → peer-AI review loop (iterate until zero open comments
+ explicit approval) → merge → monitor CI → follow-up PR if CI breaks, else close.

Do not merge with open review comments. Do not leave `main` red. The issue closes only
when the PR is merged, the reviewer approved, CI is green, and every AC has evidence.

## Definition of Done
- [ ] Tests added — OAuth flow integration test against a stub client.
- [ ] Docs updated — `docs/04-tech-design-rfc.md` auth section.
- [ ] Manual verification — `claude mcp add` + `codex mcp login` both work.
- [ ] No new ESLint/TS errors.
- [ ] Reviewed by 1 maintainer.
