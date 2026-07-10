# genie in Cursor / VS Code / ChatGPT

Cursor and VS Code Copilot support Agent Skills as well as inline `ui://`
rendering. ChatGPT's remote connector renders `ui://`, but does not consume a
Skill from your local filesystem.

- Cursor can load genie's portable Skill; tool descriptions remain fallback
  guidance when it is not installed or enabled.
- `preview` renders the `ui://genie/grid` card grid **inline, in-panel** — no
  browser tab, so `GENIE_PREVIEW_NO_OPEN` doesn't apply.

## Install the Agent Skill in Cursor

Cursor discovers skills from the locations documented in its
[Agent Skills guide](https://cursor.com/docs/skills). For a user-level install
available across projects:

```bash
mkdir -p ~/.cursor/skills
cp -R packages/plugin/skills/genie ~/.cursor/skills/genie
```

For a project-only install, copy the same directory to
`.cursor/skills/genie` (or the shared `.agents/skills/genie` location). Restart
Cursor or reload skills after copying. VS Code Copilot uses its own Skill path;
see [copilot.md](./copilot.md).

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

Just ask in chat — "generate a Card component and show me." The Skill (or the
tool-description fallback) runs the four-verb chain, and the inline grid appears
when `preview` is called. Relay the viewer URL it returns as a backup way in.
