# genie in Continue.dev

Continue speaks MCP over the same protocol every other harness uses, but it
diverges from every other harness genie documents in two ways worth calling
out up front:

- **Continue is the only harness that REQUIRES an explicit `type` key.**
  Every other harness genie documents (Claude Code, Cursor, Codex, Copilot)
  infers the transport from which keys are present (`command` vs `url`).
  Continue does not infer — you must write `type: stdio | sse |
  streamable-http` yourself, or Continue rejects (or silently misconfigures)
  the server entry.
- **Continue interpolates secrets as `${{ secrets.NAME }}`**, not a
  `headers`/`auth` config key or a bare environment-variable reference like
  Codex's `bearer_token_env_var`. There is no `headers`/`auth` key in
  Continue's `mcpServers` schema at all — authenticated headers are written
  inline with the `${{ secrets.NAME }}` placeholder, which Continue resolves
  from its own secrets store at connection time.

## Register the server

Continue reads `.continue/mcpServers/` (project-level) or the equivalent
user-level config. This is the canonical snippet for a deployed genie
instance:

```yaml
name: genie
version: 1.0.0
schema: v1
mcpServers:
  - name: genie
    type: streamable-http
    url: "https://genie.<operator-domain>/mcp"
    requestOptions:
      headers:
        Authorization: Bearer ${{ secrets.GENIE_TOKEN }}
```

Two things the research report flags explicitly:

- **`type: streamable-http` is mandatory.** Leaving it out is not "inferred as
  streamable-http by default" the way Codex or Claude Code would — Continue
  is the only harness in this doc set that requires you to write the
  discriminator (`stdio`, `sse`, or `streamable-http`) yourself.
- **Secrets never go in the YAML as literal values.** `${{ secrets.GENIE_TOKEN
  }}` is Continue's own interpolation syntax — it resolves `GENIE_TOKEN` from
  Continue's secrets store (configured separately, outside this file) at
  connection time. Never hardcode a bearer token into the `requestOptions
  .headers` block.

### Local stdio (a checked-out genie build)

```yaml
name: genie
version: 1.0.0
schema: v1
mcpServers:
  - name: genie
    type: stdio
    command: node
    args:
      - "/absolute/path/to/genie/packages/server/dist/cli.js"
      - "--transport"
      - "stdio"
    env:
      GENIE_LLM_BASE_URL: ${{ secrets.GENIE_LLM_BASE_URL }}
      GENIE_LLM_API_KEY: ${{ secrets.GENIE_LLM_API_KEY }}
```

`type: stdio` is required here too — same rule, different value. The base URL
must end in `/v1`. Never hardcode secrets directly in the YAML; route them
through `${{ secrets.NAME }}`.

## MCP only works in agent mode

**Continue only calls MCP tools when the session is in agent mode.** In
Continue's chat mode and in autocomplete, the `mcpServers` entry above is
inert — genie's tools are not offered to the model and `conjure → plan →
write_files → preview` is not reachable. Switch the Continue session to agent
mode before asking it to use genie.

## Using it in Continue

Ask for a component in an agent-mode Continue session. Continue has no Agent
Skills loader in the sense Claude Code, Cursor, Codex, and Copilot do, so
genie's guidance in Continue comes entirely from tool descriptions — there is
no bundled `SKILL.md` install path documented for Continue today. Because
Continue does not negotiate the MCP Apps `ui://` capability, `preview` returns
plain text/JSON tool output (component metadata plus a viewer URL/`file://`
fallback), not an inline card grid. Open the returned viewer URL manually to
see the rendered components.

## Smoke-testing a genie/Continue registration

`packages/e2e/test/m5-smoke-continue.test.ts` is the automated check for this
document. Continue's own CLI does not expose a scriptable way to drive an
agent-mode chat turn the way `codex exec` or a Cursor session does, so this
suite proves the two things that ARE independently testable:

1. **The canonical YAML snippets above parse to the exact documented shape** —
   `type: streamable-http` / `type: stdio` present and required, secrets
   expressed via the literal `${{ secrets.NAME }}` placeholder (never resolved
   or hardcoded), and no `headers`/`auth` top-level key.
2. **The four-verb chain (`conjure → plan → write_files → preview`) runs over
   a real stdio child process**, launched exactly the way Continue's
   `type: stdio` `mcpServers` entry launches genie, and asserts every tool
   result surfaces plain **text output** the harness can render without any
   `ui://` support (AC5). Genie's `preview` stays capability-based (per
   `docs/harness/README.md`) rather than branching on harness identity, so
   the protocol-level result still carries `_meta.ui.resourceUri` as a route
   Continue could mount if it ever negotiated MCP Apps — but since Continue's
   client has no `ui://` renderer today, that pointer goes unused and the
   plain text/JSON `content` (plus the viewer URL/`file://` fallback) is what
   the user actually sees, matching the "Continue never negotiates MCP Apps"
   claim above.

`conjure` additionally requires `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY` and
skips cleanly without them, same as every other harness's smoke suite in this
repo.
