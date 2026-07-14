# genie in Cline

Cline is **tools-only**: it never negotiates the `io.modelcontextprotocol/ui`
MCP-Apps extension, so `preview` always returns its text/viewer-URL fallback —
Cline renders `content[0].text`, never a `ui://` inline grid. The `preview`
tool's tools-only branch handles this automatically; no Cline-specific server
code is required.

## Register the server

Cline reads its MCP server list from `~/.cline/mcp.json` (CLI) — or, for the
VS Code / JetBrains extension, its own per-IDE settings file (see
[IDE-extension config path](#ide-extension-config-path) below).

### `~/.cline/mcp.json` (CLI)

```json
{
  "mcpServers": {
    "genie": {
      "url": "https://genie.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GENIE_TOKEN}"
      },
      "autoApprove": ["list_components", "preview", "list_files"]
    }
  }
}
```

- **No `type` key.** Per the research report's Cline row (§4), Cline's JSON
  schema infers transport from which field is present: `url` → remote HTTP,
  `command` → local stdio. **Do not add a `type: "http"` / `type: "streamable-http"`
  key to a Cline server entry** — Cline's parser either silently ignores an
  unrecognized key or rejects the whole config, depending on version. If you
  need a local stdio server instead of HTTP, swap `url`/`headers` for
  `command`/`args`, the same shape every other stdio-only harness snippet in
  this repo uses (see [claude-code.md](./claude-code.md)):

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

  Never mix `url` and `command` in the same entry — pick one transport.

- **`headers`** carries the Bearer token for HTTP transport. genie's static
  Bearer fallback (M5-02, DRO-274 — `Authorization: Bearer genie_<token>`)
  is exactly the auth path Cline needs, since Cline does not implement OAuth
  Dynamic Client Registration. Mint the token with the admin CLI
  (`genie token create --scope read --scope write`) and store it as an
  environment variable your shell substitutes into the config (`${GENIE_TOKEN}`
  above) — **never hardcode a token in a committed `mcp.json`.**

- **`autoApprove`** is a per-server array of tool names Cline invokes without an
  interactive confirmation prompt. The recommended baseline is the read-only
  verb set:

  ```json
  "autoApprove": ["list_components", "preview", "list_files"]
  ```

  This lets Cline browse a UI kit and render previews without a per-call
  approval click, while every write-path verb (`conjure`, `plan`, `write_files`,
  `delete_files`, `refine`, …) still requires the user's explicit approval —
  genie never assumes blanket write access from an `autoApprove` entry.

## IDE-extension config path

The VS Code / JetBrains Cline extension does not read `~/.cline/mcp.json`; it
keeps its own settings file, historically:

```
<VS Code user data dir>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

(`~/.config/Code/User/globalStorage/...` on Linux, `~/Library/Application
Support/Code/User/globalStorage/...` on macOS, `%APPDATA%\Code\User\globalStorage\...`
on Windows — the standard VS Code `globalStorage` layout, keyed by the
extension's publisher.name id `saoudrizwan.claude-dev`.)

**This path is carried over from Cline's own published documentation and repo
layout, not re-confirmed against a live Cline install in this change** — this
sandbox has no VS Code + Cline extension installed to inspect (research report
§8 open question 12 / RFC §17.12 flagged this as `spike-needed`: "Inspect a
live Cline install"). Treat the path above as the best-documented starting
point, and re-verify it against Settings → open the "MCP Servers" panel →
"Configure MCP Servers" (Cline's in-UI button opens its settings file directly,
which is the fastest live-confirmation path) before depending on it in
automation. Cline also exposes an in-UI "Installed" / "Add Server" flow that
writes to this same file — using that UI avoids needing to know the exact path
at all.

**Probe date:** 2026-07-14 — desk review of Cline's public docs/repo only, no
live extension install available in this environment. If you have a Cline VS
Code/JetBrains install handy, please confirm the path and update this note
with the confirmed date and any per-OS/version deltas.

## Using it

Ask for a component in chat — Cline runs the `conjure → plan → write_files →
preview` four-verb chain (no Agent Skill support; Cline drives the chain from
tool descriptions alone) and shows the returned viewer URL / `file://`
fallback as plain text. `GENIE_PREVIEW_NO_OPEN=1` disables the local-stdio
auto-open-browser behavior if you're driving Cline non-interactively.

## Out of scope

One-click install via the Cline Marketplace is not covered here (no smoke
test) — this doc only covers hand-authored `mcp.json` / settings-file
registration.
