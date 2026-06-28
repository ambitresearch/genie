# NOTICE

genie
Copyright (c) 2026 Roshan Gautam
Licensed under the MIT License (see LICENSE).

## Relationship to Anthropic's Claude Design

genie is an independent, open-source project **inspired by** Anthropic's hosted
Claude Design surface. It is **not** affiliated with, endorsed by, or a
reproduction of any Anthropic product. genie is built against public Model
Context Protocol (MCP) surfaces and uses its own native conventions. A future
opt-in bridge may support observable, interoperable conventions such as
`@dsCard` and the file-flow verb shape so work can round-trip with compatible tools.

"Claude", "Claude Design", and "Anthropic" are trademarks of Anthropic, PBC.
genie uses them only descriptively, to state what it is inspired by and
interoperable with. No Anthropic logos, trademarks, or proprietary text are
embedded in this project.

## Third-party attributions

Portions of the multi-transport server bootstrap pattern are informed by
prior-art MIT-licensed MCP servers, including:

- GLips/Figma-Context-MCP (MIT) — transport/CLI scaffolding patterns.

These projects are not redistributed here; only general patterns were studied.
genie's implementation is original TypeScript.

## Dependencies

genie depends on open-source packages under their own licenses, including
`@modelcontextprotocol/sdk` (MIT) and `zod` (MIT). See each package's license
in `node_modules/` or its registry page for full terms.
