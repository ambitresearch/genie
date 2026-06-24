# Security Policy

genie is a solo, best-effort open-source project. Security reports are taken
seriously, but please set expectations accordingly: there is no SLA, and
response is best-effort (see `docs/plan/06-operations-runbook.md` §11.1).

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's built-in advisory flow:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, affected version, and a reproduction if possible.

You can expect an acknowledgement within a few days (best-effort). Once a fix is
available, a GitHub Security Advisory (GHSA) will be published with credit to the
reporter unless anonymity is requested.

## Scope

genie stores **no PII** and **no end-user data** beyond what an operator places
in their own git-backed component store. It speaks to whatever LLM endpoint the
operator configures (via LiteLLM or direct). The most security-relevant surfaces:

- The MCP tool layer (path traversal, plan/write boundary enforcement).
- The auth subsystem (OAuth/bearer — lands in M5).
- The preview viewer's iframe sandbox + CSP (lands in M4).
- Supply-chain integrity of published artifacts (npm provenance — M6).

## Supported versions

Pre-1.0: only the latest release is supported. Once genie reaches 1.0, this
policy will be updated with a support window.
