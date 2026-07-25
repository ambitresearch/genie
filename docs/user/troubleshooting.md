# Troubleshooting

## The server exits before connecting

Follow [Installation and configuration](installation.md#required-secrets).
`GENIE_LLM_API_KEY` must contain at least 16 characters. `OAUTH_HS256_KEY` is optional,
HTTP-only, and must contain at least 32 characters when configured. Keep diagnostic output
on stderr; stdout is the stdio protocol stream.

## `conjure` or `refine` reports missing LLM configuration

Set both `GENIE_LLM_BASE_URL` and `GENIE_LLM_API_KEY`. The base URL must point to the
OpenAI-compatible endpoint your operator exposes. genie has no provider URL fallback.

## Tools do not appear

- Confirm the configured command starts successfully outside the harness.
- Restart the harness after changing its MCP configuration.
- Call `ping` first.
- Check the harness-specific configuration path in [Connect your coding agent](harnesses.md).

## Preview does not appear inline

Inline rendering requires host support for MCP Apps. On local stdio, genie can open a
browser fallback. Set `GENIE_PREVIEW_NO_OPEN=1` to disable that behavior. For HTTP,
configure a client-reachable preview origin with `GENIE_PREVIEWS_BASE_URL` when inline
card assets cannot use the server-local broker.

## My reviewed component was not saved

Review drafts are session-only until Apply completes. Generate, Refine, Approve, Request
Changes, deterministic tweaks, and navigation do not write to disk. Return to the
MCP-capable host, approve the current draft, acknowledge required manual checks, and use
Apply to write it to the selected UI kit.

## Refine or Apply is disabled in Review

Review names each blocker in the panel. Common causes are:

- the current draft is not approved;
- an automated validation check failed or is still pending;
- a manual check has not been acknowledged;
- the selected component is a brand-new generated draft that must be applied before
  Refine can read it from the UI kit;
- the standalone `file://` viewer is read-only and has no MCP tool bridge.

## Apply failed

Keep the Review tab open. The last good draft is retained, and the UI reports the real
failure reason, such as an expired plan, rejected path, write failure, or disconnected
host. Retry only after reading the blocker; genie creates a fresh plan after a fresh Apply
confirmation. A note that kit validation did not run or found issues is advisory, not an
Apply failure — the write already succeeded. If the manifest or preview refresh failed
instead, the write also succeeded; reload the view rather than retrying Apply.

## Report a security issue

Do not open a public issue. Use GitHub's private **Security → Report a vulnerability**
flow for this repository.
