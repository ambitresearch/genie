# Public documentation brief

OpenWiki drafts documentation for two audiences:

1. `user`: installation, configuration, tested harness registration, component workflow,
   preview behavior, and troubleshooting.
2. `developer`: current architecture, local development, tests, security boundaries,
   release verification, and the locked Warm Instrument design system.

## Source policy

- State only behavior present in source, tests, current workflows, or existing harness
  guides.
- Do not infer commands, environment variables, deployment topologies, or integrations.
- Do not include roadmaps, milestones, issue IDs, GTM/business material, raw research,
  superseded designs, private infrastructure, credentials, or agent reasoning.
- Use **UI kit** for the user's component library. Use **design system** only for genie's
  own visual language. Use **blueprint** for starter templates.
- Preserve Anthropic interop terms verbatim when they appear in explanatory prose.
- Treat output as a draft. Human review is required before copying it into `docs/user/`
  or `docs/developer/`.
