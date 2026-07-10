# Using genie in your harness

genie is an MCP server. Every harness that speaks MCP can call its 19 tools —
but how much _guidance_ and _GUI_ you get depends on two independent harness
capabilities:

- **Agent Skills** — does the harness load a bundled `SKILL.md`? Only
  Claude Code / Claude Desktop / claude.ai do. The Skill teaches the
  `conjure → plan → write_files → preview` workflow so a plain-English request
  ("build me a button and show me") just works.
- **`ui://` rendering** — can the harness render an MCP-Apps `ui://` resource
  inline? If so, `preview` shows the card grid _in-panel_. If not, the genie
  server opens a browser tab for you instead.

These are orthogonal, so harnesses fall into a grid:

| Harness                           | Renders `ui://` inline? | Loads Agent Skills? | What it relies on                                                                  |
| --------------------------------- | :---------------------: | :-----------------: | ---------------------------------------------------------------------------------- |
| Claude Code / Desktop / claude.ai |           yes           |       **yes**       | Skill + `/genie:preview` + tool descriptions                                       |
| Cursor                            |         **yes**         |         no          | inline grid + tool descriptions                                                    |
| VS Code (≥ Jan 2026)              |           yes           |         no          | inline grid + tool descriptions                                                    |
| ChatGPT                           |           yes           |         no          | inline grid + tool descriptions                                                    |
| Codex CLI                         |         **no**          |         no          | **server-opened browser tab** + tool descriptions                                  |
| GitHub Copilot (host-dependent)   |  capability-dependent   |         no          | inline when MCP Apps is negotiated; otherwise server-opened browser + descriptions |

**Takeaways:**

- On **Claude harnesses**, install the Skill + command (or the whole plugin) —
  see [claude-code.md](./claude-code.md).
- On **Cursor / VS Code / ChatGPT**, you don't need the Skill — the tool
  descriptions carry the workflow, and `preview` renders the grid inline.
- On **Codex / tools-only Copilot hosts**, the tool descriptions carry the
  workflow and the **genie server opens a browser tab itself** when you call
  `preview`. VS Code Copilot builds that negotiate MCP Apps render inline
  instead. Disable fallback auto-open with `GENIE_PREVIEW_NO_OPEN=1`.

## Two delivery channels (Claude harnesses)

1. **Marketplace plugin** — installs the Skill + namespaced command for an
   already registered genie MCP server. See [claude-code.md](./claude-code.md).
2. **Manual copy** — drop `SKILL.md` and the command into your own `.claude/`.
   Also in [claude-code.md](./claude-code.md).

## Server prerequisites (all harnesses)

The genie server needs an OpenAI-compatible LLM endpoint for `conjure` /
`refine` / `conjure_screen`. Set these as environment on the server process —
**never hardcode secrets** into a config file:

- `GENIE_LLM_BASE_URL` — the endpoint (must end in `/v1`).
- `GENIE_LLM_API_KEY` — its key.

`ping`, `preview`, `validate`, and all the kit/project read tools work without
an LLM configured.

Per-harness registration snippets:
[claude-code.md](./claude-code.md) ·
[cursor.md](./cursor.md) ·
[codex.md](./codex.md) ·
[copilot.md](./copilot.md)
