# User Guide

Use this guide when you want to install genie and generate UI components from your
coding agent.

## Start here

1. [Install and configure genie](installation.md).
2. [Connect your coding agent](harnesses.md).
3. [Run the component workflow](workflow.md).
4. Use [Troubleshooting](troubleshooting.md) when the server or preview does not behave
   as expected.

## The short mental model

A **UI kit** is the component library genie reads and writes. A **project** can bind to a
UI kit and record generated screens. Generation itself is pure: `conjure` and `refine`
return proposed files. To persist a result, the agent must first call `plan`, then pass
that `planId` to `write_files` or `delete_files`.

That separation matters. A model may propose content, but it cannot write arbitrary
paths without a matching plan.

## Supported surfaces

genie supports local stdio and Streamable HTTP. The same 20 tools are available in both
modes, but preview behavior varies by harness. Hosts with MCP Apps support can render
`ui://genie/grid` inline. Local tools-only hosts can use the server-opened browser viewer.
