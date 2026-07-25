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
       │    └─ Confirm Apply → plan → write_files → [delete_files] → applied
       │       (kit validation advisory; refresh gates only the "live in Browse" claim)
       └─ in-app route change → reversible; draft state remains in memory

Any failure → remain on the last good draft; never report a false applied state.
```

In-app route changes — a route link, or browser Back/Forward between genie's own routes — are
reversible: the Review store stays alive, so drafts, selection, approval state, and
acknowledgements survive. A full reload, tab close, or host teardown destroys that in-memory
session without warning. There is deliberately no `beforeunload` handler: a confirmation prompt
in the embedded tier would fire inside the host's own frame, and no M7-03 acceptance criterion
calls for one. Drafts are never persisted; Apply is the only durability boundary.

### Partial apply is not an apply

`write_files` and `delete_files` are separate server calls, so a refine that removes a file can
land its writes and still fail to remove the old one (for example `PathOutsidePlanError`). The
viewer never reports that as a failed apply — the new bytes really are on disk — but it also does
not stamp the draft as applied. Stamping it would raise the "already applied" blocker, which is the
one control that could finish the removal. Instead `runApply` returns the stranded paths as
`stuckDeletes`, the status line names them and says the removal can be retried, and the Apply gate
stays open. `write_files` is idempotent, so a retry costs a duplicate write of identical bytes.

### The post-apply refresh is awaitable

`confirmApply` awaits its `onApplied` callback before it claims the component is live in Browse.
`browseController.openComponent()` therefore returns a promise that settles only once the host's
`read_file` for the applied component resolves, and **rejects** when that read fails or comes back
unusable. A rejection is surfaced as AC14's "written, but the view is stale" note, never as a
failed apply. Returning `void` here would make that path unreachable and let a stale panel be
reported as a live one.

`openComponent`'s optional `kitId` argument is in **Browse's own namespace** — the manifest `name`
the boot seeded — not the server's kit id, which is a UUID. `Manifest` carries no id field, so the
two identifiers are not comparable and the post-Apply handoff passes none; see issue #254.

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
| Preview document parsed          | sandboxed draft iframe `load` event; proves parse, not paint                 |
| Kit-wide validation              | deferred, advisory `validate` tool result after Apply                        |
| Visual/a11y spot-checks          | explicit manual acknowledgement                                              |

The pre-Apply gate may use only checks that can run against the proposed draft bytes and
runtime parse signal. Kit-wide `validate` scans the UI kit on disk, so it remains pending
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

### Per-card HMR refresh

`viewer.js` refreshes a single preview card in place (M4-04 / DRO-266). Two transports feed one
pure dispatcher, `applyHmrMessage`:

1. **A WebSocket on `/__genie_hmr`** (AC1/AC2) — the primary channel on the Vite dev server
   (`http(s)://…`). The server plugin (`src/hmr-plugin.ts`) pushes `{event:"card.changed",path}` /
   `{event:"tokens.changed"}` off Vite's own file watcher.
2. **`window` `postMessage`** — the bridge for the embedded `ui://` tier, where the grid runs
   inside a host iframe under strict CSP (`default-src 'none'`, coordinated with DRO-269) that may
   forbid a direct WebSocket. A host forwards the same refresh signal as a message; the viewer
   accepts both the WebSocket shape and the research sketch's `{type:"refresh", id|path}` shape.

**Why src-reassignment, not `iframe.contentWindow.location.reload()`** (which AC2 literally names):
every preview iframe is `sandbox="allow-scripts"` with **no `allow-same-origin`** (M4-03 AC3, a hard
security rule), so it has an opaque origin and touching `contentWindow.location` throws
cross-origin. Reassigning `src` with a fresh cache-bust token is the cross-origin-safe equivalent
with the identical observable outcome: only that one iframe refetches its `preview.html` and
reloads; the grid never re-renders and no sibling card reflows (AC3 — the sub-100 ms, one-card-only
guarantee is structural, not a timing hack). `data-path` stays the stable identity the bridge
matches on; the `?__genie_hmr=N` token rides only on the live `src`.

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

### Browse responsive navigation

At the 720–1099px breakpoint Browse renders a 44px group rail whose activation opens an
identifiable overlay tree, rather than only shrinking every row label to its first letter — which
left same-initial components visually indistinguishable and offered no way to open real navigation.
`.tree-sidebar`'s CSS at this breakpoint hides `#browse-tree-nav` off-canvas by default and only the
rail toggle is visible; activating it reveals `#browse-tree-nav` as a real overlay
(`browse-tree--overlay-open`) without covering focus invisibly. The toggle itself is the 44px rail
control, and its `aria-expanded` / `aria-controls` make the relationship programmatically
discoverable.

The rail toggle, the overlay tree, and the <720px compact nav are always built, including for the
empty-kit and no-match states. An earlier revision returned before building any of this responsive
chrome for those two states, so at 720–1099px — where `.tree-sidebar` collapses the raw sidebar
column to 44px — their message plus Clear-filter/Generate action rendered directly inside that 44px
column instead of inside the overlay, risking unusable or overflowing layout. Empty and no-match
content is now placed inside the tree element, so it participates in the same rail, overlay, and
compact-nav responsive behaviour as the real tree.

### Browse preview failure detection

An `<iframe>` does not reliably emit `error` for a failed navigation. Per spec and observed browser
behaviour, a 404/500 response — or even most CSP `frame-ancestors` blocks — still fires `load` once
the error document finishes loading. `error` only fires for lower-level failures such as DNS or
network refusal, which the same-origin preview path essentially never hits, so a pure `load`/`error`
listener pair mislabels most real preview failures as a successful default preview.

The pragmatic mitigation: `component.path` is always a same-origin, server-relative URL, so it is
probed with a same-origin `fetch` before the iframe is pointed at it. An HTTP-level failure response
is a reliable signal that `load` cannot give us. If the probe cannot run at all — no `fetch`, for
example under a stripped test `defaultView` — this degrades to the original `load`/`error`-only
behaviour rather than ever blocking the preview outright.

Residual limitation: this cannot detect a navigation that fails after an initial 200 (the iframe
document errors out client-side once loaded), nor a same-origin response whose body renders as a
blank or broken page while returning 200. A fetch-level check only sees the HTTP status, not the
rendered result, so those remain indistinguishable from a real successful preview.

### Some calls take no client deadline

Sentinel passed as `callTool`'s `callTimeoutMs` for the conjure call: "do not apply a client-side deadline to this request" (genie#241 / genie#243 Copilot review).

A prior fix here picked a fixed 150s client deadline — 30s past the server's then-`DEFAULT_LLM_REQUEST_TIMEOUT_MS` (120s) — reasoning that 150s must outlast one LLM call. That's wrong on two counts the Copilot review on #243 called out: (1) `GENIE_LLM_REQUEST_TIMEOUT_MS` bounds EACH HTTP attempt, not the call as a whole — `conjure` can run the schema-retry loop (`component-response.ts`, up to two full model calls) and each of THOSE is separately wrapped in `withRetry` (`llm/retry.ts`), which can make up to `1 + GENIE_LLM_RETRY_MAX` (default 4) attempts with exponential backoff between them; and (2) both the per-request timeout and the retry ceiling are operator-configurable env vars, so no fixed client-side number can be derived that's guaranteed to outlast every valid deployment's worst case — a slow-but-legitimate generation can still finish after any such constant has already rejected the call.

Rather than guess another (still-wrong) fixed ceiling, or thread the server's live env config across the postMessage boundary just to recompute one client-side number, the conjure call takes NO client deadline at all: `createHostBridge` skips scheduling a timer when this sentinel is passed, and the call resolves/rejects whenever the host actually answers `tools/call` — nothing here can time out early. Host lifecycle already covers the "genuinely stuck" case without a timer: `destroy()` rejects every pending call the moment the host tears the frame down (`ui/resource-teardown`), and the host's own transport-level request handling is what actually bounds a hung generation. Generic calls (list-kits, etc.) are unaffected — they keep the fixed 60s `DEFAULT_HOST_TOOL_TIMEOUT_MS` above, since those are cheap round trips with no LLM/retry variability behind them.

The same sentinel is reused for `refine` (same LLM/retry variability as `conjure`) and for the two mutating verbs `write_files` and `delete_files`. The mutating case is a different argument: those calls have no LLM behind them, but a client-side timeout there would leave the viewer unable to say whether bytes actually landed on disk — an ambiguity strictly worse than waiting for the host. Every OTHER verb in the apply pipeline keeps the fixed 60s deadline, including `plan` (runs BEFORE any side effect, so an early rejection is safe) and `validate` (advisory, runs AFTER the write inside a `try`/`catch` that degrades to `validation = null`) — genie#250 Copilot round 6.

### Building the kit context

genie#239 — resolve the SELECTED kit's real compiled context (tokens + primitives/components) instead of handing `conjure` just its display name. Reuses tools the viewer's host already exposes — `list_files`, `read_file`, `list_components` — so this needs no new server contract and `conjure`'s `kit` field stays the free-form string it already is (#233/M7-01: "reuse the existing conjure contract, this is not a redesign of the generation engine").

All tool calls (the two `list_*` calls, then every `read_file` call) run CONCURRENTLY and share one overall `KIT_CONTEXT_DEADLINE_MS` wall-clock budget — not the host bridge's full per-call timeout — so a slow or unresponsive host can delay `conjure` by at most that budget, not by minutes (Copilot review on #246).

Best-effort by design: any tool failure or deadline miss here (a host that doesn't implement these verbs yet, a slow kit, etc.) degrades to partial context, and total failure falls back to the OLD display-name-only behavior rather than blocking generation — losing kit-fidelity is strictly better than losing the ability to generate at all.

@param {{callTool(name:string,args:object):Promise<object>}} hostBridge @param {string} kitId @param {string} kitName @param {number} [deadlineMs] Overall wall-clock budget in ms. Defaults to `KIT_CONTEXT_DEADLINE_MS`; overridable so tests can exercise the "deadline elapses" path without waiting on the real production value (Copilot review on #246 — a test previously waited on the real 8s `KIT_CONTEXT_DEADLINE_MS`, adding 8s of real wall-clock time to every run that hit it). @returns {Promise<string>}

### The HMR reload protocol

Wire the live-refresh channels and return a teardown function. Everything the browser touches is injectable so `hmr-client.test.ts` drives the whole thing in jsdom with fakes — no real socket, no real timers, no network:

- `win` — the window to bind `message`/`WebSocket` on (default `window`) - `location` — used to derive the WS URL (default `win.location`) - `WebSocketImpl` — the WebSocket constructor (default `win.WebSocket`) - `fetchImpl` — manifest fetch for the poll fallback (default `win.fetch`) - `setIntervalImpl` / `clearIntervalImpl` — poll timer seam (default `win`'s) - `manifestUrl` — poll target (default `MANIFEST_URL`) - `initialManifest`— baseline so the FIRST poll can already detect a change - `pollIntervalMs` — cadence (default `HMR_POLL_INTERVAL_MS`) - `parentOrigin` — optional trusted embedding-host origin; otherwise derived from `document.referrer` when available

The `postMessage` bridge is ALWAYS active (harmless where unused). The WS + polling only engage when {@link hmrSocketUrl} resolves (a real dev server); on `file://`/`ui://` there is nothing to poll, so we don't spin a timer against a static snapshot.

@param {Document} doc @param {object=} options @returns {() => void} teardown

### Reading the inline manifest

Read the manifest inlined by the embedded `ui://genie/grid` tier (M4-06): a `<script type="application/json" id="manifest">` data island whose text content is the compiled manifest JSON. Returns the parsed object, or `null` when there is no such node (the `file://` / localhost tiers, which fetch instead) OR the node is present but not usable — wrong `type`, empty, or malformed JSON. A `null` return is the caller's signal to fall back to the network path; a malformed INLINE manifest deliberately degrades to that same fallback rather than throwing, so a corrupt payload surfaces as the normal error state, never an uncaught exception on the page.

Reading `type` guards against picking up an unrelated `#manifest` element and, more importantly, means only a genuine data block (never an executable `<script>`) is ever parsed here.

@param {Document} doc @param {string=} elementId defaults to {@link MANIFEST_ELEMENT_ID}; pass {@link MANIFEST_FULL_ELEMENT_ID} to read the full-kit island instead (Copilot review, PR #248 — see that constant's own comment). @returns {object | null}
