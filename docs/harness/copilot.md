# genie in VS Code Copilot / GitHub Copilot

Copilot does not load Agent Skills, so workflow guidance always comes from the
MCP tool descriptions. Its preview behavior depends on the specific host:

- **Tool descriptions** to carry the `conjure → plan → write_files → preview`
  workflow.
- **VS Code Copilot agent** on an MCP Apps-capable build advertises the
  `io.modelcontextprotocol/ui` extension during initialization. genie detects
  that negotiated capability and renders `ui://genie/grid` inline without
  opening a redundant browser tab.
- **Other Copilot MCP surfaces** that do not advertise MCP Apps receive the
  live viewer in a server-opened browser tab. Disable that fallback with
  `GENIE_PREVIEW_NO_OPEN=1`.

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

Ask for a component in chat; Copilot runs the four-verb chain from the tool
descriptions. On an MCP Apps-capable VS Code build, `preview` renders the grid
inline. On a tools-only Copilot host, it opens a browser tab at the live grid.
If the viewer cannot boot, use the `file://` fallback path returned by
`preview`.

The broader M5 VS Code distribution issue still owns the production HTTP
snippet, sandbox-domain settings, one-click/CLI installation paths, and an
Insiders smoke test.
