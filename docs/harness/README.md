# Using genie in your harness

genie is an MCP server. Every harness that speaks MCP can call its 20 tools —
`ping` plus 19 workflow tools — but how much _guidance_ and _GUI_ you get
depends on two independent harness capabilities:

- **Agent Skills** — does the harness load a bundled `SKILL.md`? Claude,
  Cursor, Codex, and GitHub Copilot support the open Agent Skills format, with
  different install directories. The Skill teaches the
  `conjure → plan → write_files → preview` workflow so a plain-English request
  ("build me a button and show me") just works. Tool descriptions remain the
  fallback when a host or session does not load the Skill.
- **`ui://` rendering** — can the harness render an MCP-Apps `ui://` resource
  inline? If so, `preview` shows the card grid _in-panel_. If not, the genie
  server opens a browser tab only for a local stdio connection.

These are orthogonal, so harnesses fall into a grid:

| Harness                           | Renders `ui://` inline? | Loads Agent Skills? | What it relies on                                                          |
| --------------------------------- | :---------------------: | :-----------------: | -------------------------------------------------------------------------- |
| Claude Code / Desktop / claude.ai |           yes           |       **yes**       | Skill + `/genie:preview` + tool descriptions                               |
| Cursor                            |         **yes**         |       **yes**       | Skill + inline grid + tool descriptions                                    |
| VS Code Copilot (≥ Jan 2026)      |  capability-dependent   |       **yes**       | Skill + inline grid when MCP Apps is negotiated + descriptions             |
| ChatGPT remote connector          |           yes           |         no          | inline grid + tool descriptions                                            |
| Codex CLI                         |         **no**          |       **yes**       | Skill + **server-opened browser tab** + descriptions                       |
| GitHub Copilot (host-dependent)   |  capability-dependent   |       **yes**       | Skill + inline grid when negotiated; local fallback browser + descriptions |

**Takeaways:**

- On **Claude Code**, install the Skill + command (or the whole plugin) —
  see [claude-code.md](./claude-code.md).
- On **Cursor, Codex, and GitHub Copilot**, install the same portable Skill using
  the path in each harness guide; descriptions remain a fallback.
- On **ChatGPT's remote connector**, tool descriptions carry the workflow and
  `preview` renders inline.
- On **local stdio Codex / tools-only Copilot hosts**, the **genie server opens
  a browser tab itself** when you call `preview`. HTTP defaults to remote
  locality and never auto-opens a browser. A genuinely same-machine HTTP client
  can opt into a manually opened local viewer URL with
  `--preview-locality local` (or `GENIE_PREVIEW_LOCALITY=local`). Remote HTTP
  hosts require the inline MCP App plus `GENIE_PREVIEWS_BASE_URL`. Disable local
  stdio auto-open with `GENIE_PREVIEW_NO_OPEN=1`.

## Guidance delivery channels

1. **Marketplace plugin** — installs the Skill + namespaced command for an
   already registered genie MCP server in Claude Code. See
   [claude-code.md](./claude-code.md).
2. **Portable Skill copy** — copy `packages/plugin/skills/genie` into the
   harness-specific Agent Skills directory documented below.
3. **Tool descriptions** — always present as fallback guidance when a Skill is
   unavailable or disabled.

## Server prerequisites (all harnesses)

The current CLI validates its known required secrets before starting any
transport. `GENIE_LLM_API_KEY` and `OAUTH_HS256_KEY` are required at startup,
including for read-only tool calls. `GENIE_LLM_BASE_URL` is also required when
calling `conjure`, `refine`, or `conjure_screen`:

- `GENIE_LLM_BASE_URL` — the endpoint (must end in `/v1`).
- `GENIE_LLM_API_KEY` — its key (at least 16 characters).
- `OAUTH_HS256_KEY` — OAuth signing key (at least 32 characters).

Prefer environment variables or an owner-only mounted secrets file. Claude
Desktop's manual local-server configuration is the exception: it has no
separate secret prompt, so required values go in its owner-readable
`claude_desktop_config.json`. Treat that file as sensitive and never commit it.

Per-harness registration snippets:
[claude-code.md](./claude-code.md) ·
[claude-desktop.md](./claude-desktop.md) ·
[cursor.md](./cursor.md) ·
[codex.md](./codex.md) ·
[copilot.md](./copilot.md)
