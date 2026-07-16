# genie in Cline

Cline is tools-only — it has no MCP Apps UI capability, so `_meta.ui.resourceUri`
content is present in every `preview` result for spec-compliant clients, but
Cline never renders it inline; the response Cline actually shows is plain
text. What that text contains depends on **preview locality**, which genie
resolves from the transport, not from the harness:

- **Local stdio connection.** Use `--transport stdio`. Same-machine HTTP can
  opt in with `--preview-locality local` or `GENIE_PREVIEW_LOCALITY=local`.
  `preview` returns a `viewerUrl` and, if nothing can boot, a
  `file://` fallback.
- **Remote HTTP connection** (the default locality for HTTP, e.g. the
  `url`+`headers` registration below with no locality override) — there is
  **no** `viewerUrl`/`file://` fallback. `preview`'s text is either
  `"Preview ready in the inline MCP App."` (only reachable if the client
  negotiated the UI extension, which Cline does not) or a
  `"Remote preview unavailable: …"` message. A tools-only remote Cline session sees the
  latter. Configure `GENIE_PREVIEWS_BASE_URL` server-side (inline MCP App path,
  irrelevant to Cline) or point Cline at a local stdio server instead if you
  need a browsable viewer URL.

Skill support carries the `conjure → plan → write_files → preview` workflow;
without it, tool descriptions are the fallback guidance. See
[Install the Agent Skill](#install-the-agent-skill-optional) below — current
Cline (`cline@3.0.42`, confirmed 2026-07-16) discovers portable `SKILL.md`
packages via its own `skill` subcommand (`cline skill add <owner/repo> --skill
<name> --agent cline`), which forwards to the open `skills` CLI and installs
into the shared `.agents/skills` / `~/.agents/skills` convention the other
harness guides ([codex.md](./codex.md), [cursor.md](./cursor.md)) also use.
Cline ships frequent releases, so treat the exact version number as a
point-in-time data point rather than a pin — re-check `cline --version`
against your own install if these specifics matter.

## Empirical findings (probed 2026-07-14 and 2026-07-16)

The research report's open question (§8, item 12) flagged the `type` key and
the settings-file path as unconfirmed. The CLI behavior is confirmed against
the pinned `cline@3.0.42` smoke, and the extension path was independently
probed against an installed Cursor extension on 2026-07-16:

- **The `type` key exists and matters.** This corrects the report's original
  "no `type` key" claim, accurate for an older release but not the current
  schema. Cline's settings schema accepts a flat `{ type, url, headers, ... }`
  shape; per Cline's own docs and schema comments, **omitting `type` on a
  flat, `url`-based entry silently falls back to the legacy `sse` transport**,
  not stdio-vs-http inference. Always set `type: "streamableHttp"` explicitly
  for genie's HTTP endpoint.
- **The CLI writes a _nested_ `transport` object, not the flat shape** — a
  live run of:

  ```
  npx cline@3.0.42 mcp install genie http://127.0.0.1:9/mcp \
    --transport streamableHttp \
    --header "Authorization: Bearer testtoken" --yes --json
  ```

  produced, verbatim, in `~/.cline/data/settings/cline_mcp_settings.json`:

  ```json
  {
    "mcpServers": {
      "genie": {
        "transport": {
          "type": "streamableHttp",
          "url": "http://127.0.0.1:9/mcp",
          "headers": { "Authorization": "Bearer testtoken" }
        }
      }
    }
  }
  ```

  Cline's settings loader accepts this nested form and flattens it internally.
  The pinned smoke uses this shape because it is the one Cline itself writes
  and consumes. Use it for portable CLI/extension configuration rather than a
  hand-edited compatibility form.

- **Settings-file path — confirmed by the same live run above**: the CLI
  wrote to `~/.cline/data/settings/cline_mcp_settings.json` (`cline --help`
  independently confirms this as the `--config`/`--data-dir` default:
  `--config <path>` defaults to `~/.cline/data/settings`, `--data-dir <path>`
  defaults to `~/.cline`). This corrects the previous "`~/.cline/mcp.json`"
  claim. `CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR`, and `CLINE_DIR`
  environment variables override the path at increasing specificity, in that
  priority order, before the default applies.
- **IDE-extension path — independently live-probed 2026-07-16.** Cursor's
  activated Cline extension `3.89.2` loaded its real settings file at
  `<Cursor user-data>/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`.
  Current Cline source migrates that per-host file (and the older
  `Documents/Cline/MCP/cline_mcp_settings.json`) into the shared CLI path
  `~/.cline/data/settings/cline_mcp_settings.json`; after migration, use the
  shared path as the canonical file. This distinction matters for older
  installed extensions that have not yet migrated.
- **Cline Skills discovery** — the following command was run live from a
  project directory:

  `cline skill add anthropics/skills --skill pdf --agent cline --yes`

  It
  installed into `.agents/skills/pdf/SKILL.md` (project-scoped; `-g`/--global
  installs to `~/.agents/skills` per the underlying `skills` CLI's Cline
  adapter, which detects Cline via `~/.cline` and reuses the shared
  `.agents/skills` directory other Agent-Skills-compatible harnesses use).
  This corrects `docs/harness/README.md`'s prior "no Skill support" claim for
  Cline.

## Register the server (`~/.cline/data/settings/cline_mcp_settings.json`)

```json
{
  "mcpServers": {
    "genie": {
      "transport": {
        "type": "streamableHttp",
        "url": "https://genie.<operator-domain>/mcp",
        "headers": {
          "Authorization": "Bearer <paste-token-here>"
        }
      },
      "disabled": false,
      "autoApprove": [
        "mcp__genie__list_components",
        "mcp__genie__preview",
        "mcp__genie__list_files"
      ]
    }
  }
}
```

- `transport.type: "streamableHttp"` — required; do not omit (see above).
- `transport.headers.Authorization` — genie's static Bearer token fallback
  (M5-02, DRO-274). Mint a token server-side with
  `genie token create --sub cline`. The CLI forwards header strings literally, so do **not**
  use `${env:GENIE_TOKEN}` in a CLI-consumed config: it would send that text and
  receive 401. The extension host can expand `${env:...}`, but the portable
  configuration above uses a literal token because it works in both surfaces.
  Keep this user-local settings file out of version control and rotate the
  token if it is exposed.
- `autoApprove` — uses genie's actual registered MCP tool names
  (`mcp__genie__list_components`, `mcp__genie__preview`,
  `mcp__genie__list_files` — see `packages/server/src/tools/*.ts`'s
  `*_TOOL_NAME` exports), not the bare verb names; Cline matches
  `autoApprove` entries against the exact tool name from `tools/list`, so bare
  names like `"list_components"` never match and silently auto-approve
  nothing. Limit this list to read-only, side-effect-free verbs — `conjure`,
  `refine`, and `write_files` mutate project state and should stay outside
  `autoApprove` so Cline still asks for confirmation.
- `disabled: false` — Cline's toggle to keep the server registered but
  inactive without deleting the entry.

This snippet registers a **remote** HTTP endpoint, so — per the locality
section above — `preview` will return `"Remote preview unavailable: …"` text,
not a browsable URL, in a plain Cline session. If you want a browsable
`viewerUrl`/`file://` result from Cline, run genie over local stdio instead:

```json
{
  "mcpServers": {
    "genie": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]
    }
  }
}
```

For the VS Code/JetBrains extension, use the **MCP Servers** sidebar icon →
**Configure** tab → **Configure MCP Servers**, which opens the same shared
`cline_mcp_settings.json` in an editor tab (a **Remote Servers** tab in the
same panel accepts name/URL/transport via form fields as an alternative to
hand-editing JSON). See the versioned extension-path probe above.
You can also register the server non-interactively with the CLI:

```
npx cline@3.0.42 mcp install genie https://genie.<operator-domain>/mcp \
  --transport streamableHttp \
  --header "Authorization: Bearer <paste-token-here>" \
  --yes
```

## Install the Agent Skill (optional)

```bash
npx cline@3.0.42 skill add <owner/repo> --skill genie --agent cline --yes
```

or, from a local checkout of this repo, install the portable Skill directly
into the shared convention Cline's `skill` subcommand also targets:

```bash
mkdir -p .agents/skills
cp -R packages/plugin/skills/genie .agents/skills/genie
```

Without the Skill installed, tool descriptions alone still carry enough
guidance for the four-verb chain — the Skill just removes the need to spell
out the workflow in the prompt.

## Using it

Ask for a component in chat; the Skill (or tool-description fallback) runs the
four-verb chain. Cline is tools-only: `preview`'s `_meta.ui.resourceUri` is
present in the tool result but Cline does not consume it, so the response
still shows the plain-text tool output described in the locality section
above. Over the remote HTTP registration documented here, that text is a
`"Remote preview unavailable: …"` message, not a clickable URL — see
[Register the server](#register-the-server-clinedatasettingscline_mcp_settingsjson)
for the local-stdio alternative if you need a browsable viewer.

## Out of scope

One-click install via the Cline Marketplace is not covered here — mention
only; no smoke test exercises it.
