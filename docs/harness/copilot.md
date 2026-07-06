# genie in GitHub Copilot

Copilot (Copilot Chat / agent mode with MCP) is **neither** `ui://`-capable
**nor** Skill-loading — same profile as Codex. genie relies on:

- **Tool descriptions** to carry the `conjure → plan → write_files → preview`
  workflow.
- **Server-opened browser tab** — `preview` has the genie server open your
  browser at the viewer URL itself. Disable with `GENIE_PREVIEW_NO_OPEN=1`.

## Register the server

Add genie to Copilot's MCP configuration (e.g. `.vscode/mcp.json` for the
VS Code Copilot agent, or your Copilot MCP settings) as a stdio server:

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
descriptions, and `preview` opens a browser tab at the live grid. If the viewer
can't boot, use the `file://` fallback path `preview` returns. Set
`GENIE_PREVIEW_NO_OPEN=1` to suppress the auto-open and open the URL yourself.
