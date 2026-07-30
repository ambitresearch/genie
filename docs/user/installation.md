# Installation and configuration

## Prerequisites

- Node.js 22.19.0–22.x, or 24.4.1 or newer for the npm/source path, or Docker.
  Node 23 and 24.0–24.4.0 are excluded: CVE-2025-27210 was fixed in 22.17.1 and
  24.4.1, and the 23.x line reached end-of-life before a patched release existed.
- An OpenAI-compatible model endpoint for `conjure` and `refine`.
- A writable location for genie's state and UI kits.

## Required secrets

Set the model endpoint and key before the first run:

```bash
export GENIE_LLM_BASE_URL="https://your-gateway.example/v1"
export GENIE_LLM_API_KEY="replace-with-your-gateway-key"
```

| Variable            | Requirement            | Purpose                                         |
| ------------------- | ---------------------- | ----------------------------------------------- |
| `GENIE_LLM_API_KEY` | At least 16 characters | Authenticates to the configured model endpoint. |
| `OAUTH_HS256_KEY`   | Optional; 32+ if set   | Enables token signing for the HTTP OAuth flow.  |

`OAUTH_HS256_KEY` is not used by stdio. For HTTP OAuth, generate one with
`openssl rand -hex 32`. Store secrets in environment variables or an owner-only file
passed with `--secrets-from`; never commit them.

## npm

```bash
npx -y @ambitresearch/genie --transport stdio
```

### Optional: the live preview viewer

`@ambitresearch/genie-viewer` ships as a separate package and is declared as an
**optional peer** — genie can drive it, but will not install it for you, so a
plain install never pulls Vite in.

Whether you need it depends on how your harness delivers a preview:

| Harness                                               | `preview` delivery                    | Needs the viewer |
| ----------------------------------------------------- | ------------------------------------- | ---------------- |
| Claude Code / Claude Desktop, Cursor, VS Code Copilot | inline `ui://genie/grid`, in-panel    | No               |
| Codex Desktop, Codex CLI                              | inline manifest **plus** a viewer URL | Yes              |
| Cline, Continue, other tools-only clients             | viewer URL, else `file://`            | Yes              |

Hosts that render MCP Apps get the grid inline from the server package itself.
Everything else falls back to the local Vite viewer, so install it alongside
genie:

```bash
npm i -g @ambitresearch/genie @ambitresearch/genie-viewer
```

Without it, `preview` still works but degrades to a static
`file://<kitDir>/index.html` and says so in its result.

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

`GENIE_LLM_BASE_URL` is required when calling `conjure` or `refine`; it must identify an
OpenAI-compatible `/v1` endpoint.

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
