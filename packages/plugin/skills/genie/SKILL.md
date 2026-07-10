---
name: genie
description: 'Use when the user wants to build, generate, show, preview, refine, or see a UI component or screen against their own UI kit — e.g. "build me a primary button", "show me my Card component", "open my kit", "make a login screen and let me see it", "refine this button to be pill-shaped". genie is a harness-agnostic MCP server that generates UI components against a user''s UI kit and renders them in a live preview grid.'
---

# genie — UI component generation against your UI kit

genie generates UI components (and full screens) that match a user's own **UI
kit**, writes them to disk under a capability grant, and shows them in a live
card-grid preview. This skill teaches the verb workflow so a component request
turns into a real, visible result — not just a tool call.

Terminology (keep it straight): a user's component library is a **UI kit**.
Reusable page templates are **blueprints**. genie's own locked visual language
is its "design system" — never call a user's kit that.

## When to use

Reach for genie when the user wants to **create, see, iterate on, or audit** a
UI component or screen:

- "build / generate / make me a `<component>`" → `conjure` → persist → `preview`
- "show me / open / preview my `<component>` / kit" → `preview`
- "change / refine / tweak this `<component>`" → `refine`
- "is my kit healthy / any problems" → `validate`

If there's no kit yet, `create_kit` first.

## The happy path: conjure → plan → write_files → preview

This is the canonical sequence. Do all four unless the user asks for less.

1. **`conjure`** — generate ONE component from a prompt. It is **pure**: it
   returns `{ componentName, files[], manifestEntry, usage }` and **writes
   nothing**. Requires a configured LLM endpoint; `model` defaults to the valid
   `design-default` gateway alias.
2. **`plan`** — lock the exact paths you're about to write. Pass the
   `files[].path` values from step 1 as the `writes` globs. Returns a `planId`
   (plans expire after 1h).
3. **`write_files`** — commit the conjured files to the kit. Pass the `planId`
   from step 2 and map each generated file from
   `{ path, content, mimeType }` to `{ path, data: content, mimeType }`.
   Every path must be covered by the plan's `writes` globs.
4. **`preview`** — compile the kit manifest and **show the user the component**.
   This is how a component becomes _visible_: ui://-capable hosts (Claude, VS
   Code, ChatGPT, Cursor) get an inline card grid; other hosts get a browser
   tab the server opens for them.

### Concrete example

User: _"Build me a primary CTA button that says Get Started, and show me."_

```
conjure  { kitId, kit: "<one-line kit description>",
           prompt: "A primary CTA button that says Get Started" }
   → { componentName: "GetStartedButton",
       files: [{ path: "components/actions/GetStartedButton/GetStartedButton.html", ... }] }

plan     { kitId, writes: ["components/actions/GetStartedButton/GetStartedButton.html"] }
   → { planId }

write_files {
  planId,
  files: conjureResult.files.map(file => ({
    path: file.path,
    data: file.content,
    mimeType: file.mimeType
  }))
}

preview  { kitId }
   → viewer URL / inline grid — the user now SEES the button.
```

## Side paths

- **`refine`** — iterate on an existing component from a free-form instruction
  ("make the corners a pill", "soften the border"). Returns a diff + updated
  files. Uses `design-default` unless the user requests an exposed model override.
- **`validate`** — advisory quality counts (`markerMissing` / `thin` /
  `variantsIdentical`). No plan needed; nothing is written.
- **`delete_files`** — remove a component. Needs a `planId` whose **`deletes`**
  globs cover the paths (same capability model as writes).
- **`conjure_screen`** — a full-page screen inside a project (resolves its kit
  from the project's bindings; `bind_kit` a kit to the project first).

## Two rules that trip people up

- **Model routing.** `design-default` is the valid default routing alias; the
  configured OpenAI-compatible endpoint/gateway resolves it to a provider
  model. Pass a concrete provider model id only when the operator has exposed
  one and the user explicitly wants that override. The genie server needs
  `GENIE_LLM_BASE_URL` + `GENIE_LLM_API_KEY` configured (operator-supplied;
  never hardcode them).
- **Writes are capability-gated.** `write_files` / `delete_files` fail without a
  valid `planId` whose globs cover the paths. This is the security boundary, by
  design — always `plan` immediately before you write, using the paths you're
  about to touch.

## Preview: how the GUI actually shows up

`preview` compiles + persists the kit's manifest, so the grid always reflects
what's on disk (`list_components` reads that compiled manifest). Then:

- **ui://-capable host** (Claude, VS Code, ChatGPT, Cursor): the inline card
  grid renders in-panel — no browser tab needed.
- **other host** (Codex, Copilot, MCP Inspector): the server opens a browser
  tab at the viewer URL itself. Set `GENIE_PREVIEW_NO_OPEN=1` to suppress that.

Either way, relay the viewer URL to the user so they always have a way in.
