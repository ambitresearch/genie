# Connect your coding agent

Every MCP-capable harness receives the same tools. Guidance and preview rendering depend
on whether the host loads Agent Skills and negotiates MCP Apps.

| Harness        | Guide                                 | Typical preview                           |
| -------------- | ------------------------------------- | ----------------------------------------- |
| Claude Code    | [Setup](../harness/claude-code.md)    | Inline MCP App or local viewer fallback.  |
| Claude Desktop | [Setup](../harness/claude-desktop.md) | Inline MCP App; `.mcpb` install on macOS. |
| Cursor         | [Setup](../harness/cursor.md)         | Inline when supported.                    |
| Codex CLI      | [Setup](../harness/codex.md)          | Server-opened local browser viewer.       |
| GitHub Copilot | [Setup](../harness/copilot.md)        | Capability-dependent inline rendering.    |
| Continue       | [Setup](../harness/continue.md)       | Inline in IDE, text fallback in CLI.      |
| Cline          | [Setup](../harness/cline.md)          | Local viewer or text fallback.            |

The [harness capability overview](../harness/README.md) compares all supported hosts.

## Portable Agent Skill

The server's tool descriptions are always available. For stronger workflow guidance,
copy `packages/plugin/skills/genie` into the Agent Skills directory documented by your
harness guide. Claude Code can also install the repository plugin, which includes the
Skill and `/genie:preview` command but does not bundle a second MCP runtime.
