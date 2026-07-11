# genie in VS Code Copilot / GitHub Copilot

GitHub Copilot supports Agent Skills in its cloud agent, code review, CLI, app,
and agent mode in VS Code and JetBrains. Its preview behavior still depends on
the specific host:

- **Agent Skill** carries the `conjure → plan → write_files → preview` workflow;
  tool descriptions remain fallback guidance.
- **VS Code Copilot agent** on an MCP Apps-capable build advertises the
  `io.modelcontextprotocol/ui` extension during initialization. genie detects
  that negotiated capability and renders `ui://genie/grid` inline without
  opening a redundant browser tab.
- **Local stdio Copilot surfaces** that do not advertise MCP Apps receive the
  live viewer in a server-opened browser tab. Disable that fallback with
  `GENIE_PREVIEW_NO_OPEN=1`. HTTP Copilot surfaces never auto-open a browser;
  remote HTTP requires the inline MCP App plus `GENIE_PREVIEWS_BASE_URL`.

## Install the Agent Skill

Copilot supports project and personal locations documented in
[Adding agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).
For a personal Skill shared across Copilot projects:

```bash
mkdir -p ~/.copilot/skills
cp -R packages/plugin/skills/genie ~/.copilot/skills/genie
```

For a project Skill, copy the same directory to `.github/skills/genie` (Copilot
also recognizes `.agents/skills/genie`). Reload skills or restart the host after
copying.

## Register the server

Add genie to `.vscode/mcp.json` for the VS Code Copilot agent (note the
top-level key is `servers`, not Cursor's `mcpServers`):

```json
{
  "servers": {
    "genie": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]
    }
  }
}
```

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` to the server process as
environment — **never hardcode secrets** in the config. The base URL must end
in `/v1`.

## Using it

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. On an MCP Apps-capable VS Code build, `preview` renders the
grid inline. On a tools-only local stdio Copilot host, it opens a browser tab at
the live grid. HTTP surfaces never auto-open; a genuinely same-machine HTTP
client can request a local viewer URL with `--preview-locality local`, while a
remote HTTP host needs MCP Apps plus `GENIE_PREVIEWS_BASE_URL`. If a local
viewer cannot boot, use the returned `file://` fallback on that server machine.

The broader M5 VS Code distribution issue still owns the production HTTP
snippet, sandbox-domain settings, one-click/CLI installation paths, and an
Insiders smoke test.
