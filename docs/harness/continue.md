# genie in Continue.dev

Continue speaks MCP over stdio, SSE, and Streamable HTTP. Two configuration
details are worth calling out:

- **`type` is optional in current Continue.** Continue's official stdio
  quick-start omits it, and the schema shipped with Continue CLI 1.5.47 marks
  `type` optional for both command- and URL-keyed servers. The snippets below
  keep `type` explicit because it makes the intended transport unambiguous to a
  reader. If omitted, a `command` entry selects stdio; a URL entry tries
  Streamable HTTP and then falls back to SSE.
- **Continue interpolates secrets as <code v-pre>${{ secrets.NAME }}</code>.** For remote MCP
  authentication, put the resulting header under `requestOptions.headers`.
  Continue resolves the placeholder from its secrets sources at config-load
  time; never put a literal token in the YAML.

Behavior and version were rechecked against the published
`@continuedev/cli@1.5.47`, Continue's
[CLI documentation](https://docs.continue.dev/cli), and its current
[`mcpServerSchema`](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/mcp/index.ts)
on 2026-07-15.

## Register the server

Continue reads a full config passed to `cn --config`, the user-level
`~/.continue/config.yaml`, or standalone project blocks under
`.continue/mcpServers/`. This is the canonical block for a deployed genie
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

`type: streamable-http` is explicit here to document intent, not because the
current schema demands it. <code v-pre>${{ secrets.GENIE_TOKEN }}</code> resolves from
Continue's secret sources, including a matching environment variable for local
CLI use. Never hardcode a bearer token in `requestOptions.headers`.

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

The explicit `type: stdio` is likewise optional. The LLM base URL must end in
`/v1`; route both values through Continue secrets rather than literal YAML
values. The genie server also requires `OAUTH_HS256_KEY` at startup; provide it
through the process environment or add another <code v-pre>${{ secrets.NAME }}</code> entry.

## MCP only works in agent mode

**MCP can only be used in agent mode.** Continue chat mode and autocomplete do
not offer MCP tools to the model. In the IDE, switch the session to agent mode
before asking it to run `conjure → plan → write_files → preview`.

Continue CLI 1.5.47 provides the same agent loop in scriptable headless form:

```bash
cn -p --config ./continue.yaml --allow "*" \
  "Use genie to build a button and preview it"
```

`cn -p` exits after the agent turn. Headless tools that need approval are
otherwise excluded, so automation must grant the intended MCP tools with
`--allow` (use narrower names than `"*"` outside an isolated smoke test).

## Using it in Continue

### Install the Agent Skill

Continue's current CLI and IDE code both load Agent Skills. `cn@1.5.47` scans
project-level `.continue/skills` and `.claude/skills`, plus the user-level
`~/.continue/skills` directory. The IDE's `read_skill` tool uses the parallel
`core/config/markdown/loadMarkdownSkills.ts` loader during config loading. For
a user-level install:

```bash
mkdir -p ~/.continue/skills
cp -R packages/plugin/skills/genie ~/.continue/skills/genie
```

For a project-only install, copy the same directory to
`.continue/skills/genie`. The Skill teaches the four-verb workflow; tool
descriptions remain the fallback when it is not installed.

### Preview behavior differs by surface

Current Continue IDE source includes both the `read_skill` loader and an MCP App
renderer. It consumes the tool-level `_meta.ui.resourceUri` that genie
advertises in `tools/list`, so the IDE can render the inline grid. The published
Continue CLI 1.5.47 is different only on rendering:
`cn` initializes its MCP client without the MCP Apps UI capability and passes
only the MCP result's model-visible `content` into the agent loop. That text
contains the viewer URL or `file://` fallback, not a `ui://` pointer. `cn` does
not mount an inline grid; open the returned URL to view the generated component.

## Smoke-testing a genie/Continue registration

`packages/e2e/test/m5-smoke-continue.test.ts` runs the published Continue CLI,
not a generic MCP SDK stand-in. The test:

1. Parses the canonical YAML blocks above and checks their explicit transport
   values and unresolved <code v-pre>${{ secrets.NAME }}</code> placeholders.
2. Starts `@continuedev/cli@1.5.47` as `cn -p` with a temporary config derived
   from the stdio block above. Continue itself loads the config, starts genie's
   built server, exposes its MCP tools, and invokes them through its headless
   agent loop.
3. Uses a deterministic loopback OpenAI-compatible model seam for both the
   Continue agent and genie's `conjure` call. It verifies one contiguous
   `conjure → plan → write_files → preview` flow: the generated file paths and
   bytes feed `plan` and `write_files`, the file lands on disk unchanged, and
   Continue CLI prints preview's plain-text result.

The deterministic leg needs no external model credentials and does not skip in
the dedicated command. Run it from a clean checkout with:

```bash
pnpm install --frozen-lockfile
pnpm --filter @ambitresearch/genie-e2e test:e2e:continue
```

That command builds `@ambitresearch/genie-viewer` and `@ambitresearch/genie` first and fails if
either the built server or the pinned Continue CLI is unavailable.
