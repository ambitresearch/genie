# Security model

## Trust boundaries

- Model output is untrusted data. It is schema-validated and cannot persist without the
  separate plan/write flow.
- Kit file operations normalize paths and remain inside the selected store root.
- Embedded cards run in sandboxed iframes with `default-src 'none'` and
  `connect-src 'none'`.
- Secrets are loaded from environment variables or an owner-only mounted file and are
  redacted from structured logs.

## Plan-guarded writes

Review treats generated and refined files as untrusted proposals until a user explicitly
confirms Apply. Generate, Refine, Approve, Request Changes, deterministic controls, and
navigation must never invoke persistence. Apply is the only Review path that may create a
plan and write.

The plan is a scoped, expiring write authorization. It names the exact write/delete path
scope for the selected UI kit, and the plan guard rejects missing or expired plans and any
requested path outside that scope. The approved payload is then written atomically through
`write_files`; a returned `writtenPaths` is the authoritative signal that the write
succeeded. Post-write kit validation is advisory only: it may fail or be unavailable
without turning a successful write into a reported failure, so a validation problem never
forces a second write of bytes already on disk. Manifest and preview refresh gate only the
claim that Browse shows the new bytes; a refresh failure is reported as written but
possibly stale, never as a failed Apply.

Writes are contained to the selected UI kit under the normalized kit store root. A draft
cannot expand its own write scope by returning new paths, absolute paths, parent-directory
segments, or tool text that looks like a command. Retry after a failed or expired Apply
requires a fresh confirmation and a fresh plan.

## Rendering untrusted Review data

Diffs, source, model messages, tool errors, and diagnostics are rendered as data, not as
markup. User-visible diagnostics are redacted before display so secrets and local absolute
paths do not leak through the Review rail, checklist, or failure messages.

Embedded Review keeps the same CSP posture as other embedded cards: `default-src 'none'`
and `connect-src 'none'`. It uses only the host MCP bridge for Refine and Apply; the
browser does not receive model credentials, direct filesystem access, or a direct model
endpoint.

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
