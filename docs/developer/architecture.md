# Architecture

genie is a pnpm monorepo with three primary packages:

- `packages/server`: the MCP server and published `@ambitresearch/genie` CLI.
- `packages/viewer`: the standalone and embedded preview renderer.
- `packages/e2e`: protocol, harness, browser, auth, Docker, and release contracts.

## Server composition

`createServer()` registers `ping` plus 19 workflow tools once for both stdio and
Streamable HTTP. The tools are split between UI-kit operations and project operations.

The default stores are filesystem-backed. `GENIE_KITS_ROOT`, `GENIE_PROJECTS_ROOT`, and
`GENIE_REPORTS_DIR` select their roots. Store interfaces provide injection seams for
tests and alternate backends while keeping tool registration transport-independent.

## Generation and persistence

`conjure` and `refine` use a configurable OpenAI-compatible chat-completions endpoint.
Replies are parsed against the component schema and validated before returning to the
host. Generation does not write files.

Persistence crosses a separate plan boundary. `plan` records the authorized write and
delete globs; middleware checks the `planId`, expiry, and every requested path before
`write_files` or `delete_files` reaches the store.

## Validation and preview

The validation surface checks `@genie` markers, render constraints, and variant drift.
Preview delivery has two surfaces:

- `ui://genie/grid` for MCP-Apps hosts.
- A Vite-backed standalone viewer for local or URL-based fallback.

Cards remain byte-identical across `file://`, localhost, and `ui://`; host-specific
differences stay in the surrounding grid shell.

The surrounding viewer shell exposes Generate, Browse, and Review in every vehicle. In the
embedded resource, a small isolated JSON-RPC adapter sends `tools/call` requests for
`mcp__genie__list_kits` and `mcp__genie__conjure` to the MCP Apps host with `postMessage`.
This preserves `connect-src 'none'`: the document never fetches a model endpoint. Tool
results are normalized and checked before their exact `structuredContent` becomes a
session-only numbered draft. Standalone and `file://` rendering have no host adapter, so
Generate remains visibly read-only rather than attempting a browser network fallback.

Browse projects the SAME compiled manifest the M4 grid reads (`projectManifestToTree` in
`viewer.js`) into a 240px UI-kit tree plus a component-detail stage — no parallel catalog.
Selection is by stable `{kitId, group, componentName}` identity (never DOM/array index),
serialized to/from `URLSearchParams` so a deep link survives refresh. HMR re-resolves the
same selection identity against each fresh manifest (`initBrowseController`'s
`onManifestUpdate` hook off `initHmr`), so a live edit never resets an unrelated selection
or filter; a component that disappears renders a controlled "no longer available" state and
moves focus to the nearest valid tree row instead of leaving focus stranded. Source
inspection in an MCP-capable host reads through the existing `mcp__genie__read_file` tool
(the same host bridge Generate uses) — never a new fetch, preserving `connect-src 'none'`
in the embedded tier. The manifest carries no variant concept today, so variant tabs render
Default-only; Hover/Focus/Disabled are declared-but-disabled rather than a new, unreviewed
schema addition (`computeVariantTabs`).

## Transport and authentication

Stdio relies on the harness-owned child-process boundary. HTTP exposes `POST /mcp` and
`GET /health`, with optional static Bearer enforcement, genie's OAuth server, or upstream
OIDC verification. See [Security model](security.md).
