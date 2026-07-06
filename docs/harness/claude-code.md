# genie in Claude Code / Claude Desktop / claude.ai

Claude harnesses are the only ones that load genie's **Agent Skill** — so this
is where you get the full "just ask for a component" experience plus the
`/genie:preview` command.

## Option A — marketplace plugin (recommended)

The `genie` plugin bundles the MCP server registration, the Agent Skill, and the
`/genie:preview` command in one install. Once installed, the Skill loads
automatically and `/genie:preview` is available.

The plugin is `packages/plugin/` in this repo (`.claude-plugin/plugin.json`).
Install it from the marketplace once listed, or point Claude Code at a local
checkout during development.

## Option B — manual copy

If you're not using the marketplace:

1. **Register the MCP server** in `~/.claude.json` (or a project `.mcp.json`):

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
   environment (e.g. via your shell profile or a launcher script) — **do not**
   put secrets in the JSON. The base URL must end in `/v1`.

2. **Copy the Skill** into your skills dir:

   ```
   cp -r packages/plugin/skills/genie ~/.claude/skills/genie
   ```

3. **Copy the command**:

   ```
   cp packages/plugin/commands/genie-preview.md ~/.claude/commands/genie-preview.md
   ```

Reload Claude Code (or `/reload-skills`). Ask "build me a button and show me,"
or run `/genie:preview` directly.

## What you get here

- **Agent Skill** — turns plain requests into the
  `conjure → plan → write_files → preview` workflow.
- **`/genie:preview [kitId]`** — force-open the viewer without model inference.
- **Inline grid** — Claude renders the `ui://genie/grid` card grid in-panel;
  no browser tab needed (so `GENIE_PREVIEW_NO_OPEN` is irrelevant here).
