# genie in Codex

Genie uses the portable MCP Apps contract first and adapts to the MCP Apps UI
capability the connected surface negotiates:

- **Supported (`true`)** — `preview` prepares the inline canvas only. Genie
  returns `_meta.ui.resourceUri`, serves `text/html;profile=mcp-app`, and uses
  the standard `ui/*` bridge. OpenAI metadata aliases remain present for
  compatibility. No Vite viewer is started and no system browser is opened.
- **Unsupported (`false`)** — `preview` returns the local Vite viewer URL. For a
  local stdio connection, Genie also opens that URL in the system browser unless
  `GENIE_PREVIEW_NO_OPEN=1` is set.
- **Omitted** — `preview` prepares a hybrid result with both an
  inline manifest in widget-only tool-result metadata and a `viewerUrl` for
  tools-only hosts. Route-bearing card data does not enter model-visible
  `structuredContent`. Genie never auto-opens a browser for this ambiguous state.
- **Agent Skill** — on every surface, the Skill carries the
  `conjure → plan → write_files → preview` workflow; tool descriptions remain
  fallback guidance.

Current Codex Desktop and Codex CLI connections both identify as
`codex-mcp-client` and omit the UI capability. The choice must remain
capability-based: Genie never branches on that shared client name.

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

## Using it in Codex Desktop

Ask for a component in a Codex Desktop task. Because the current client omits
the UI capability, `preview` returns both inline data and a tools-only viewer
URL without opening Dia or another system browser. In an Apps-enabled Codex
Desktop task, Codex mounts the MCP App via `_meta.ui.resourceUri` and renders
the component grid directly beneath the tool call. If Apps are unavailable in
that task, open the returned viewer URL manually.

Local card assets are served by one process-scoped loopback broker shared by
all registered UI kits, not by one listener per kit. Each app resource declares
the broker's exact origin in its CSP; Genie does not rely on wildcard
`localhost:*` frame permissions.

The broker origin stays fixed for the MCP server process. New UI kits receive
opaque routes on that same origin, so they do not create another listener or
expand the mounted app's frame allowlist.

## Using it in Codex CLI

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. The current CLI also omits the UI capability, so `preview`
returns a live viewer URL without opening it. Open that URL manually. If the
viewer can't boot (e.g. headless), `preview` returns a `file://` path to the UI
kit's `index.html` — open that instead.

`GENIE_PREVIEW_NO_OPEN=1` disables auto-open for clients that explicitly report
the UI capability as unsupported. It has no effect on the omitted state, which
never auto-opens.
