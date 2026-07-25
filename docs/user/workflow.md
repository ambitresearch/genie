# Component workflow

## Discover a UI kit

Use `list_kits`, `get_kit`, `list_components`, `list_files`, and `read_file` to inspect
the operator-owned library. `create_kit` scaffolds a new kit under `GENIE_KITS_ROOT`.

## Generate

`conjure` accepts a UI-kit description and a component prompt. It calls the configured
OpenAI-compatible endpoint, validates the structured reply, and returns proposed files.
It does not persist them.

In an MCP-Apps-capable host, open `ui://genie/grid` and use the **Generate** tab. The viewer
loads editable UI kits through `list_kits`, invokes `conjure` through the host tool bridge,
and opens the validated result as a session-only `draft #N` under **Review**. Generating a
draft never calls `plan`, `write_files`, or another persistence path.

The same shell remains available from localhost or `file://`, but Generate is intentionally
read-only there: browsers do not receive model credentials or a direct model endpoint. Use
the registered genie MCP server in your coding host to Conjure.

`refine` reads an existing component from a kit, applies a free-form change through the
same generation/validation path, and returns updated files plus a diff. It also does not
persist them.

## Review drafts before writing

Review is the safe handoff between a proposed component and your UI kit. A generated or
refined result is a **draft held only in the viewer session**. It is not on disk, and it
does not survive a page reload. Each accepted refine or deterministic tweak creates a new
immutable `draft #N`; earlier drafts stay available during the session, including when a
later refine fails.

The Review workspace has three areas:

- a session rail for generation/refine history and notes;
- a live preview stage for the current draft;
- a **Review & Refine** panel for the real change summary, validation checklist,
  deterministic controls when the component exposes them safely, refine input, decision
  controls, and Apply.

The change summary is derived from the proposed files and real diff. The validation
checklist distinguishes automated checks, pending checks, failed checks, and manual
acknowledgements; a partial run never appears fully green.

Automated pre-Apply checks include:

- `@genie` as the first-line marker on the preview file;
- a self-consistent `<Name>/<Name>.html` preview;
- proposed paths contained in the selected UI kit under `components/<group>/<Name>/`;
- structured output matching the expected schema;
- embedded-tier CSP safety: no remote subresources, no web fonts, and no inline script;
- the preview actually rendered.

Kit-wide validation is intentionally pending before Apply. genie's `validate` tool scans
the UI kit on disk, so it can only run after the draft has been written, and its result is
advisory rather than a gate: it can fail or be unavailable without turning a successful
write into a reported failure, and a non-zero result from scanning the whole kit does not
by itself mean the component you just applied is broken. Manual checks, such as visual
match to intent and an accessibility spot-check, require explicit acknowledgement.

### Refine from Review or Browse

Refine edits a component that already exists in your UI kit. The `refine` tool reads the
component's current source from the kit, so a brand-new generated draft cannot be refined
until it has been applied. In that state, Review disables Refine and explains: apply this
draft first, then refine it. Once the component is in the kit, you can refine it from
Review or from Browse.

Accepted refine results become new drafts and invalidate any previous approval. Failed
refines keep the last good draft selected and show the real reason, such as invalid model
output, a missing component, or a render failure.

### Approve and Request Changes

**Approve** records your decision for the exact current draft. It writes nothing.
**Request Changes** writes nothing, keeps the draft, and returns focus to the refine
input. Any new draft, deterministic tweak, or selection change clears the approval; review
and approve the new current draft before applying it.

### Apply to the UI kit

Apply is the only Review action that writes. It becomes available only when all of these
are true:

- the current draft is approved;
- required automated checks are green;
- required manual checks are acknowledged;
- the host has MCP write capability.

Apply first asks for confirmation. After confirmation, the host creates a scoped, expiring
plan naming exactly which paths may be written and writes the approved files atomically
with that plan. Once the write returns its written paths, Apply is reported as successful —
that write is the authoritative signal, not a later step. The host then runs kit validation
and refreshes the manifest and preview, but neither step can turn that success into a
failure. Generate, Refine, Approve, Request Changes, deterministic tweaks, and navigation
never call `plan` or `write_files`.

If Apply is unavailable, Review names every blocker. If the plan or the write itself fails
or the plan expires, the last good draft stays open and applicable, the real reason is
shown, and no success is reported; retry requires a fresh confirmation and a fresh plan.
Kit validation after a successful write is advisory: it can fail or be unavailable, and
Review still reports the write as done, adding a note such as "Kit validation did not run"
rather than treating that as a failed Apply. If the manifest or preview refresh fails,
Review reports the write as done but the view as possibly stale, and asks you to reload —
never as a failed Apply.

### Standalone Review is read-only

In the standalone `file://` vehicle, Review can display supplied draft, diff, and check
data, but Refine and Apply are read-only. Use a registered genie MCP server inside an
MCP-capable coding host when you need to refine through the model or write to a UI kit.

## Plan, then write

1. Call `plan` with the intended write and delete paths.
2. Review the returned plan.
3. Pass its `planId` to `write_files` or `delete_files`.
4. Call `preview` and `validate`.

The plan guard rejects expired plans, missing plans, and paths outside the plan's globs.

## Preview

`preview` returns a `ui://genie/grid` resource pointer plus fallback information. An
MCP-Apps host can render the grid inline. Local stdio hosts without inline support can
open the standalone viewer. HTTP defaults to remote preview locality and never opens a
browser on the server machine.

### Viewer navigation

The persistent **Generate · Browse · Review** navigation keeps the selected destination in
the URL where the vehicle supports browser history. Browse is a navigable UI-kit
workbench (below). Review displays the current non-persisted draft; applying a draft
still requires the explicit plan-and-write workflow below.

### Browse the UI-kit workbench

Browse shows a 240px UI-kit tree (grouped, with live counts) next to a component-detail
stage: breadcrumb, heading, sandboxed preview at its declared viewport, variant tabs, a
metadata panel (group, viewport, hash, last-modified, tags — only facts the manifest can
prove), and a sanitized, read-only source panel. A selection is stable
(`kitId + group + componentName`) and survives a page refresh or a shared link — it does
not depend on scroll position or array order.

Variant tabs today only ever show **Default**. Hover/Focus/Disabled render
declared-but-disabled with an explanation rather than a simulated preview, because the
manifest format does not carry a variant concept yet — genie never fabricates a rendered
state it cannot back with real data.

**Refine** carries the exact selected kit/group/component context toward Review. It
requires an MCP-capable host (the same tool bridge Generate uses); in a browser-only
session (localhost/`file://`) the button is visibly disabled and explains why. Refine
itself never writes to the kit — persistence remains the explicit plan → write_files
workflow above.

The read-only source panel works in every vehicle, including the standalone
localhost/`file://` viewer: it fetches source files via a same-origin relative
request rather than the MCP host tool bridge, so it needs no model credentials
or host connection to display a component's file.

At narrower widths the tree collapses to a 44px group rail (720–1099px) with an
identifiable overlay for opening it, and then to a compact breadcrumb plus a "Jump to a
component" dropdown (below 720px) — no surface ever requires horizontal scrolling of its
structural chrome.

### Filter components

Type a component name in the filter to narrow the tree by name, group, or tag while you
work. A filter that matches nothing shows a scoped "no match" state with a Clear filter
action — distinct from an empty UI kit, which instead offers a link to Generate.

## Projects and screens

Projects group screen work separately from UI kits. Use `create_project`, `bind_kit`,
`conjure_screen`, `get_project`, `list_projects`, and `delete_project`. The current
`conjure_screen` generator is an offline deterministic scaffold; component-level
`conjure` and `refine` are the model-backed generation tools.
