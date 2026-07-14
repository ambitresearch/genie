# genie in Cline

Cline is tools-only — it has no MCP Apps UI capability, so `preview` always
returns a `viewerUrl` (and, when nothing can boot, a `file://` fallback);
`_meta.ui.resourceUri` content is present for spec-compliant clients but Cline
does not render it inline. Skill support carries the `conjure → plan →
write_files → preview` workflow; without it, tool descriptions are the
fallback guidance.

## Empirical findings (probed 2026-07-14)

The research report's open question (§8, item 12) flagged the `type` key and
the settings-file path as unconfirmed. Both are now confirmed against Cline's
current published source (`cline/cline` on GitHub, `main`) — not just docs —
and against a live `npx cline@3.0.40 mcp install` run in this change:

- **The `type` key exists and matters.** This corrects the report's original
  "no `type` key" claim, accurate for an older release but not the current
  schema. `apps/vscode/src/services/mcp/schemas.ts`'s `McpSettingsSchema`
  accepts a flat `{ type, url, headers, ... }` shape (the code comment there
  says explicitly: *"the fact that [the `sse` schema] is listed first before
  streamableHttp means that when type is not specified, it will default to
  sse"*) — so **omitting `type` on a flat, `url`-based entry silently falls
  back to the legacy `sse` transport**, not stdio-vs-http inference. Always
  set `type: "streamableHttp"` explicitly for genie's HTTP endpoint.
- **The CLI writes a *nested* `transport` object, not the flat shape** — a
  live `npx cline@3.0.40 mcp install genie <url> --transport streamableHttp
  --header "Authorization: Bearer …" --yes` run in this change produced:

  ```json
  { "mcpServers": { "genie": { "transport": { "type": "streamableHttp", "url": "...", "headers": { "Authorization": "..." } } } } }
  ```

  `schemas.ts`'s `nestedTransportConfigSchema` accepts this nested form and
  flattens it internally; the flat form (`type`/`url`/`headers` as siblings,
  used below) is also accepted directly. Either shape works — pick the flat
  one for hand-edited configs since it is shorter, but recognize the nested
  one if you inspect a CLI-written file.
- **Settings-file path** — the CLI and the modern VS Code/JetBrains extension
  share ONE settings file, resolved by
  `sdk/packages/shared/src/storage/paths.ts`'s `resolveClineDataDir()` /
  `CLINE_MCP_SETTINGS_FILE_NAME` constant (confirmed live: `cline --help`
  reports `--config <path>` default `~/.cline/data/settings` and `--data-dir
  <path>` default `~/.cline`):

  ```
  $CLINE_MCP_SETTINGS_PATH                                   # explicit override, highest priority
  $CLINE_DATA_DIR/settings/cline_mcp_settings.json            # explicit data-dir override
  $CLINE_DIR/data/settings/cline_mcp_settings.json            # explicit Cline-dir override
  ~/.cline/data/settings/cline_mcp_settings.json              # default (all platforms)
  ```

  This corrects the previous "`~/.cline/mcp.json`" and VS Code
  `globalStorage`-only claims — those were legacy per-install locations.
  `apps/vscode/src/hosts/vscode/mcp-settings-legacy-migration.ts` still reads
  two legacy sources once (VS Code's own `globalStorageUri`-relative
  `settings/cline_mcp_settings.json`, and a
  `Documents/Cline/MCP/cline_mcp_settings.json` path) and migrates any
  servers found there into the shared file above, so an existing legacy
  config is not lost — but new edits belong in the shared path.
- **VS Code/JetBrains UI** — the **MCP Servers** sidebar icon → **Configure**
  tab → **Configure MCP Servers** opens the same shared
  `cline_mcp_settings.json` in an editor tab; a **Remote Servers** tab in the
  same panel accepts name/URL/transport via form fields as an alternative to
  hand-editing JSON.

## Register the server (`~/.cline/data/settings/cline_mcp_settings.json`)

```json
{
  "mcpServers": {
    "genie": {
      "type": "streamableHttp",
      "url": "https://genie.<operator-domain>/mcp",
      "headers": {
        "Authorization": "Bearer ${GENIE_TOKEN}"
      },
      "disabled": false,
      "autoApprove": ["list_components", "preview", "list_files"]
    }
  }
}
```

- `type: "streamableHttp"` — required; do not omit (see above).
- `headers.Authorization` — genie's static Bearer token fallback (M5-02,
  DRO-274). Mint a token out-of-band with `genie token create --sub cline`
  server-side; never hardcode the plaintext in this file — reference an
  environment variable your shell populates, or paste the one-time plaintext
  directly only in a local, non-shared config.
- `autoApprove` — limit to read-only, side-effect-free verbs. `conjure`,
  `refine`, and `write_files` mutate project state and should stay outside
  `autoApprove` so Cline still asks for confirmation.
- `disabled: false` — Cline's toggle to keep the server registered but
  inactive without deleting the entry.

For the VS Code/JetBrains extension, use the **Configure MCP Servers** editor
(see above) — it accepts the identical JSON shape under the same
`mcpServers` key, in the same shared settings file. You can also register the
server non-interactively with the CLI:

```
npx cline@latest mcp install genie https://genie.<operator-domain>/mcp \
  --transport streamableHttp \
  --header "Authorization: Bearer ${GENIE_TOKEN}" \
  --yes
```

## Using it

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. Cline is tools-only: `preview`'s `_meta.ui.resourceUri` is
present in the tool result but Cline does not consume it, so the response
still shows the plain-text tool output (component list, file paths, the
returned `viewerUrl`) rather than a rendered `ui://` grid. Open the returned
viewer URL manually to see the interactive card grid.

## Out of scope

One-click install via the Cline Marketplace is not covered here — mention
only; no smoke test exercises it.
