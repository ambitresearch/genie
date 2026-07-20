# Security model

## Trust boundaries

- Model output is untrusted data. It is schema-validated and cannot persist without the
  separate plan/write flow.
- Kit file operations normalize paths and remain inside the selected store root.
- Embedded cards run in sandboxed iframes with `default-src 'none'` and
  `connect-src 'none'`.
- Secrets are loaded from environment variables or an owner-only mounted file and are
  redacted from structured logs.

## HTTP authentication

Local stdio uses the harness-owned process boundary. HTTP can require static Bearer
tokens, use genie's OAuth 2.0 endpoints, or verify an upstream OIDC provider and group
policy. The exact CLI and environment contracts are tested under `packages/server/src/auth`
and `packages/e2e/test/m5-oidc.test.ts`.

## Vulnerability reports

Use the repository's private GitHub Security Advisory flow. Do not disclose an unpatched
vulnerability in a public issue.

Security-sensitive changes are covered by focused tests, full-history secret scanning,
dependency scanning, and the repository's protected review workflow.
