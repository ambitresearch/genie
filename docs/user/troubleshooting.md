# Troubleshooting

## The server exits before connecting

Run `genie --help` and check required secrets. `GENIE_LLM_API_KEY` must contain at least
16 characters and `OAUTH_HS256_KEY` at least 32. Keep diagnostic output on stderr;
stdout is the stdio protocol stream.

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

## Report a security issue

Do not open a public issue. Use GitHub's private **Security → Report a vulnerability**
flow for this repository.
