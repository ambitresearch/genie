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

## Review, approval, and Apply transaction

The Review surface keeps proposed component bytes in viewer memory as session drafts.
`draft #N` is immutable: accepted refine output or a supported deterministic tweak creates
`draft #(N+1)` rather than mutating the prior draft. The viewer keeps the last good draft
selected on refine, render, preflight validation, planning, writing, post-write validation,
refresh, or host failures. Drafts are not durable across page reload.

The state machine is explicit:

```text
baseline
  └─ Generate or Refine succeeds → draft #N (unapproved)
       ├─ Request Changes → current draft, refine input focused, no mutation
       ├─ refine/tweak/selection change → draft #(N+1), approval invalidated
       ├─ Approve + gates green → approved draft
       │    └─ Confirm Apply → plan → write_files → applied
       │       (kit validation advisory; refresh gates only the "live in Browse" claim)
       └─ discard/navigate → confirmation when unapplied work would be lost

Any failure → remain on the last good draft; never report a false applied state.
```

Approval is stored against the current draft identity. Any new draft, deterministic
change, file-set change, or selected-draft change invalidates it structurally; Apply
cannot infer approval from focus, checklist color, or draft existence. **Approve** and
**Request Changes** perform no persistence.

Checklist rows are backed by real inputs:

| Check                            | Source                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `@genie` first-line marker       | proposed preview file bytes                                                  |
| `<Name>/<Name>.html` consistency | proposed file paths and component identity                                   |
| UI-kit containment               | proposed paths under `components/<group>/<Name>/` for the selected kit       |
| Structured output schema         | normalized `conjure`/`refine` result                                         |
| Embedded-tier CSP safety         | proposed HTML/CSS bytes; no remote subresources, web fonts, or inline script |
| Preview rendered                 | actual draft iframe render result                                            |
| Kit-wide validation              | deferred, advisory `validate` tool result after Apply                        |
| Visual/a11y spot-checks          | explicit manual acknowledgement                                              |

The pre-Apply gate may use only checks that can run against the proposed draft bytes and
runtime render result. Kit-wide `validate` scans the UI kit on disk, so it remains pending
before Apply and is never shown as green before a write. After the write, kit-wide
validation is advisory rather than gating: a kit-wide `validate` call can return its
payload only in `content[].text` with no `structuredContent`, which the viewer's MCP host
bridge requires, so validation can be unavailable without turning a successful write into
a reported failure. A non-zero `bad` count is also not evidence that the just-applied
component is broken — a freshly seeded kit already fails its own marker check against its
seed `index.html`.

Apply has one persistence path: after explicit user confirmation, call `mcp__genie__plan`
with the exact write/delete path scope, call `mcp__genie__write_files` with the returned
`planId` and the exact approved draft payload, then run kit validation and refresh the
manifest/preview. Generate, Refine, Approve, Request Changes, deterministic controls,
selection, and navigation must not call `plan`, `write_files`, or `delete_files`.

Refine calls `mcp__genie__refine` with `{kitId, componentName, instruction, region?,
model}` and reads the component from the kit. A newly generated draft is therefore not
refinable until it has been applied to the UI kit; the viewer must disable Refine with
that reason rather than simulate a client-side edit.

Failure recovery is fail-closed for the write path. Invalid model output, missing
components, expired or missing plans, path rejection, partial or failed writes, and host
disconnects during planning or writing keep the last good draft available, display the real
reason after redaction, and require a fresh confirmation before a new plan is made.
Post-write kit validation failures and refresh failures are different: the write already
succeeded, so recovery is never a new plan or write — the viewer reports the write as
complete but unverified when `validate` throws or returns findings, or as possibly stale
when the manifest/preview refresh fails instead.

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

### Viewer script constraints

`packages/viewer/static/viewer.js` is the one script every preview vehicle boots into, so a
handful of constraints shape almost every decision in it.

**Classic script, not an ES module.** `index.html` loads it via `<script src="./viewer.js">`
with no `type="module"`. It shipped briefly as a module, and that broke the `file://` vehicle
outright: every `file://` document gets an opaque, distinct origin, so the ES module loader's
same-origin check fails and the script never executes ("blocked by CORS policy" in a real
headless Chromium run). Dynamic `import()` fails identically. A classic script runs the same
under `file://`, the Vite dev server, and inside a sandboxed iframe — the only option that
satisfies byte-identity across vehicles. Modern syntax (`const`/`let`, arrows, template
literals, optional chaining, `async`/`await`) is all still available; only `import`/`export`
are off the table, and this is the only script in the kit tree.

**Manifest contract.** The shipped compiler emits
`{version, name, generatedAt, groups: string[], components: [{name, group, path, viewport,
hash, lastModified}]}` at `.genie/manifest.json` — not the `cards[]` shape the original
research sketch used. `viewport` is the RAW marker string, either `"WxH"` or a named token
kept opaque. `list_components` parses `components` and would throw on a `cards` key, so the
viewer reads `components[]` and parses the string viewport itself.

Section order prefers the manifest's own `groups: string[]`, which the compiler already
resolved from `_groups.json` server-side. `computeGroupOrder` always appends any group present
in the components that the declared list omitted, mirroring the server's own remainder logic,
so a partial or absent `groups[]` never silently drops a group's cards.

**Pure functions plus a guarded auto-boot.** Every function takes its `document` (and `fetch`)
as an argument and returns DOM rather than reaching for ambient globals, so tests can drive the
whole script inside a programmatic jsdom window. Because a classic script cannot be imported
for its bindings, the pure helpers are exposed on `window.__genieViewerTestHooks` — but only
when that object already exists before the script runs, which only a test harness arranges.
Production pages never define it, so nothing is exposed and the shipped page carries no
footprint.

**Security and accessibility.** Each preview iframe is `sandbox="allow-scripts"` with no
`allow-same-origin`, so a compromised preview cannot reach the viewer's origin, cookies, or
storage. Card names are written via `textContent`, never `innerHTML`. Each card is a
keyboard-operable `role="link"` with `tabindex="0"`, an explicit `aria-label` (without one a
screen reader concatenates heading, group pill, and viewport into one run-on name), and a
`keydown` handler — `role="link"` supplies semantics but never key handling. The card's iframe
is pulled out of Tab order with `tabindex="-1"`, because a sandboxed iframe without
`allow-same-origin` is still natively focusable; otherwise Tab order would alternate card,
iframe, card, iframe.

## Transport and authentication

Stdio relies on the harness-owned child-process boundary. HTTP exposes `POST /mcp` and
`GET /health`, with optional static Bearer enforcement, genie's OAuth server, or upstream
OIDC verification. See [Security model](security.md).
