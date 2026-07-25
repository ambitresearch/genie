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
