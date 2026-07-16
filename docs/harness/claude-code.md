# genie in Claude Code

Claude Code loads genie's **Agent Skill**, so this is where you get the full
"just ask for a component" experience plus the `/genie:preview` command.

## 1. Register the MCP server (Claude Code only)

### 1A. Local stdio (single-user dev loop)

For Claude Code, register genie in `~/.claude.json` (or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "genie": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"],
      "env": {}
    }
  }
}
```

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` to the server process as
environment (for example through a launcher script), never in committed JSON.

### 1B. HTTP transport + shared/remote server (`headersHelper` pattern)

When genie is already running as a shared HTTP server (not spawned per-session
by Claude Code), register it over `http` and supply credentials through a
per-server `headersHelper` script instead of a literal token in the config
file.

**Do not use top-level `apiKeyHelper` for this.** `apiKeyHelper` and
`headersHelper` are two different settings at two different scopes, and
Claude Code `2.1.203`'s `claude mcp add-json` only serializes `type`/`url`
for an MCP server entry — anything else nested under `mcpServers.<name>`
(like an `apiKeyHelper` placed there by mistake) is silently dropped, not
merely ignored at runtime.

- **`apiKeyHelper`** is a **top-level** Claude Code setting, unrelated to any
  MCP server. It governs Claude Code's own Anthropic/model-API routing
  credential. `apiKeyHelper` is any executable that prints the model-API
  key/token (a bare string, not JSON) to stdout; Claude Code uses it to
  authenticate its own calls to the configured LLM endpoint
  (`ANTHROPIC_BASE_URL` / a custom router). It has no per-`mcpServers` entry
  equivalent and nothing to do with authenticating to the genie MCP server.

- **`headersHelper`** is the mechanism that _does_ attach to a specific
  HTTP/SSE MCP server: a field nested inside that server's own
  `mcpServers.<name>` config, returning a JSON object of headers merged into
  every request Claude Code makes to that server:

```json
{
  "mcpServers": {
    "genie": {
      "type": "http",
      "url": "https://genie.example.internal/mcp",
      "headersHelper": "/absolute/path/to/genie-headers-helper.sh"
    }
  }
}
```

`headersHelper` is any executable that prints a **JSON object of header
key/value strings** to stdout (not a bare token) — Claude Code merges those
headers into every request to that server. Point it at genie's
static-Bearer-token mechanism (M5-02, DRO-274, already shipped — `genie token
create --scope read --scope write`):

```bash
#!/usr/bin/env bash
# genie-headers-helper.sh — never echo the token to a terminal; store it in
# your OS keychain / secret manager and have this script fetch + print it as
# a JSON object, e.g. {"Authorization": "Bearer <token>"}.
set -euo pipefail
token=$(security find-generic-password -a "$USER" -s genie-mcp-token -w)
# or: token=$(op read "op://vault/genie-mcp-token/credential") (1Password CLI), etc.
printf '{"Authorization": "Bearer %s"}\n' "$token"
```

Run the server with `--require-bearer-auth` (or `GENIE_REQUIRE_BEARER_AUTH=1`)
so unauthenticated `/mcp` requests are rejected; `/health` stays open for
liveness checks. Mint the token once with `genie token create`, store only its
hash server-side, and hand the plaintext to the secret manager the helper
script reads from — it is shown exactly once at creation time.

### Combined example: HTTP transport + top-level `apiKeyHelper`

These two settings live at different scopes (see above) but commonly appear
together in the same config file: `apiKeyHelper` for Claude Code's own model
credential, `headersHelper` nested under the `genie` server entry for
authenticating to genie's HTTP transport. One complete, valid config combining
both:

```json
{
  "apiKeyHelper": "/absolute/path/to/anthropic-api-key-helper.sh",
  "mcpServers": {
    "genie": {
      "type": "http",
      "url": "https://genie.example.internal/mcp",
      "headersHelper": "/absolute/path/to/genie-headers-helper.sh"
    }
  }
}
```

`anthropic-api-key-helper.sh` is any executable on `$PATH` (or referenced by
absolute path, as above) that prints Claude Code's own model-API key/token —
a bare string, not JSON — to stdout. A real, ready-to-use implementation
ships in this repo at
[`docs/harness/scripts/anthropic-api-key-helper.sh`](./scripts/anthropic-api-key-helper.sh)
(tracked as executable mode `100755`). Copy it, adjust the credential source
for your environment, and point the top-level `apiKeyHelper` field at your
copy. Claude Code has no `claude config set` shell subcommand; edit
`~/.claude/settings.json` or use `/config` in an interactive session for
settings outside the MCP JSON shown here.

genie now ships OAuth 2.0 + Dynamic Client Registration (M5-01, DRO-273 —
landed): the server exposes `/.well-known/oauth-authorization-server` (RFC
8414 metadata), `POST /register` (RFC 7591 DCR), `GET`/`POST /authorize`
(browser consent screen), and `POST /token`. With OAuth enabled server-side
(set `OAUTH_HS256_KEY` — see the tech-design RFC), you can register genie
without a `headersHelper` at all:

```bash
claude mcp add --transport http genie https://genie.example.internal/mcp
```

Claude Code discovers the metadata document, performs Dynamic Client
Registration against `/register`, opens a browser to `/authorize` for
consent, and exchanges the resulting code at `/token` — all automatically.
The static-Bearer-token + `headersHelper` pattern above remains supported for
deployments that haven't enabled OAuth (`OAUTH_HS256_KEY` unset), or that
prefer a pre-provisioned token over an interactive consent flow.

### Gotcha: `/login` (Claude Code OAuth) can silently bypass configured LLM routing

If you separately run `/login` inside Claude Code to authenticate against
Anthropic's own OAuth (a _different_ credential from the genie MCP server's
`headersHelper`), Claude Code can start routing model calls through that
OAuth session instead of your configured LLM endpoint (`ANTHROPIC_BASE_URL` /
custom router / top-level `apiKeyHelper`) — none of that governs the genie
MCP connection's own `Authorization` header, which stays on `headersHelper`
regardless. If genie tool calls stop reflecting your expected model/endpoint
after using `/login`, run `/logout` to drop the OAuth session and restore
your configured LLM routing. This is a Claude Code CLI-wide behavior, not
specific to genie.

Claude Desktop uses `claude_desktop_config.json` (or, once M5 packaging lands,
the `.mcpb` installer), not these Claude Code files. claude.ai cannot launch a
local stdio command and requires a deployed remote connector. Their dedicated
M5 harness issues own those configuration and smoke-test instructions.

## 2A. Install the guidance plugin (recommended)

The `genie` plugin bundles the Agent Skill and `/genie:preview` command for an
already registered server. Once installed, the Skill loads automatically and
the namespaced command is available.

The plugin is `packages/plugin/` in this repo (`.claude-plugin/plugin.json`).
Install it from the marketplace once listed, or point Claude Code at a local
checkout during development.

## 2B. Manual copy

If you're not using the marketplace:

1. **Create the local extension directories:**

   ```
   mkdir -p ~/.claude/skills ~/.claude/commands
   ```

2. **Copy the Skill** into your skills dir:

   ```
   cp -r packages/plugin/skills/genie ~/.claude/skills/genie
   ```

3. **Copy the command**, choosing its non-plugin command name:

   ```
   cp packages/plugin/commands/preview.md ~/.claude/commands/genie-preview.md
   ```

Reload Claude Code (or `/reload-skills`). Ask "build me a button and show me,"
or run `/genie-preview` directly. The marketplace plugin namespaces the same
source file as `/genie:preview`.

## What you get here

- **Agent Skill** — turns plain requests into the
  `conjure → plan → write_files → preview` workflow.
- **`/genie:preview [kitId]`** — force-open the viewer without model inference.
- **Inline grid** — Claude renders the `ui://genie/grid` card grid in-panel;
  no browser tab needed (so `GENIE_PREVIEW_NO_OPEN` is irrelevant here).

The automated Claude Code Docker smoke captures the generated fallback viewer
at [`screenshots/claude-code/m5-09-docker-smoke.png`](./screenshots/claude-code/m5-09-docker-smoke.png).

Implementation note for permissions and transcript tooling: Claude Code adds
the configured server-name prefix to the protocol tool name. Because genie's
wire names are already `mcp__genie__<verb>`, a server configured as `genie`
appears inside Claude Code as `mcp__genie__mcp__genie__<verb>`.
