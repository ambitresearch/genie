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

**Do not use top-level `apiKeyHelper` for this.** `apiKeyHelper` (Claude Code
`2.1.203`+) governs Claude Code's own Anthropic/model API routing key, not any
individual MCP server's auth — it has no per-`mcpServers` entry equivalent.
The mechanism that *does* attach to a specific HTTP/SSE MCP server is
`headersHelper`, a per-server field that returns a JSON object of headers
merged into every request Claude Code makes to that server:

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

Once genie ships OAuth 2.0 + Dynamic Client Registration (M5-01, DRO-273 —
not yet landed), `claude mcp add --transport http genie <url>` will trigger
DCR and a browser consent flow automatically, without a `headersHelper` at
all. Until then, the static-Bearer-token + `headersHelper` pattern above is
the supported path for any HTTP deployment, including the shared/remote case
this section targets.

### Gotcha: `/login` (Claude Code OAuth) can silently bypass configured LLM routing

If you separately run `/login` inside Claude Code to authenticate against
Anthropic's own OAuth (a *different* credential from the genie MCP server's
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
