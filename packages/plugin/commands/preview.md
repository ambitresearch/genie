---
description: "Open the genie live preview grid for a UI kit"
argument-hint: "[kitId]"
---

# genie preview

Force-open the genie viewer for a UI kit, without waiting on model inference.

Call the `mcp__genie__preview` tool to compile the kit's manifest and show its
live card grid:

- If a kit id was given as `$ARGUMENTS`, preview that kit:
  `mcp__genie__preview { kitId: "$ARGUMENTS" }`.
- If no argument was given, call `mcp__genie__list_kits` first:
  - exactly one kit → preview it.
  - several kits → briefly list them and ask which to open (show the `kitId`s).
  - no kits → tell the user there's no kit yet and suggest `create_kit`.

After the call, relay the viewer URL when one is returned. Remote inline
previews omit server-local viewer and `file://` URLs. On a ui://-capable host
the inline grid renders in-panel; on a local stdio host without UI support, the
genie server opens a browser tab itself (suppress with
`GENIE_PREVIEW_NO_OPEN=1`). HTTP deployments never auto-open a browser. If
`preview` reports the local viewer could not boot, pass along the `file://`
fallback path it returns so the user can still open the kit's `index.html`
directly on that machine.
