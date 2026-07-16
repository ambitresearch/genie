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

Codex CLI reads `~/.codex/config.toml`. It has **no `type`/`transport` key** —
transport is inferred entirely from which keys are present: a `command` entry
means stdio, a `url` entry means Streamable HTTP. Adding a `type` key anyway
does not select a transport; it is either silently ignored or rejected,
depending on the Codex build, so leave it out.

### Local stdio (a checked-out genie build)

```toml
[mcp_servers.genie]
command = "node"
args = ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"]
```

Provide `GENIE_LLM_BASE_URL` / `GENIE_LLM_API_KEY` to the server process as
environment — **never hardcode secrets** in the config. The base URL must end
in `/v1`.

### Remote HTTP (an operator-hosted genie deployment)

This is the canonical snippet for a deployed genie instance:

```toml
[mcp_servers.genie]
url = "https://genie.<operator-domain>/mcp"
bearer_token_env_var = "GENIE_TOKEN"
startup_timeout_sec = 15
tool_timeout_sec = 120
```

Two gotchas the research report flags explicitly:

- **No `type` key**, per above — `url` alone is what makes Codex dial
  Streamable HTTP.
- **`bearer_token_env_var`, not plain `headers`.** Codex reads the named
  environment variable (`GENIE_TOKEN` here — set it in the shell that launches
  Codex, never in the TOML) and sends it as `Authorization: Bearer <value>`.
  A raw `headers = { ... }` table is not how Codex authenticates a remote MCP
  server.

`codex mcp add genie --url https://genie.<operator-domain>/mcp
--bearer-token-env-var GENIE_TOKEN` writes this same shape for you and is the
easiest way to avoid a typo'd key name.

### OAuth path

If the genie deployment is registered for OAuth instead of a static bearer
token, skip `bearer_token_env_var` and run:

```bash
codex mcp login genie
```

This drives the OAuth flow and stores the resulting credential outside
`config.toml`; it does not apply to a server configured with
`bearer_token_env_var` (that snippet already carries its own credential via
the environment variable).

### Allow-listing / deny-listing tools

Add `enabled_tools` (allow-list) or `disabled_tools` (deny-list) to either
snippet above to restrict which of genie's tools Codex exposes to the model —
useful for keeping a Codex session to, say, the four-verb generation chain:

```toml
enabled_tools = ["conjure", "plan", "write_files", "preview"]
```

Use one or the other, not both, per Codex's own `mcp_servers` schema.

## Using it in Codex Desktop

Ask for a component in a Codex Desktop task. Because the current client omits
the UI capability, `preview` returns both inline data and a tools-only viewer
URL without opening Dia or another system browser. When Apps support is
available and the task's MCP child was started after the server was built,
Codex Desktop can mount the MCP App via `_meta.ui.resourceUri` and render
the component grid beneath the tool call. If Apps are unavailable or the
task predates the rebuilt server, open the returned viewer URL manually.

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

**Codex CLI is tools-only.** It never negotiates the MCP Apps UI capability,
so a genie `ui://` resource is not something Codex can mount — every response
downgrades to the plain-text/JSON tool result plus the viewer/`file://` URL
above. This is the "omitted" capability branch this doc's intro describes, not
a bug: there is no Codex build that renders the inline `ui://genie/grid` card
grid today.

## Smoke-testing a genie/Codex CLI registration

`packages/e2e/test/m5-smoke-codex.test.ts` is the automated check for this
document. It drives two things against the REAL `codex` binary and genie's
real built server, not a stand-in for either:

1. The canonical TOML snippets above, fed through `codex mcp add`/`codex mcp
   get --json`, come back with the exact shape documented here — no `type`
   key, `url`/`command`-inferred transport, `bearer_token_env_var`, and
   `enabled_tools`.
2. The four-verb chain (`conjure → plan → write_files → preview`), run over a
   real stdio child process launched exactly the way Codex's `command`-keyed
   `mcp_servers` entry launches genie.

CI runs both legs for every same-repository PR and push (`codex-smoke` job). It
maps a dedicated public smoke-endpoint secret pair into
`GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` and sets `GENIE_REQUIRE_LLM=1`, so
`conjure` must run for real. The gateway times out from GitHub-hosted Actions,
so this job uses the repository's network-capable self-hosted runner. Local
runs still skip the paid endpoint cases visibly when that pair is absent.
GitHub does not expose repository secrets to untrusted fork PRs, so fork
contributions need a maintainer-run trusted branch before this gate can pass.

A third leg drives the actual Codex REPL end-to-end: `codex exec` (Codex's own
non-interactive entry point — the same binary an interactive session runs) is
launched with genie registered exactly per the stdio snippet above via
`codex mcp add`, and asked in plain language to run the four-verb chain. The
full JSONL event transcript Codex emits is captured to
`reports/codex-repl-transcript.jsonl` as evidence, and the test asserts the
transcript shows Codex's own model actually calling genie's tools. This leg
reuses `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` as Codex's own driving-model
provider (separate from genie's backend, but the same OpenAI-`responses`-API
shape satisfies both), so it is gated on the same environment pair as
`conjure`. In the required CI job, missing credentials, endpoint failures, and
provider/tool-schema incompatibilities fail loudly and leave the captured
transcript as evidence; the real-endpoint gate is never converted into a skip.
