# genie in Codex CLI

Codex is **neither** `ui://`-capable **nor** Skill-loading. So genie leans on the
two levers that always work:

- **Tool descriptions** carry the `conjure → plan → write_files → preview`
  workflow — the model sequences the verbs by reading them.
- **Server-opened browser tab** — when you call `preview`, the genie server
  opens your system browser at the viewer URL **itself** (it doesn't rely on the
  model to shell `open`). Disable with `GENIE_PREVIEW_NO_OPEN=1` if you'd rather
  open the URL yourself.

## Register the server

Add genie to your Codex MCP configuration as a stdio server:

```toml
[mcp_servers.genie]
command = "node"
args = ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]
```

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` to the server process as
environment — **never hardcode secrets** in the config. The base URL must end
in `/v1`.

## Using it

Ask for a component in chat; the model runs the four-verb chain from the tool
descriptions. When `preview` fires, a browser tab opens at the live grid. If
the viewer can't boot (e.g. headless), `preview` returns a `file://` path to the
kit's `index.html` — open that instead.

To keep genie from opening tabs (CI, headless, or you just prefer manual):
set `GENIE_PREVIEW_NO_OPEN=1` on the server and open the returned URL yourself.
