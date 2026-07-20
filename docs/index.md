# genie documentation

genie brings UI-component generation into MCP-capable coding agents and works against
your own UI kit. It combines model-backed generation with a plan-gated write flow and a
live preview that adapts to each harness.

<div class="guide-grid" markdown>

<a class="guide-card guide-card--start" href="user/">
  <span class="guide-card__eyebrow">Use genie</span>
  <strong>User Guide</strong>
  <span>Install the server, connect your coding agent, generate components, preview results, and troubleshoot a setup.</span>
</a>

<a class="guide-card" href="developer/">
  <span class="guide-card__eyebrow">Build genie</span>
  <strong>Developer Guide</strong>
  <span>Understand the architecture, run the repository, contribute safely, and verify releases.</span>
</a>

</div>

## What ships today

- An MCP server with `ping` plus 19 kit and project workflow tools.
- `conjure` and `refine` through an operator-configured OpenAI-compatible endpoint.
- Plan-gated file writes and deletes.
- Stdio and Streamable HTTP transports.
- A preview grid delivered inline through `ui://genie/grid` when supported, with local
  viewer fallbacks for tools-only harnesses.
- npm, Docker, and Claude Desktop bundle distribution paths.

genie is an independent open-source project inspired by Anthropic's Claude Design. It
uses public MCP surfaces and is not affiliated with Anthropic.
