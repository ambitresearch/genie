<div align="center">

# genie

**AI UI-component generation, inside your coding agent, against your own UI kit.**

[![CI](https://github.com/ambitresearch/genie/actions/workflows/ci.yml/badge.svg)](https://github.com/ambitresearch/genie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19.0-brightgreen.svg)](.nvmrc)

</div>

> **Status: public preview.** The 20-tool MCP workflow, model-backed component
> generation, plan-gated writes, validation, live preview, auth, and distribution
> pipelines are implemented. The first `@ambitresearch` public package release is pending.

[User Guide](https://ambitresearch.github.io/genie/user/) ·
[Developer Guide](https://ambitresearch.github.io/genie/developer/) ·
[Releases](https://github.com/ambitresearch/genie/releases)

---

genie is a **harness-agnostic [Model Context Protocol](https://modelcontextprotocol.io)
server** that brings AI UI-component generation into whatever AI coding harness you
already use — Claude Code, Cursor, VS Code, Codex, Cline, Continue — against your
**own** component library (your "UI kit"), with a live preview. No separate app to
open, no per-seat hosted canvas, no vendor lock-in.

Inspired by Anthropic's Claude Design; an independent, open-source take on the same
idea, built on public protocol surfaces. **Not** affiliated with Anthropic. MIT,
self-hostable, model-agnostic via any OpenAI-compatible endpoint; LiteLLM works as
the reference gateway.

It's a solo, AI-assisted experiment to find out whether MCP Apps — rich UI rendered
_inside_ a coding harness — are genuinely useful.

## Quickstart

> Requires Node ≥ 22.19.0 and [pnpm](https://pnpm.io) (`corepack enable`).

```bash
git clone https://github.com/ambitresearch/genie.git
cd genie
pnpm install
export GENIE_LLM_BASE_URL="https://your-gateway.example/v1"
export GENIE_LLM_API_KEY="replace-with-your-gateway-key"
pnpm dev            # boots the MCP server on stdio
```

Confirm it speaks MCP:

```bash
pnpm build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"you","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}' \
  | node packages/server/dist/cli.js --transport stdio
# → "pong — genie 1.2.0"
```

`mcp__genie__list_files` reads UI kit roots from `GENIE_KITS_ROOT` or
`.genie/kits` under the current working directory. It returns
`{ path, size, hash, lastModified }[]` with forward-slash relative paths and
SHA-256 SRI hashes, includes dot-prefixed files, and excludes `node_modules`,
`.git`, `dist`, plus patterns in `.genieignore`.

### LLM endpoint

Generation verbs (`conjure` / `refine`, M2) call a configurable
OpenAI-compatible chat-completions endpoint through `packages/server/src/llm/client.ts`.
LiteLLM is the reference gateway, but Ollama / OpenAI / vLLM / any compatible
endpoint work the same way — genie hardcodes no provider URL or key.

| Env var                        | Required | Default  | Purpose                                                                                          |
| ------------------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GENIE_LLM_BASE_URL`           | yes      | none     | Base URL of the OpenAI-compatible endpoint, e.g. `https://litellm.example.com/v1`                |
| `GENIE_LLM_API_KEY`            | yes      | none     | API key/token for that endpoint                                                                  |
| `GENIE_LLM_REQUEST_TIMEOUT_MS` | no       | `120000` | Per-request timeout, in milliseconds                                                             |
| `GENIE_LLM_RETRY_MAX`          | no       | `3`      | Max retries on transient LLM failures (429 / 5xx / ECONNRESET / ETIMEDOUT); `0` disables retries |

Missing `GENIE_LLM_BASE_URL` or `GENIE_LLM_API_KEY` fails fast with
`MissingLLMConfigError` naming both variables — there is no default endpoint
to fall back to.

Transient LLM failures — HTTP 429, 5xx, and network errors — are retried with
exponential backoff (base 1 s, cap 30 s, ±20 % jitter) by the `withRetry`
middleware in `packages/server/src/llm/retry.ts`, honouring `Retry-After` when
the upstream sends it. After the budget is exhausted, callers see a typed
`RateLimitedError` (429 tail) or `TransientError` (5xx / network tail) whose
`.cause` preserves the original SDK error. Each retry is logged as
`{ event: "llm.retry", attempt, status, retryAfter }` on stderr (never
stdout — the stdio transport IS the protocol stream).

### Transports

| Flag                           | Use                                                                  |
| ------------------------------ | -------------------------------------------------------------------- |
| `--transport stdio`            | Local harness (Claude Desktop, Claude Code) — the default when piped |
| `--transport http --port 3000` | Remote / multi-client; `POST /mcp`, `GET /health`                    |
| `--preview-locality local`     | Explicit override: return server-local viewer URLs                   |

Auto-detects: a TTY on stdin → HTTP, piped JSON-RPC → stdio. Override with
`--transport` or `MCP_TRANSPORT`. Preview locality defaults to `local` for
stdio and `remote` for HTTP; override it with `--preview-locality` or
`GENIE_PREVIEW_LOCALITY` only when the MCP client can reach server-local URLs.

### Docker

A multi-arch (amd64/arm64) image is published to Docker Hub and GitHub
Container Registry on every release, built from the repo-root `Dockerfile`
(`node:22-alpine`, multi-stage, non-root UID 1000, < 200 MB runtime image).

```bash
test "${#GENIE_LLM_API_KEY}" -ge 16 || {
  echo "Export a real GENIE_LLM_API_KEY (at least 16 characters) first." >&2
  exit 1
}
docker run -d --name genie -p 8080:8080 \
  -e GENIE_LLM_BASE_URL=https://your-llm-gateway/v1 \
  -e GENIE_LLM_API_KEY \
  -e OAUTH_HS256_KEY="$(openssl rand -hex 32)" \
  -e GENIE_OAUTH_ISSUER=http://localhost:8080 \
  ghcr.io/ambitresearch/genie:latest
health_status=
for _ in $(seq 1 70); do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' genie)"
  [ "$health_status" = healthy ] && break
  [ "$health_status" = unhealthy ] && break
  sleep 1
done
[ "$health_status" = healthy ] || { docker logs genie; exit 1; }
curl --fail http://localhost:8080/health
```

The equivalent Docker Hub image is `docker.io/ambitresearch/genie:latest`.

See [`deploy/docker-compose.yml`](./deploy/docker-compose.yml) for a
self-hoster reference compose file (kit-root volume + env examples included,
commented out by default). Published images are signed with keyless
[cosign](https://docs.sigstore.dev/cosign/); verify with:

```bash
cosign verify ghcr.io/ambitresearch/genie:latest \
  --certificate-identity='https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

### Claude Desktop (`.mcpb` bundle)

Claude Desktop users on macOS can install genie without hand-editing a config file:

1. Download `genie.mcpb` from the [latest release](../../releases/latest)
   (attached to every GitHub Release — see `mcpb/manifest.json` and
   `pnpm bundle:mcpb`).
2. Double-click it. Claude Desktop opens its extension installer and prompts
   for the required config values (`llm_base_url` and an `llm_api_key` of at
   least 16 characters) on first run — nothing is hardcoded into the bundle.
3. genie now shows up as an installed extension; no manual
   `claude_desktop_config.json` editing needed.

To build the bundle locally: `pnpm bundle:mcpb` (builds `@ambitresearch/genie`,
stages a production-only deploy, and packs `dist/genie.mcpb` via
`@anthropic-ai/mcpb`). See `mcpb/manifest.json` for the bundle manifest and
`scripts/bundle-mcpb.mjs` for the packaging steps. See the
[Claude Desktop guide](https://ambitresearch.github.io/genie/harness/claude-desktop/) for manual JSON
configuration, remote connectors, debugging, and smoke-test evidence.

## Repository layout

```
packages/
  server/     @ambitresearch/genie — the MCP server (this is the product)
  viewer/     @ambitresearch/genie-viewer — Vite preview viewer and embedded grid assets
  e2e/        @ambitresearch/genie-e2e — protocol, harness, browser, auth, and release tests
docs/
  user/       installation, harness, workflow, and troubleshooting guides
  developer/  architecture, contribution, security, release, and design guides
  harness/    tested per-harness registration references
AGENTS.md     the SDLC contract every contributor (human or AI) follows
```

## Contributing

genie is built largely by AI coding agents under maintainer review. See
[CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md). Issues and PRs
welcome; it's run best-effort by one maintainer.

## License

[MIT](./LICENSE) © 2026 Roshan Gautam. See [NOTICE.md](./NOTICE.md) for the
relationship to Claude Design and third-party attributions.
