# genie in Claude Desktop

Claude Desktop is a separate app from Claude Code — it uses its own config
file and, unlike Claude Code, has no notion of a project-local `.mcp.json`.
Everything below is specific to Claude Desktop; see
[claude-code.md](./claude-code.md) for the Claude Code / claude.ai variants.

**Platform support:** Claude Desktop is available on macOS, Windows, and as a
**Linux beta**. Anthropic currently supports Ubuntu 22.04 LTS+ and Debian 12+
on x64 or arm64. See the current
[install guide](https://support.claude.com/en/articles/10065433-installing-claude-desktop)
for platform requirements and Linux limitations.

## Recommended: install the `.mcpb` bundle

The recommended way to register genie in Claude Desktop is the packaged
`.mcpb` (MCP Bundle) installer: double-click the bundle, Claude Desktop
installs and registers the server for you, and you never hand-edit JSON.

> **Current status:** the verified M5-05 bundle landed in
> [PR #203](https://github.com/roshangautam/genie/pull/203). Prefer the `.mcpb`
> on macOS once it is attached to a GitHub Release. The M5-05 v1 bundle is
> macOS-only; Windows and Linux users must use the manual JSON configuration
> below until their platforms are supported. On macOS, JSON remains the "if
> you prefer" path.

## If you prefer: manual JSON snippet

Claude Desktop reads its MCP server list from a JSON config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json` by default, or
  `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` when `XDG_CONFIG_HOME`
  is set

Add genie under `mcpServers`:

> **Publication gate:** `@genie/server` is the planned package name but is not
> yet published. The snippet below is the post-M5-06 configuration. Use the
> source-checkout form described immediately after it today.

```json
{
  "mcpServers": {
    "genie": {
      "command": "npx",
      "args": ["-y", "@genie/server", "--transport", "stdio"],
      "env": {
        "GENIE_HOME": "/absolute/path/to/.genie",
        "GENIE_KITS_ROOT": "/absolute/path/to/.genie/kits",
        "GENIE_PROJECTS_ROOT": "/absolute/path/to/.genie/projects",
        "GENIE_LLM_BASE_URL": "https://your-llm-endpoint.example.com/v1",
        "GENIE_LLM_API_KEY": "replace-with-your-llm-api-key",
        "OAUTH_HS256_KEY": "replace-with-at-least-32-random-characters"
      }
    }
  }
}
```

Replace all three `/absolute/path/to/.genie` persistence paths with writable,
absolute paths for your account. Do not omit them: a GUI-launched process can
inherit an unexpected or unwritable working directory. Examples:

- **macOS:** `/Users/you/.genie`, `/Users/you/.genie/kits`, and
  `/Users/you/.genie/projects`
- **Windows JSON values:** `C:\\Users\\you\\.genie`,
  `C:\\Users\\you\\.genie\\kits`, and
  `C:\\Users\\you\\.genie\\projects`
- **Linux:** `/home/you/.genie`, `/home/you/.genie/kits`, and
  `/home/you/.genie/projects`

The original M5-10 draft named the bare `genie` npm package, but that name is
owned by an unrelated package. The current M5-06 publishing contract uses
`@genie/server`. It is not yet published, so the `npx` command above is a
post-M5-06 configuration and currently returns an npm 404. Do not substitute
`npx -y genie`. For a source checkout today, build `@genie/server` and replace
the snippet's command with `node` and its args with
`["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]`.

The current CLI calls `loadSecrets()` before it creates the stdio transport.
`GENIE_LLM_API_KEY` and `OAUTH_HS256_KEY` are required before the server starts,
including for `list_kits`. `GENIE_LLM_API_KEY` must contain at least 16
characters. `OAUTH_HS256_KEY` must contain at least 32 characters to enable
OAuth. `GENIE_LLM_BASE_URL` is also required when invoking generation tools
such as `conjure`. Replace every placeholder before use; for example, generate
a signing key with `openssl rand -hex 32`.

Manual local-server configuration has no separate secret prompt. Treat
`claude_desktop_config.json` as sensitive, keep it owner-readable only
(`chmod 600` on macOS), and never commit it.

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
`mcpServers` — for genie's stderr output). Tail these when the server
doesn't appear as connected in Claude Desktop's UI, or when a tool call
fails silently:

```bash
tail -f ~/Library/Logs/Claude/mcp*.log
```

On Windows, the equivalent logs live under
`%APPDATA%\Claude\logs\mcp*.log`.

## Reaching a remote (hosted) genie server

Claude now supports remote MCP servers natively through custom connectors. In
Claude Desktop, open **Customize -> Connectors**, select **+**, choose **Add
custom connector**, and enter the public genie Streamable HTTP URL. Team and
Enterprise organizations require an Owner to add the connector first. See
Anthropic's current
[custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Native remote connections originate from Anthropic's cloud, not from the
Desktop process. The endpoint must therefore be publicly reachable from
Anthropic's network; a host available only on localhost, a private LAN, or a
VPN will not work through this path.

### `mcp-remote` fallback for local-network reachability

Use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a fallback when
custom connectors are unavailable for the account or the endpoint must be
reached from the user's machine. Claude Desktop launches the bridge as a local
stdio process, which then proxies to the remote server over Streamable HTTP:

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
window for the authorization step the first time it connects). This bridge is
not required for a publicly reachable server configured through Claude's
native custom-connector flow.

## AC6 smoke-test status

The real Claude Desktop leg was completed on macOS with Claude Desktop
1.22209.0. The exact M5-05 artifact was installed into the separate
`Claude-3p` profile, where no genie extension previously existed. Claude
persisted `local.mcpb.roshan-gautam.genie` v1.2.0 with the artifact's exact
SHA-256, saved all required configuration fields, and enabled the extension.
A new chat discovered genie, invoked `list_kits`, and returned an empty kit
list successfully. Sensitive configuration remained encrypted. The cropped,
non-secret AC6 evidence is at
[`screenshots/claude-desktop/m5-10-list-kits.png`](./screenshots/claude-desktop/m5-10-list-kits.png);
it shows the genie connection badge, request, and
`{"kits":[]}` result without configuration values or unrelated chat content.

Use this protocol to reproduce the verification on another profile or release:

1. Download `genie.mcpb` from the relevant GitHub Release. Record its release
   tag and checksum with the test evidence.
2. Quit Claude Desktop if it's running. Double-click `genie.mcpb` — Claude
   Desktop should launch (if not already open) and show an install prompt
   for the "genie" MCP server. Confirm the install.
3. Supply every required configuration value prompted by the bundle. Do not
   expose those values in the screenshot.
4. Open a new chat in Claude Desktop. Confirm "genie" appears as a connected
   MCP server in the tools menu or Developer settings.
5. Ask Claude to call `list_kits` (e.g. "list my genie UI kits"). Confirm it
   returns without error (empty list is fine on a fresh install).
6. Capture a screenshot showing: the connected "genie" server in Claude
   Desktop UI and the `list_kits` tool call plus result. Keep configuration,
   API keys, file paths containing private data, and unrelated chats out of
   frame.
7. Attach the screenshot and a one-line pass/fail note to M5-10 as the AC6
   evidence artifact. The screenshot must not expose configuration values.

`packages/e2e/test/m5-smoke-claude-desktop.test.ts` supplements that manual
evidence by verifying the bootstrap contract and exercising `list_kits` plus
the component workflow over the same real stdio transport.

## What you get here

- **MCP tools** — Claude can invoke genie's registered tools after the local
  server or remote connector is configured.
- **Agent Skill not bundled** — the current M5-05 bundle contract does not
  currently include the Agent Skill under `packages/plugin/skills/genie`.
  Claude Code's separate installation is documented in
  [claude-code.md](./claude-code.md).
- **Inline grid contract** — `preview` returns the `ui://genie/grid` MCP App
  resource. Rendering it inside Claude Desktop still needs empirical harness
  verification; this PR's stdio test does not prove the Desktop UI behavior.
- **No project-local config** — unlike Claude Code's `.mcp.json`, Claude
  Desktop only reads the single user-level `claude_desktop_config.json`
  above; there is no per-project override.
