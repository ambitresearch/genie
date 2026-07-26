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

The budget is injectable rather than hard-wired so tests can exercise the "deadline elapses" path without waiting on the real production value (Copilot review on #246 — a test previously waited on the real 8s `KIT_CONTEXT_DEADLINE_MS`, adding 8s of real wall-clock time to every run that hit it).

### The HMR reload protocol

Wire the live-refresh channels and return a teardown function. Everything the browser touches is injectable so `hmr-client.test.ts` drives the whole thing in jsdom with fakes — no real socket, no real timers, no network:

- `win` — the window to bind `message`/`WebSocket` on (default `window`) - `location` — used to derive the WS URL (default `win.location`) - `WebSocketImpl` — the WebSocket constructor (default `win.WebSocket`) - `fetchImpl` — manifest fetch for the poll fallback (default `win.fetch`) - `setIntervalImpl` / `clearIntervalImpl` — poll timer seam (default `win`'s) - `manifestUrl` — poll target (default `MANIFEST_URL`) - `initialManifest`— baseline so the FIRST poll can already detect a change - `pollIntervalMs` — cadence (default `HMR_POLL_INTERVAL_MS`) - `parentOrigin` — optional trusted embedding-host origin; otherwise derived from `document.referrer` when available

The `postMessage` bridge is ALWAYS active (harmless where unused). The WS + polling only engage when {@link hmrSocketUrl} resolves (a real dev server); on `file://`/`ui://` there is nothing to poll, so we don't spin a timer against a static snapshot.

### Reading the inline manifest

Read the manifest inlined by the embedded `ui://genie/grid` tier (M4-06): a `<script type="application/json" id="manifest">` data island whose text content is the compiled manifest JSON. Returns the parsed object, or `null` when there is no such node (the `file://` / localhost tiers, which fetch instead) OR the node is present but not usable — wrong `type`, empty, or malformed JSON. A `null` return is the caller's signal to fall back to the network path; a malformed INLINE manifest deliberately degrades to that same fallback rather than throwing, so a corrupt payload surfaces as the normal error state, never an uncaught exception on the page.

Reading `type` guards against picking up an unrelated `#manifest` element and, more importantly, means only a genuine data block (never an executable `<script>`) is ever parsed here.

`elementId` defaults to `MANIFEST_ELEMENT_ID`; pass `MANIFEST_FULL_ELEMENT_ID` to read the full-kit island instead (Copilot review, PR #248 — see that constant's own comment).

### Resolving the preview file to render

The file the preview pane and the marker check actually read.

`findPreviewFile` above is the strict CONVENTION check — it answers "does this draft name its entry point `<Name>/<Name>.html`?", and the `preview-file` checklist row exists to report exactly that. It is the wrong question for _rendering_: the manifest compiler cards every `.html` under `components/` and derives `name` from the file's own basename (server `manifest/compiler.ts` — `walkPreviewFiles` + `deriveName`), so a kit whose entry point is `Button/preview.html` is perfectly legitimate and can never satisfy the canonical form.

Before Copilot #2 (PR #250) this never surfaced, because a Browse handoff FABRICATED a canonical path. Now that the draft carries the path Browse really read, resolving the render target has to tolerate the real world: canonical when it exists, otherwise the sole HTML entry. Ambiguity (two or more HTML files, none canonical) still resolves to nothing rather than guessing which one the reviewer is looking at.

### Section display order

Section display order (DRO-749 fix): prefer the manifest's own `groups` array — the compiler already resolved alphabetical-vs-`_groups.json`- pinned order server-side, so there is no reason to re-derive a (possibly different) order client-side — but ALWAYS append any group actually present in `grouped` that `declaredGroups` omitted, in first-seen order. Mirrors the server's own `orderGroups` "remainder" logic (`packages/server/src/manifest/compiler.ts`): "an incomplete pin list never silently drops a group." Without this, a valid-but-partial `groups[]` (e.g. a hand-edited or stale manifest listing only some of the groups `components[]` actually uses) would cause `renderGrid` to silently drop every component in an undeclared group — worse than the plain first-seen order this replaces. When `declaredGroups` is absent, empty, or entirely malformed, this degrades to pure first-seen order among `grouped`'s own keys (every group is then "remainder").

### iframe `src` normalization (CodeQL alerts 2/4/5/7)

CodeQL alerts 2/4/5/7 (js/xss-through-dom, js/xss, js/client-side-unvalidated-url-redirection) — every iframe `src` we assign traces back to attacker-reachable data: a manifest-supplied `card.path`, a `data-src` re-read from the DOM, or a `freshSrc` riding an HMR postMessage that any frame in the tree can send. The preview sandbox (allow-scripts, deliberately NO allow-same-origin) contains the blast radius, but that is defence in depth, not the guard.

The WHATWG URL parser removes ASCII tab/LF/CR from ANYWHERE in a URL and trims leading and trailing "C0 control or space" BEFORE it detects the scheme, so `java\tscript:alert(1)` and " javascript:alert(1)" both parse as `javascript:`. Normalize exactly the same way first, or a scheme allowlist is trivially bypassed. Then allow relative paths (the common case) plus http/https/data — `data:` is a real embedded-manifest transport and lands in an opaque origin. Protocol-relative `//host/x` is rejected: it is off-origin but carries no scheme to match.

### Broker-served draft previews (#257)

When the server publishes a `previewUrl`, the review frame **fetches** the draft rather than
inlining it. A fetched document gets the broker's own response-header CSP — sha256 hashes over the
exact bytes it serves — whereas `srcdoc` can only inherit the embedder's, which was minted before
this draft existed.

`DRAFT_PREVIEW_SRC_RE` is anchored end to end against the one shape the broker mints: loopback
host, `/d/`, a 16-byte hex token. The port group is **optional**, because `authorityFor` omits the
port when it is 80 and a broker bound there mints `http://127.0.0.1/d/<token>`; requiring a port
would silently drop that draft back to `srcdoc`. The alternation spells out the exact 1-65535 range
`parsePort` enforces — a looser `[0-9]{1,5}` would accept authorities the broker can never bind,
which is precisely what a barrier exists to exclude. The pattern is kept a **literal** rather than
an assembled `new RegExp`, because CodeQL has to parse it to accept `isDraftPreviewSrc` as a barrier
guard on the iframe-`src` sink, and a concatenated source string is not reliably constant-folded for
that analysis. `isDraftPreviewSrc` is split out and called in **guard position** for the same reason
as `isSafeFrameSrc`: static analysis clears taint at a guard, not at a transformer.

`previewUrl` is only **type**-checked at validation time. Whether a URL may aim the frame is decided
by `isDraftPreviewSrc` at render time; rejecting a bad URL during validation would destroy an
otherwise good draft and move the security decision off the sink CodeQL tracks. The server declares
it `z.string().optional()`, and `applyDeterministicTweak` clears it by _assigning_ `undefined`, so
the key survives `Object.keys` and the strict allowlist must tolerate it.

A tweak inherits nothing: the broker published the **parent's** bytes, and a tweak rewrites them
locally without ever reaching the broker, so inheriting the URL would make the frame fetch the
pre-tweak document while Apply writes the tweaked one. Clearing it drops the draft to `srcdoc`,
which renders exactly the bytes Apply will write.

The broker keeps only the newest 32 drafts, but the viewer's history is unbounded and every entry
stays reselectable. An evicted document answers 404, and an iframe fires `load` — not `error` — for
HTTP responses, so the frame would report a blank page as a successful render. Nothing client-side
can detect this: the broker sets no CORS headers, so a preflight `HEAD` is impossible, and its
origin is cross-origin, so `contentDocument` is unreadable. The broker therefore _names_ what it
dropped in `expiredPreviewUrls`, and the viewer forgets those URLs so the draft falls back to the
`srcdoc` bytes the store already holds.

The viewer validates that list on the way in. `expiredPreviewUrls` is accepted only when it is
absent, or an array of at most `MAX_EVICTED_PREVIEWS` entries that each pass `isDraftPreviewSrc`.
The cap is the broker's own `MAX_LIVE_DRAFTS` capacity (32): the broker holds at most that many
drafts, so an honest registration can name at most that many as gone, and a list longer than the
broker could ever mint is treated as malformed. Pinning the cap to broker capacity — not to the
one-per-registration steady-state rate — means a legitimate result is never rejected even if the
cap later shrinks across versions. The bound matters because `retireExpiredPreviews` walks the list
once for every entry in the viewer's unbounded draft history, so an unchecked oversized list is
quadratic and can lock the UI before the new draft renders. An over-long list, or any entry that is
not the broker's own URL shape, fails the whole result closed — the same fail-closed rule every
other field's validator follows — rather than being silently trimmed.

### `files[]` entry validation (DRO-242)

DRO-242 (fail closed, Copilot review round 6) — JSON Schema's `maxLength`/`minLength` count Unicode CODE POINTS, but JS `String.length` counts UTF-16 CODE UNITS — every character outside the Basic Multilingual Plane (astral characters: most emoji, some CJK extensions) is one code point but TWO code units (a surrogate pair). A schema-valid string near either bound (e.g. exactly `maxLength` emoji) would be wrongly accepted/rejected by a raw `.length` comparison. Counting via the string iterator (`for...of` / spread) is code-point-aware — it steps over full surrogate pairs — and this early-exits once `max` is exceeded rather than materializing an array for a large string.

### Validating a Browse baseline on its own terms (Copilot review round 9)

A draft can reach Review by two very different roads, and only one of them involves a model. `conjure`/`refine` return a generated payload that owes the full model-output contract: a `manifestEntry`, a token `usage`, and the canonical `<Name>/<Name>.html` naming rule (`hasMatchingHtmlPreview`, mirroring `HTML_FILE_CONTAINS` in `packages/server/src/llm/schema.ts`). A Browse handoff is the opposite: it is bytes that already exist in the kit, read straight off disk, with no generation step behind them.

Routing both through `isConjureResult` meant every Browse baseline failed the `schema` checklist row permanently, which pinned the Apply gate shut — and because `applyDeterministicTweak` copies every own key of its parent and adds a recomputed `diff`, a tweak of a Browse baseline inherited the same unsatisfiable shape and could never enable Apply either.

Fabricating a zero-token `usage` to make the conjure predicate pass would have been cheaper, but it would put a lie in the draft summary's Tokens row. Instead the shared structural rules live in `hasReviewableCore` (plain object, `componentName`, `group`, 1–12 valid `files[]` entries, unique paths) and each road adds only what it genuinely owes:

- `isConjureResult` = core + exactly `{componentName, group, files, manifestEntry, usage}` + the canonical HTML naming rule + a valid `manifestEntry` + a valid `usage`.
- `isBrowseBaseline` = core + exactly `{componentName, group, files, diff?}` + at least one `.html` file so the preview pane has something to render + a `diff` that, when present, is a string within `DIFF_MAX_LENGTH`.

The naming rule deliberately moved out of the shared core. `Card/preview.html` is a legitimate kit entry point that the compiler's own `walkPreviewFiles` accepts, so it can never satisfy `<Name>/<Name>.html`; demanding that of existing kit source would fail valid kits. It still applies to conjure and refine output, where it is a real constraint on what the model must return.

### `manifestEntry` validation (DRO-242)

DRO-242 (fail closed) — validates `manifestEntry` against conjure's canonical output schema (`packages/server/src/tools/conjure.ts` / `packages/server/src/llm/schema.ts`'s `Viewport` $def): `viewport.width`/ `viewport.height` are required integers in `[1, 4096]` (Copilot review round 5 — a bare `typeof === "number"` check still accepted fractions, `0`/negatives, values above 4096, `NaN`, and `Infinity`, none of which the canonical schema permits), and both `manifestEntry` and `viewport` are `.strict()` — no keys beyond `viewport`/`subtitle`/`tags` (resp. `width`/`height`) are allowed. `subtitle` (`maxLength: 256`) and `tags` (`maxItems: 16`, each a string) are optional but, when present, must respect those same bounds. An object-like-but-empty `manifestEntry: {}` (missing `viewport` entirely) must be rejected, not just checked for being a plain object.

### `conjure` reply validation (DRO-242)

DRO-242 (fail closed, Copilot review round 4) — validates an untrusted `conjure` host reply against the FULL canonical `COMPONENT_SCHEMA` (`packages/server/src/llm/schema.ts`) shape, not just field presence: `componentName` must be PascalCase (`^[A-Z][A-Za-z0-9]{1,63}$`), `group` kebab-case (`^[a-z0-9-]{1,32}$`), `files` bounded to 1-12 entries with at least one self-consistent `<Name>/<Name>.html` preview (AC5's `contains` rule), and every `files[]` entry/`manifestEntry`/`usage` individually validated against their own strict nested shapes. Earlier rounds closed the "missing field" and "extra key" gaps; this round closes the "right shape, wrong content" gap Copilot flagged — a name like `"Status card"` (lowercase, space) or an oversized/no-`.html` file set still had every key present with the right JS `typeof`, but is exactly the malformed-payload case AC3-AC5 exist to reject.

### `files[]` entry validation (DRO-242)

DRO-242 (fail closed) — a single `files[]` entry from an untrusted host reply, validated against conjure's canonical output schema (`packages/server/src/tools/conjure.ts`'s `conjureOutputShape` plus `COMPONENT_SCHEMA`'s `files[]` item shape in `packages/server/src/llm/schema.ts`): `path` must match the `components/<group>/<Name>/<basename>` layout, `content`/`mimeType` are required non-empty strings (`mimeType` further constrained to the `type/subtype` pattern), and `encoding` is restricted to `"utf-8"` or `"base64"`. A reply missing any of these (or supplying an unrecognized encoding, a malformed path, or any extra key beyond this strict shape) is structurally invalid and must be rejected here rather than passed through on the strength of the two fields the viewer happens to use.

### `initBrowseController` responsibilities

Wire the tree + detail panes together against a live manifest: owns the current selection (deep-link-aware — Decision #7), re-projects the tree on search/manifest changes, and re-renders detail atomically on selection (AC5 — "stale content from the prior selection is not shown as current", satisfied because both panes are rebuilt from the SAME `tree`/`selection` read on every call, never patched piecemeal).

Used by BOTH vehicles now (Copilot #1): the fetch tier calls this with `hostBridge: null` (no MCP host), and the embedded `ui://genie/grid` tier calls it with the real host bridge once the handshake resolves (`setHostBridge`), so Refine/source-read still route through the host (AC12/AC13). Call sites are gated on `#browse-workbench` existing, which only the fixture-only grid tests omit.

### Structural manifest changes

True when component membership/order OR declared group order changed — i.e. the grid itself must be torn down and rebuilt. Deliberately excludes `hash` (a real per-card reload via `diffManifestHashes` is enough) AND excludes `tags`/`subtitle`/`lastModified` — those never change what the GRID renders, only Browse's detail panel (see `manifestBrowseMetadataChanged` for that comparison). Critically, `lastModified` is derived from `stat(absPath).mtime` on every compile (`packages/server/src/manifest/compiler.ts`), so it changes on EVERY real edit; including it here would force the expensive full-grid `renderManifestUpdate` path on every ordinary content-hash-changing edit instead of the lightweight per-card `reloadCardByPath` path.

### Browse metadata-only manifest changes

True when any Browse-rendered metadata field (`tags`, `subtitle`, `lastModified`) changed for any component, independent of `hash`/ structural identity.

Copilot review (PR #248) — Browse's detail panel (`renderBrowseDetail`) renders `tags`, `subtitle` (breadcrumb), and `lastModified` straight from the manifest; a manifest update that changes ONLY one of those (no path/name/group/viewport/hash change) was invisible to both `manifestStructureChanged` and `diffManifestHashes`, so `onManifestUpdate` never fired and the visible Browse detail went stale. This is checked SEPARATELY from `manifestStructureChanged` (rather than folded into it) so it only ever triggers Browse's own re-render, never the full-grid rebuild path — see that function's doc for why `lastModified` in particular must stay out of the grid-rebuild decision.

### Viewer boot and manifest source

Boot the viewer: obtain the manifest, render the grid, and wire the `#q` search input to live-filter (AC5). Resolves (never rejects) so a caller / the browser auto-boot can `await` it without an unhandled rejection; on any failure it paints the error state instead.

── Manifest source: inline first, then fetch (M4-06 / DRO-268) ──── The embedded `ui://genie/grid` tier inlines the manifest into the document (`<script type="application/json" id="manifest">`) because its CSP (`connect-src 'none'`) blocks `fetch` entirely. So `boot` reads the inline node FIRST and, when present, renders straight from it — issuing NO network request. Only when there is no inline node (the `file://` / localhost tiers) does it fall back to `fetch(MANIFEST_URL)`. This keeps `viewer.js` byte-identical across all three vehicles (RFC G-5) while honouring each tier's transport.

### Guaranteeing a non-empty accessible name

`accessibleName(value, fallback)` returns `value` trimmed, or `fallback` when it is missing,
empty, or whitespace-only. It is used for the two places M4-09 needs a GUARANTEED non-empty
accessible name: the card's `aria-label` (axe-core's `link-name` rule flags a `role="link"` with
no accessible name as a CRITICAL violation — and an empty string `aria-label=""` counts as "no
name", it does NOT fall back to the element's text content) and the iframe's `title` (axe-core's
`frame-title` rule, same "empty is not acceptable" contract). A card whose upstream manifest
carries `name: ""` (schema-legal — `store/manifest.ts` only requires `z.string()`, not a
non-empty one) must still render an accessible, non-violating card rather than silently produce
an unnamed link/frame.

### A `data:` URL is only inert on an image attribute

The draft CSP scan exempts `data:` and `#` from its "reaches the network" patterns, because those
are the only two forms that can resolve inside a card. That exemption is correct only for
IMAGE-bearing attributes. The embedded card policy (`packages/server/src/ui/card-asset-broker.ts`)
is `default-src 'none'; img-src 'self' data: blob:; connect-src 'none'; font-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'` — it has no `media-src` and no
`frame-src`, and `object-src` is explicitly `'none'`. So `<video src="data:…">`, `<audio src>`,
`<source src>` and `<track src>` fall through to `default-src 'none'`; `<object data>` and
`<embed src>` hit `object-src 'none'`; and a nested `<iframe src>` falls to `default-src 'none'`
as well. All are blocked exactly as hard as a remote URL would be, so passing them ships a card
that renders broken behind a green gate.

`BLOCKED_DATA_URL_RE` therefore re-blocks `data:` on precisely those elements, matched on the
`src` or `data` attribute only. `poster` and `srcset` stay exempt because both resolve against
`img-src`, which does permit `data:`. Requiring `\s*=` immediately after the attribute name is
what keeps `srcset=` and `data-*` attributes out of the match.

### Enforcing strict object shapes in the viewer

DRO-242 (fail closed, Copilot review round 3) — the server's canonical shapes for `files[]`
entries, `manifestEntry`, `manifestEntry.viewport`, `usage`, and the top-level `conjure` result
all declare `.strict()`/`additionalProperties: false` (`packages/server/src/tools/conjure.ts`'s
`conjureOutputShape`, `packages/server/src/llm/schema.ts`'s `COMPONENT_SCHEMA`). A
field-by-field/`isPlainObject` check alone does not enforce that — `{ ...valid.usage, unexpected:
true }` has every required key with the right type, so it still passed. `hasOnlyKeys` makes every
one of those checks reject any key outside its known set, closing that gap for good rather than
only checking presence of the expected fields.

### Focusing the right Browse navigation control at every breakpoint

Copilot review (PR #248) — the removed-selection focus fallback used to try ONLY the full tree's
`[tabindex="0"]` treeitem, then the search input. At the responsive breakpoints below 1100px,
though, that treeitem still exists in the DOM but is hidden (`visibility: hidden` in the
720–1099px rail-overlay mode, `display: none` in the sub-720px compact mode) — so `.focus()` on it
silently failed, and neither the rail toggle nor the compact `<select>` (the ACTUAL visible
navigation control at those widths) was ever tried before falling through to search. Walk the
candidates in specificity order and focus the first one that's both present and visible.

### Repainting Browse source text without tearing down the preview

Updates ONLY the source subpanel of an already-rendered detail pane, in place — leaving the
breadcrumb/heading/variant tabs/preview iframe untouched. Used by the async source-read settle
handler (guarded by the caller's render-generation check) so resolving a source read no longer
tears down and re-fetches a perfectly valid live preview iframe just to paint the source text
underneath it (Copilot review, PR #248).

Falls back to a full `renderBrowseDetail` re-render if the subpanel marker isn't found (e.g. an
older/differently-shaped container), so behavior degrades safely rather than silently doing
nothing.

### A route change must never strand the apply dialog

The apply-confirm dialog makes the rest of the shell unreachable while it is open: `inert` and
`aria-hidden="true"` go onto the review layout, the segmented control, and `.app-header`. Only the
first two live inside `#review-view`. `.app-header` is persistent chrome that sits outside every
`[data-route-view]`, so hiding the review view does not hide it.

That matters because `popstate` — the browser Back and Forward buttons — calls `renderRoute`
directly, bypassing the in-app `navigate` helper and never touching the dialog. Pressing Back with
the dialog open therefore hid `#review-view` (and, as its child, the dialog) while leaving the
header visible but `inert` and `aria-hidden`: the whole navigation silently unreachable by
keyboard and invisible to assistive technology, with no dialog on screen to explain why. Focus was
also left on the dialog heading inside a subtree that had just been hidden.

`renderRoute` is the single choke point every route transition passes through, so it dismisses the
dialog there whenever the incoming route is not `review`. Re-rendering Review itself leaves a
legitimately open dialog alone.

The dismissal deliberately does not restore `dialogReturnFocus`. That target is the Apply button,
which lives inside the view the route change is about to hide, so restoring it would simply move
the problem. Instead the dialog's own focus is blurred, matching what a browser does when the
focused element's subtree becomes hidden, and the incoming route's normal focus handling takes
over. `closeApplyConfirm` distinguishes the two cases on a strict `=== true` flag because it is
also registered directly as a click listener, where the first argument is an `Event`.

### The apply dialog is bound to the viewport

Apply is the one irreversible step in the review workflow, so its confirmation dialog has to stay
operable on every viewport — including the 320×256 CSS px floor that WCAG 2.2 AA §1.4.10 Reflow
defines as 400% zoom of a 1280×1024 desktop.

The overlay is `position: fixed`, and that changes the consequence of overflow. In normal document
flow a too-tall element merely spills and the page scrolls to it. Here the panel does not move when
the page scrolls, and the background is `inert`, so anything past the fold is not off screen — it is
unreachable. Measured in Chromium at 1024×400 with a realistic file list, the panel ended 62px below
the fold with Cancel and Write both inside that band, and scrolling the page by 784px moved them by
exactly 0px.

The panel is therefore capped with `max-height: 100%` and made a scroll container. Capping alone
would only move the clipping inside the border, so the two declarations are a pair. `100%` resolves
against the overlay's content box rather than the viewport, which preserves the overlay's
`--space-lg` gutter; `100vh` would also stop the spill, but by welding the panel to the screen edges
on exactly the viewports that can least afford to lose the breathing room.

The nested file list keeps its own `max-height` cap. On roomy viewports that cap is what scrolls and
the panel never overflows at all; the panel's own scrolling is the safety net for the short-viewport
case the inner cap cannot rescue.
