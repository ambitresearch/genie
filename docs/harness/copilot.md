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

## Register the server — `.vscode/mcp.json`

Add genie to the workspace's `.vscode/mcp.json` (AC1). This is the canonical,
production-style HTTP snippet:

```json
{
  "servers": {
    "genie": {
      "type": "http",
      "url": "https://genie.<operator-domain>/mcp"
    }
  }
}
```

> **⚠️ Gotcha (AC2): the top-level key is `servers`, NOT `mcpServers`.**
> Every other harness in this repo (Cursor, Claude Desktop) uses `mcpServers` —
> pasting that key into `.vscode/mcp.json` silently registers nothing; VS Code
> Copilot only reads `servers`. Double-check the key name if genie doesn't show
> up in Copilot's server list after a reload.

For a local stdio install instead of the hosted HTTP endpoint:

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

### Sandboxed stdio installs (AC3) — macOS / Linux

VS Code Copilot can run a stdio MCP server inside its command sandbox. When you
opt a stdio entry into the sandbox, allow the LLM endpoint's network egress
explicitly — the sandbox denies network access by default:

```json
{
  "servers": {
    "genie": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"],
      "sandboxEnabled": true,
      "sandbox": {
        "network": {
          "allowedDomains": ["genie.<operator-domain>"]
        }
      }
    }
  }
}
```

`sandboxEnabled` and `sandbox.network.allowedDomains` are macOS/Linux-only —
there is no Windows sandbox equivalent for stdio servers today. Omit
`sandboxEnabled` entirely on Windows or when the server needs unrestricted
network access (for example, an LLM endpoint behind a dynamic set of hosts).

### One-click install (AC4)

From the Command Palette or the Extensions/Chat view, search `@mcp genie` (or
just `@mcp` to browse) and use the **Install** button on genie's listing once
it is published to a discoverable MCP registry. This writes the equivalent
`.vscode/mcp.json` entry for you — verify the `servers` key landed correctly
per the gotcha above.

### CLI install (AC5)

```bash
code --add-mcp '{"name":"genie","type":"http","url":"https://genie.<operator-domain>/mcp"}'
```

For a local stdio install via the CLI:

```bash
code --add-mcp '{"name":"genie","type":"stdio","command":"node","args":["/absolute/path/to/genie/packages/server/dist/cli.js","--transport","stdio"]}'
```

`code --add-mcp` writes into the same `.vscode/mcp.json` / user MCP config VS
Code Copilot reads — no manual JSON editing required.

## Devcontainer note

VS Code's Dev Containers extension can forward a genie server's port or run a
stdio server inside the container; see the
[Dev Containers docs](https://code.visualstudio.com/docs/devcontainers/containers)
for the general port-forwarding and `postCreateCommand` mechanics. Devcontainer
integration is out of scope for this issue — no smoke test covers it here.

## Using it

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. On an MCP Apps-capable VS Code build, `preview` renders the
grid inline. On a tools-only local stdio Copilot host, it opens a browser tab at
the live grid. HTTP surfaces never auto-open; a genuinely same-machine HTTP
client can request a local viewer URL with `--preview-locality local`, while a
remote HTTP host needs MCP Apps plus `GENIE_PREVIEWS_BASE_URL`. If a local
viewer cannot boot, use the returned `file://` fallback on that server machine.

## Smoke test (AC6/AC7)

`packages/e2e/test/m5-smoke-copilot.test.ts` drives the real four-verb chain
(`conjure → plan → write_files → preview`, minus the LLM-dependent `conjure`
call, matched by the M1/Cursor smoke pattern) over the real MCP protocol and
asserts the capability-negotiation contract genie's `preview` tool implements:

- **AC6** — when the client's `initialize` capabilities advertise the MCP Apps
  extension (`io.modelcontextprotocol/ui`) with the `text/html;profile=mcp-app`
  MIME type — the shape a genuinely MCP Apps-capable VS Code Insiders build
  negotiates — `preview`'s `_meta.ui.resourceUri` points at `ui://genie/grid`
  and the resource actually renders the fixture's cards inline (reusing the M4
  `buildGridDocument` headless-render assertion), never as text.
- **AC7** — when the client omits or negatives that capability — the shape
  VS Code Stable negotiates until its MCP Apps support ships (targeted Jan 2026,
  tracked in [microsoft/vscode#260218](https://github.com/microsoft/vscode/issues/260218))
  — `preview` falls back to a text/URL-only result with no `ui://` resource
  pointer, and the suite asserts that fallback shape instead of an inline
  render.

This suite cannot literally launch the VS Code Insiders application in CI (no
Electron/VS Code binary in the sandboxed/CI runner), so it drives the identical
MCP capability-negotiation surface Insiders' real client presents — the same
substitution the Codex CLI (DRO-283) and Cursor (DRO-285) smoke tests make for
their respective non-scriptable hosts. Manually installing on a real VS Code
Insiders build and confirming the inline grid renders is tracked as a Definition
of Done item on the issue, not automated here.
