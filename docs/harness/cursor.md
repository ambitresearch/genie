# genie in Cursor / VS Code / ChatGPT

These harnesses are **`ui://`-capable** but do **not** load Agent Skills. So:

- You do **not** install a Skill. The workflow guidance is carried by the MCP
  **tool descriptions** themselves — the model reads them and sequences
  `conjure → plan → write_files → preview` on its own.
- `preview` renders the `ui://genie/grid` card grid **inline, in-panel** — no
  browser tab, so `GENIE_PREVIEW_NO_OPEN` doesn't apply.

## Register a local server (Cursor / VS Code)

Add genie to your MCP config (Cursor: `.cursor/mcp.json` in the project, or the
global MCP settings):

```json
{
  "mcpServers": {
    "genie": {
      "command": "node",
      "args": ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]
    }
  }
}
```

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` to the server process as
environment — **never hardcode secrets** in the config. The base URL must end
in `/v1`. `preview` / `validate` / read tools work even without an LLM set.

VS Code (≥ Jan 2026) uses its own top-level `servers` configuration (see
[copilot.md](./copilot.md)) but can run the same local stdio command.

## ChatGPT requires a remote connector

ChatGPT cannot launch a command from your local filesystem. Register genie only
after deploying a reachable authenticated HTTP MCP endpoint, then add that URL
through ChatGPT's connector/app configuration. The M5 ChatGPT distribution work
owns the production auth and smoke-tested connector instructions; do not paste
the Cursor stdio snippet into ChatGPT.

## Using it

Just ask in chat — "generate a Card component and show me." The model reads the
tool descriptions, runs the four-verb chain, and the inline grid appears when
`preview` is called. Relay the viewer URL it returns as a backup way in.
