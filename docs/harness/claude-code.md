# genie in Claude Code

Claude Code loads genie's **Agent Skill**, so this is where you get the full
"just ask for a component" experience plus the `/genie:preview` command.

## 1. Register the MCP server (Claude Code only)

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
