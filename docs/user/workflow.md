# Component workflow

## Discover a UI kit

Use `list_kits`, `get_kit`, `list_components`, `list_files`, and `read_file` to inspect
the operator-owned library. `create_kit` scaffolds a new kit under `GENIE_KITS_ROOT`.

## Generate

`conjure` accepts a UI-kit description and a component prompt. It calls the configured
OpenAI-compatible endpoint, validates the structured reply, and returns proposed files.
It does not persist them.

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

### Browse components

The viewer groups components by category and shows each component's preview size.

![The genie viewer showing a grid of UI kit components](/screenshots/viewer-component-grid.png)

### Filter components

Type a component name in the filter to narrow the grid while you work.

![The genie viewer filtered to button components](/screenshots/viewer-filtered-components.png)

## Projects and screens

Projects group screen work separately from UI kits. Use `create_project`, `bind_kit`,
`conjure_screen`, `get_project`, `list_projects`, and `delete_project`. The current
`conjure_screen` generator is an offline deterministic scaffold; component-level
`conjure` and `refine` are the model-backed generation tools.
