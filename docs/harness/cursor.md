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

## Register a local server (Cursor / VS Code) — OAuth `auth` block

For a hosted genie MCP endpoint, Cursor's `mcp.json` also accepts an `auth`
block using Cursor's OAuth shape (static callback, per research §4). Cursor's
own docs (`cursor.com/docs/context/mcp`) key this block `CLIENT_ID` /
`CLIENT_SECRET` (uppercase, no `type` wrapper) — not `client_id`/`client_secret`:

```json
{
  "mcpServers": {
    "genie": {
      "url": "https://your-genie-endpoint.example.com/mcp",
      "auth": {
        "CLIENT_ID": "${env:GENIE_CURSOR_CLIENT_ID}",
        "CLIENT_SECRET": "${env:GENIE_CURSOR_CLIENT_SECRET}",
        "scopes": ["genie:tools"]
      }
    }
  }
}
```

- `CLIENT_ID` is required; `CLIENT_SECRET` is optional (only needed for
  confidential OAuth clients); `scopes` is optional — if omitted, Cursor
  discovers `scopes_supported` via the provider's
  `/.well-known/oauth-authorization-server` metadata document.
- `${env:VAR}` tokens are interpolated by Cursor from its own process
  environment at config-load time — never write a literal secret into
  `mcp.json` itself. The same `${env:VAR}` syntax works inside the `auth`
  block as it does for other fields.
- Cursor's OAuth exchange redirects to a **static callback URL**:
  `https://www.cursor.com/agents/mcp/oauth/callback`. That URL is owned by
  Cursor, not genie — the remote genie endpoint only needs to accept it as a
  registered redirect URI in whatever OAuth provider fronts it (see the M5-04
  OIDC integration test for the provider side of that contract).
- This block only applies to a **remote** (`url`) server entry. The local
  `stdio` snippet above needs no `auth` block — the local process inherits
  `GENIE_LLM_*` from its own environment directly.

## Tool-cap probe — empirical finding (AC4)

**Scope note:** this finding is confirmed for genie's server / the MCP SDK
ONLY — it is not, and cannot be, a test of Cursor's own client, since no
automated suite here launches or inspects an actual Cursor process. The
historical claim that Cursor caps loaded MCP tools at 40 is **not present in
Cursor's current docs** (research §4/§8) and remains unverified **for
Cursor's client-side behavior**. What IS now confirmed and empirical is the
server-side half of that question, tested in
`packages/e2e/test/m5-smoke-cursor.test.ts` ("AC4 — tool-cap probe"):

- The suite spawns genie's real built server binary
  (`packages/server/dist/cli.js`) as a real stdio child process — the exact
  transport Cursor's local `.cursor/mcp.json` `command` entry launches — with
  a dedicated test-only env var (`GENIE_TEST_EXTRA_TOOLS`, wired in
  `packages/server/src/cli.ts`) that registers 50+ additional no-op tools on
  that live server instance before it starts serving `tools/list`. It then
  asserts `tools/list` returns **every** one of them (real + dummy),
  unclipped, over that real stdio connection.
- **Confirmed finding: genie / the MCP TypeScript SDK impose no server-side
  cap.** `tools/list` is a plain unbounded response — nothing in genie's
  registration path or the SDK's `tools/list` handler truncates it at 40 or
  any other number.
- **Unverified / out of scope:** whether Cursor's own client still visibly
  limits the _displayed or auto-attached_ tool count today. If it does, that
  enforcement is entirely **client-side** inside Cursor itself — not
  something genie can detect, influence, or test from the server. Ship your
  full tool surface; if Cursor only exposes a subset to the model, that's
  Cursor's selection policy, observable only by a human tester inside an
  actual Cursor session (file a follow-up against Cursor's own docs/support
  if a live cap is reproduced that way).

## Using it

Just ask in chat — "generate a Card component and show me." The Skill (or the
tool-description fallback) runs the four-verb chain, and the inline grid appears
when `preview` is called. Only local Cursor / VS Code connections receive a
viewer URL that can be relayed as a backup. ChatGPT receives the inline app from
the remote connector and does not receive a local viewer URL.
