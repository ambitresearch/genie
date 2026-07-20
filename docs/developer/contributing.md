# Local development and contribution

## Setup

```bash
git clone https://github.com/ambitresearch/genie.git
cd genie
corepack enable
pnpm install
```

Node 22.19 or newer is required. `.nvmrc` pins the baseline tested by CI.

## Commands

| Command             | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `pnpm dev`          | Run the MCP server on stdio with source watching.        |
| `pnpm build`        | Compile all workspaces and package viewer assets.        |
| `pnpm lint`         | Run ESLint.                                              |
| `pnpm typecheck`    | Run strict TypeScript checks across packages.            |
| `pnpm test`         | Run unit, integration, E2E, browser, and contract tests. |
| `pnpm format:check` | Check repository formatting.                             |

## Contribution flow

Open an issue before non-trivial work. Branch from `main`, write the failing test first,
implement the smallest behavior, and run the narrowest relevant tests before widening to
the full gates. Commit messages follow Conventional Commits because Release Please uses
them to calculate versions.

The full review and landing requirements are in
[`CONTRIBUTING.md`](https://github.com/ambitresearch/genie/blob/main/CONTRIBUTING.md) and
[`AGENTS.md`](https://github.com/ambitresearch/genie/blob/main/AGENTS.md).

## Test layers

- Unit tests live beside source modules.
- Integration tests exercise real multi-module seams and containerized dependencies.
- `packages/e2e` drives the server through MCP and tests harness-specific registration,
  preview delivery, auth, Docker images, and live generation canaries.

Set `VITEST_JUNIT=1` when you need `reports/junit.xml`, the same artifact shape CI uses.
