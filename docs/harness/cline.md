# genie in Cline

Cline is tools-only — it has no MCP Apps UI capability, so `_meta.ui.resourceUri`
content is present in every `preview` result for spec-compliant clients, but
Cline never renders it inline; the response Cline actually shows is plain
text. What that text contains depends on **preview locality**, which genie
resolves from the transport, not from the harness:

- **Local stdio connection** (`--transport stdio`, or `--preview-locality
  local` / `GENIE_PREVIEW_LOCALITY=local` over HTTP on the same machine as the
  browser) — `preview` returns a `viewerUrl` and, if nothing can boot, a
  `file://` fallback.
- **Remote HTTP connection** (the default locality for HTTP, e.g. the
  `url`+`headers` registration below with no locality override) — there is
  **no** `viewerUrl`/`file://` fallback. `preview`'s text is either
  `"Preview ready in the inline MCP App."` (only reachable if the client
  negotiated the UI extension, which Cline does not) or `"Remote preview
  unavailable: …"`. A tools-only remote Cline session will only ever see the
  latter. Configure `GENIE_PREVIEWS_BASE_URL` server-side (inline MCP App path,
  irrelevant to Cline) or point Cline at a local stdio server instead if you
  need a browsable viewer URL.

Skill support carries the `conjure → plan → write_files → preview` workflow;
without it, tool descriptions are the fallback guidance. See
[Install the Agent Skill](#install-the-agent-skill-optional) below — current
Cline (`cline@0.0.x` CLI, confirmed 2026-07-14) discovers portable `SKILL.md`
packages via its own `skill` subcommand (`cline skill add <owner/repo> --skill
<name> --agent cline`), which forwards to the open `skills` CLI and installs
into the shared `.agents/skills` / `~/.agents/skills` convention the other
harness guides ([codex.md](./codex.md), [cursor.md](./cursor.md)) also use.

## Empirical findings (probed 2026-07-14)

The research report's open question (§8, item 12) flagged the `type` key and
the settings-file path as unconfirmed. Both are now confirmed against a live
`npx cline@latest` run in this change (CLI version resolved at probe time),
not just Cline's published docs or source:

- **The `type` key exists and matters.** This corrects the report's original
  "no `type` key" claim, accurate for an older release but not the current
  schema. Cline's settings schema accepts a flat `{ type, url, headers, ... }`
  shape; per Cline's own docs and schema comments, **omitting `type` on a
  flat, `url`-based entry silently falls back to the legacy `sse` transport**,
  not stdio-vs-http inference. Always set `type: "streamableHttp"` explicitly
  for genie's HTTP endpoint.
- **The CLI writes a *nested* `transport` object, not the flat shape** — a
  live run of:

  ```
  npx cline@latest mcp install genie http://127.0.0.1:9/mcp \
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

  Cline's settings loader accepts this nested form and flattens it
  internally; the flat form (`type`/`url`/`headers` as siblings, used below)
  is also accepted directly per Cline's own published schema and docs — this
  flat-shape acceptance is a **desk-review claim**, not independently
  re-verified via `cline mcp install` in this change (the CLI only ever
  writes the nested shape; `cline config`, the one command that reads
  settings back, requires an interactive TTY even with `--json` and so
  couldn't be driven headlessly here — see `m5-smoke-cline.test.ts`'s
  "real CLI" suite in-file note). Either shape works — pick the flat one for hand-edited
  configs since it is shorter, but recognize the nested one if you inspect a
  CLI-written file.
- **Settings-file path — confirmed by the same live run above**: the CLI
  wrote to `~/.cline/data/settings/cline_mcp_settings.json` (`cline --help`
  independently confirms this as the `--config`/`--data-dir` default:
  `--config <path>` defaults to `~/.cline/data/settings`, `--data-dir <path>`
  defaults to `~/.cline`). This corrects the previous "`~/.cline/mcp.json`"
  claim. `CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR`, and `CLINE_DIR`
  environment variables override the path at increasing specificity, in that
  priority order, before the default applies.
- **IDE-extension (VS Code/JetBrains) settings path — NOT independently
  live-probed in this sandbox** (no VS Code/JetBrains host available here).
  Cline's own documentation and current source describe the VS Code/JetBrains
  extension sharing the identical `cline_mcp_settings.json` file the CLI
  writes to above, migrating two legacy per-host locations
  (`globalStorageUri`-relative `settings/cline_mcp_settings.json`, and
  `Documents/Cline/MCP/cline_mcp_settings.json`) into it on first run so an
  existing legacy config is not lost. This is a **desk-review claim** carried
  over from source reading, not a live extension install in this change —
  flagged explicitly per AC4's intent rather than presented as independently
  verified. A follow-up with a real VS Code/JetBrains + Cline install would
  upgrade this to fully empirical.
- **Cline Skills discovery** — `cline skill add anthropics/skills --skill pdf
  --agent cline --yes`, run live in this change from a project directory,
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
      "type": "streamableHttp",
      "url": "https://genie.<operator-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <paste-token-here>"
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

- `type: "streamableHttp"` — required; do not omit (see above).
- `headers.Authorization` — genie's static Bearer token fallback (M5-02,
  DRO-274). Mint a token out-of-band with `genie token create --sub cline`
  server-side. Cline's shared settings loader reads this JSON file directly —
  it does **not** expand `${VAR}`/`${env:VAR}`-style placeholders (that
  substitution is a VS Code-host-only convention some *other* extensions use,
  not Cline's). Paste the plaintext token directly into this file (keep it out
  of version control — it lives under `~/.cline`, not the repo) rather than
  writing an unexpanded `${GENIE_TOKEN}` placeholder that would be sent
  literally and fail Bearer auth.
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
hand-editing JSON) — see the "NOT independently live-probed" caveat above.
You can also register the server non-interactively with the CLI:

```
npx cline@latest mcp install genie https://genie.<operator-domain>/mcp \
  --transport streamableHttp \
  --header "Authorization: Bearer <paste-token-here>" \
  --yes
```

## Install the Agent Skill (optional)

```bash
npx cline@latest skill add <owner/repo> --skill genie --agent cline --yes
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
