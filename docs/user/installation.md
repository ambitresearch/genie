# Installation and configuration

## Prerequisites

- Node.js 22 or newer for the npm/source path, or Docker.
- An OpenAI-compatible model endpoint for `conjure` and `refine`.
- A writable location for genie's state and UI kits.

## npm

After the first public package release:

```bash
npx -y @ambitresearch/genie --transport stdio
```

For a source checkout:

```bash
git clone https://github.com/ambitresearch/genie.git
cd genie
corepack enable
pnpm install
pnpm build
node packages/server/dist/cli.js --transport stdio
```

## Docker

Published images run the HTTP transport on port `8080`:

```bash
docker run --rm -p 8080:8080 \
  -e GENIE_LLM_BASE_URL=https://your-gateway.example/v1 \
  -e GENIE_LLM_API_KEY="$GENIE_LLM_API_KEY" \
  -e OAUTH_HS256_KEY="$(openssl rand -hex 32)" \
  -e GENIE_OAUTH_ISSUER=http://localhost:8080 \
  ghcr.io/ambitresearch/genie:latest
```

Check the server:

```bash
curl --fail http://localhost:8080/health
```

## Required secrets

The CLI validates known required secrets before it starts:

| Variable            | Requirement            | Purpose                                         |
| ------------------- | ---------------------- | ----------------------------------------------- |
| `GENIE_LLM_API_KEY` | At least 16 characters | Authenticates to the configured model endpoint. |
| `OAUTH_HS256_KEY`   | At least 32 characters | Signs tokens issued by genie's OAuth server.    |

`GENIE_LLM_BASE_URL` is required when calling `conjure` or `refine`; it must identify an
OpenAI-compatible `/v1` endpoint. Store secrets in environment variables or an owner-only
file passed with `--secrets-from`. Never commit them.

## Storage locations

| Variable              | Default                                        |
| --------------------- | ---------------------------------------------- |
| `GENIE_HOME`          | `.genie` below the working directory.          |
| `GENIE_KITS_ROOT`     | `.genie/kits` below the working directory.     |
| `GENIE_PROJECTS_ROOT` | `.genie/projects` below the working directory. |
| `GENIE_REPORTS_DIR`   | `.genie/reports` below the working directory.  |

## Verify stdio

From a built source checkout:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"you","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}' \
  | node packages/server/dist/cli.js --transport stdio
```

The `ping` result contains `pong`, the server name, and its package version.
