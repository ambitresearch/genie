# genie in Codex CLI

Codex does not render `ui://` inline, but it does support the portable Agent
Skills format:

- **Agent Skill** carries the `conjure → plan → write_files → preview` workflow;
  tool descriptions remain fallback guidance.
- **Server-opened browser tab** — when you call `preview`, the genie server
  opens your system browser at the viewer URL **itself** (it doesn't rely on the
  model to shell `open`). Disable with `GENIE_PREVIEW_NO_OPEN=1` if you'd rather
  open the URL yourself.

## Install the Agent Skill

Codex scans the directories documented in its
[Agent Skills guide](https://developers.openai.com/codex/skills). For a
user-level install:

```bash
mkdir -p ~/.agents/skills
cp -R packages/plugin/skills/genie ~/.agents/skills/genie
```

For a project-only install, copy the same directory to
`.agents/skills/genie` at the repository root. Restart Codex if the newly copied
Skill does not appear.

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

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. When `preview` fires, a browser tab opens at the live grid. If
the viewer can't boot (e.g. headless), `preview` returns a `file://` path to the
kit's `index.html` — open that instead.

To keep genie from opening tabs (CI, headless, or you just prefer manual):
set `GENIE_PREVIEW_NO_OPEN=1` on the server and open the returned URL yourself.
