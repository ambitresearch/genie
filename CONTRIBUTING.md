# Contributing to genie

Thanks for your interest. genie is a solo, AI-assisted open-source experiment —
contributions are welcome but the project is run best-effort by one maintainer.
Read this before opening a PR; it'll save us both time.

## The short version

1. **Open an issue first** for anything non-trivial. A quick "I'd like to add X —
   does that fit?" avoids wasted work.
2. **Branch** from `main`: `<type>/<short-slug>` (e.g. `feat/list-projects-tool`).
3. **Write tests.** New behavior needs a test. We use Vitest.
4. **Keep it green.** `pnpm lint && pnpm typecheck && pnpm test` must pass.
5. **Conventional Commits.** Your commit messages drive automated releases.
6. **Open a PR** with a clear description and link the issue (`Closes #NN`).

## Working agreement for AI agents

This repo is built largely by AI coding agents under maintainer review. If you
are an agent (or directing one), follow the full SDLC in
[`AGENTS.md`](./AGENTS.md): plan → TDD → visual-validate (UI issues) → test
against the local service → adversarial self-review → PR → review loop → merge →
monitor CI. The hard rules in `AGENTS.md` (interop terms, identity, secrets,
CSP) are non-negotiable.

## Dev setup

```bash
git clone https://github.com/roshangautam/genie.git
cd genie
corepack enable                # or: npm i -g pnpm
pnpm install
pnpm dev                       # boots the MCP server on stdio
pnpm test                      # run the suite
```

Requires Node ≥ 18 (CI tests 18/20/22). `.nvmrc` pins 20.

### Useful scripts

| Command | What |
|---|---|
| `pnpm dev` | Run the server with hot reload (tsx watch) |
| `pnpm build` | Compile all packages to `dist/` |
| `pnpm test` | Run Vitest once |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` across packages |
| `pnpm format` | Prettier write |

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/). The type prefix
determines the release bump via release-please:

- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` / `fix!:` / `BREAKING CHANGE:` → major bump
- `chore:` / `docs:` / `test:` / `refactor:` / `ci:` → no release

Scope is optional but nice: `feat(server): add list_projects tool`.

## Code style

- TypeScript, ESM, `strict` mode. No `any` without a comment justifying it.
- Prefer explicit over clever. Small, focused modules.
- Prettier + ESLint are the source of truth; run them before pushing.

## Reviews

PRs are reviewed by the maintainer and/or an AI review agent (GitHub Copilot is
the designated reviewer, per `AGENTS.md` §7). Address review comments and
re-request; nothing merges with open comments or red CI.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](./LICENSE) (inbound = outbound). A CLA is not currently required.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be kind.
