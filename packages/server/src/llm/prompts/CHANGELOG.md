# Prompt changelog

Version history for genie's LLM system prompts. The _effective_ version of a
prompt at runtime is the git blob hash of its `.md` file (logged on every
`conjure`/`refine` call as `promptVersion`), so this file is the human-readable
narrative companion to that hash — it explains _why_ a prompt changed, not just
_that_ it did.

Per the M2-03 issue: "80% of the engineering effort here is in iterating on the
system prompt. Track edits in `prompts/CHANGELOG.md`." Add a dated entry every
time a `*.system.md` here changes.

## generate-component.system.md

### v1 — 2026-07-03 (M2-03 / DRO-250)

Initial hand-authored system prompt for `conjure`.

Hand-authored rather than adapted from Anthropic's `canvas-design` skill: that
skill targets Anthropic's hosted Claude Design product and its `@dsCard` /
`_ds_*` conventions, which are Anthropic-interop shapes genie deliberately keeps
out of its native surface (CLAUDE.md hard rule 1). genie's native contract —
`@genie` markers, `components/<group>/<Name>/` layout, the embedded-tier
`default-src 'none'` CSP, and G-5 byte-identical previews — has no public
equivalent to lift, so v1 encodes genie's own constraints directly.

Covers:

- The strict JSON-only output contract (mirrors `COMPONENT_SCHEMA`: top-level
  `componentName` / `group` / `files` / `manifestEntry`, the
  `components/<group>/<Name>/` path layout, and the required
  `<Name>.html` preview).
- The `@genie` first-line marker (`<!-- @genie group="<group>" -->`) — the
  literal first line M3-01 validates post-hoc.
- The embedded-tier CSP wall (`default-src 'none'`): no external assets, system
  fonts only, self-contained inline CSS, byte-identical across
  `file://`/`localhost`/`genie://` (RFC G-5).
- Match-the-kit / honesty / accessibility / one-component-per-call house rules.
- Reference-image and reference-page handling.
- Retry behavior: on a re-send with an appended validation error, fix exactly
  what the error names and return corrected JSON (supports AC8's retry-once).
