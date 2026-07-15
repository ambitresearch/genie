# genie in Claude Desktop

Claude Desktop is a separate app from Claude Code — it uses its own config
file and, unlike Claude Code, has no notion of a project-local `.mcp.json`.
Everything below is specific to Claude Desktop; see
[claude-code.md](./claude-code.md) for the Claude Code / claude.ai variants.

**Platform support:** Claude Desktop ships for **macOS and Windows only**.
**Linux is not officially supported** by Anthropic's Claude Desktop app —
if you're on Linux, use [Claude Code](./claude-code.md) or a browser-based
harness instead.

## Recommended: install the `.mcpb` bundle

The recommended way to register genie in Claude Desktop is the packaged
`.mcpb` (MCP Bundle) installer: double-click the bundle, Claude Desktop
installs and registers the server for you, and you never hand-edit JSON.

> **Status:** the genie `.mcpb` bundle is built by
> [M5-05](../github/issues) (`.mcpb` bundle packaging for Claude Desktop) and
> published alongside Smithery/mcpb.dev listings by M5-08. If you land on
> this page before that ships, use the manual JSON snippet below — it is
> functionally identical, just requires you to edit the config file
> yourself. Once the `.mcpb` is published, prefer it: the JSON snippet is
> "if you prefer" to install manually.

## If you prefer: manual JSON snippet (stdio via `npx -y genie`)

Claude Desktop reads its MCP server list from a JSON config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add genie under `mcpServers`:

```json
{
  "mcpServers": {
    "genie": {
      "command": "npx",
      "args": ["-y", "genie", "--transport", "stdio"],
      "env": {
        "GENIE_LLM_BASE_URL": "https://your-llm-endpoint.example.com/v1",
        "GENIE_LLM_API_KEY": "your-api-key"
      }
    }
  }
}
```

`npx -y genie` fetches and runs the published `genie` CLI without a local
checkout — the same package `.mcpb` packages up for you. If you're running
against a local build instead of the published package, swap `command`/`args`
for the Claude Code snippet's `node .../cli.js --transport stdio` form.

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` directly in this file's
`env` block if you want conjure/generation available — Claude Desktop has no
separate secrets store, so treat this file itself as sensitive (`chmod 600`
on macOS/Linux permissions models; avoid committing it to source control).
`plan` / `write_files` / `preview` and the read tools work without an LLM
configured.

Restart Claude Desktop after editing the config file for the new server to
be picked up.

## Debugging: MCP logs

Claude Desktop writes one log file per configured MCP server plus a main MCP
log, all under:

```
~/Library/Logs/Claude/mcp*.log
```

(`mcp.log` for Claude Desktop's own MCP client activity, and
`mcp-server-genie.log` — or similar, named after the server key you chose in
`mcpServers` — for genie's own stdout/stderr). Tail these when the server
doesn't appear as connected in Claude Desktop's UI, or when a tool call
fails silently:

```bash
tail -f ~/Library/Logs/Claude/mcp*.log
```

On Windows, the equivalent logs live under
`%APPDATA%\Claude\logs\mcp*.log`.

## Reaching a remote (hosted) genie server: the `mcp-remote` bridge

Claude Desktop's `mcpServers` entries only launch local stdio commands — there
is no native `url`/remote-HTTP entry the way some other harnesses support. To
point Claude Desktop at a **remote, hosted** genie MCP endpoint instead of a
local process, bridge through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote),
which Claude Desktop launches as its local stdio command and which then
proxies to your remote server over Streamable HTTP:

```json
{
  "mcpServers": {
    "genie": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-genie-endpoint.example.com/mcp"]
    }
  }
}
```

`mcp-remote` handles the local stdio <-> remote Streamable HTTP translation
and any OAuth flow your genie deployment requires (it will open a browser
window for the authorization step the first time it connects). Use this
pattern when you don't want to run genie locally at all — e.g. a team-shared
genie deployment — rather than the local `npx -y genie` snippet above.

## Manual smoke test (AC6)

Claude Desktop is a native GUI app with no scriptable automation surface, so
the `.mcpb`-install → `list_kits` → screenshot leg of AC6 cannot be automated
in CI — it requires a human tester on a real macOS machine with Claude
Desktop installed. This is the exact protocol to run once
[M5-05](../github/issues) (`.mcpb` bundle packaging) ships a `genie.mcpb`
artifact:

1. Download the `genie.mcpb` artifact from the relevant GitHub Release (or
   build it locally via `pnpm bundle:mcpb` once M5-05 lands).
2. Quit Claude Desktop if it's running. Double-click `genie.mcpb` — Claude
   Desktop should launch (if not already open) and show an install prompt
   for the "genie" MCP server. Confirm the install.
3. If prompted for `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY`, either supply
   real values or skip — `list_kits` and the other read tools work without
   an LLM configured.
4. Open a new chat in Claude Desktop. Confirm "genie" appears as a connected
   MCP server (Settings → Developer, or the 🔌/tools icon in the composer).
5. Ask Claude to call `list_kits` (e.g. "list my genie UI kits"). Confirm it
   returns without error (empty list is fine on a fresh install).
6. Capture a screenshot showing: the connected "genie" server in Claude
   Desktop's UI, and the `list_kits` tool call + result in the chat.
7. Attach the screenshot and a one-line pass/fail note to this issue (or the
   tracking follow-up issue below) as the AC6 evidence artifact.

This protocol is the concrete, runnable replacement for AC6's automated
claim — `packages/e2e/test/m5-smoke-claude-desktop.test.ts` covers everything
verifiable from genie's side (the real stdio four-verb chain, incl.
`list_kits`); this section is what closes the gap once a human has Claude
Desktop + the `.mcpb` artifact in hand.

## What you get here

- **Agent Skill** — Claude Desktop loads the same portable Skill Claude Code
  does; see [claude-code.md](./claude-code.md) for the install paths (`.mcpb`
  bundles it automatically once M5-05 ships).
- **Inline grid** — Claude Desktop renders the `ui://genie/grid` card grid
  in-panel, the same as Claude Code; no browser tab needed.
- **No project-local config** — unlike Claude Code's `.mcp.json`, Claude
  Desktop only reads the single user-level `claude_desktop_config.json`
  above; there is no per-project override.
