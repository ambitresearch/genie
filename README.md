<div align="center">

# genie

**AI UI-component generation, inside your coding agent, against your own UI kit.**

[![CI](https://github.com/roshangautam/genie/actions/workflows/ci.yml/badge.svg)](https://github.com/roshangautam/genie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](.nvmrc)

</div>

> **Status: scaffold (M1 in progress).** The server boots and speaks MCP, with a built-in
> `ping` tool plus early M1 tools including `mcp__genie__list_files`. The remaining surfaces — generation, validator,
> preview viewer — land in M1–M4. See [`docs/plan/`](./docs/plan) for the roadmap.

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

It's a solo, AI-assisted experiment to find out whether MCP-Apps — rich UI rendered
_inside_ a coding harness — are genuinely useful. See [`docs/plan/02-brd.md`](./docs/plan/02-brd.md).

## Quickstart

> Requires Node ≥ 22 (current Active LTS) and [pnpm](https://pnpm.io) (`corepack enable`).

```bash
git clone https://github.com/roshangautam/genie.git
cd genie
pnpm install
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
# → "pong — genie 0.0.0"
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

## Repository layout

```
packages/
  server/     @genie/server — the MCP server (this is the product)
  viewer/     @genie/viewer — Vite preview viewer (M4 in progress; CLI + multi-page config + grid renderer, booted on demand by the `preview` tool)
  e2e/        @genie/e2e — harness smoke tests (M5, placeholder)
docs/
  plan/       vision, BRD, PRD, tech-design RFC, launch plan, ops runbook
  designs/    locked design system + SVG surface mockups
  github/     M0–M6 issue backlog (agent-delegation-ready)
  research/   Skybridge framework evaluation
AGENTS.md     the SDLC contract every contributor (human or AI) follows
```

## Contributing

genie is built largely by AI coding agents under maintainer review. See
[CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md). Issues and PRs
welcome; it's run best-effort by one maintainer.

## License

[MIT](./LICENSE) © 2026 Roshan Gautam. See [NOTICE.md](./NOTICE.md) for the
relationship to Claude Design and third-party attributions.
