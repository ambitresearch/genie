# Maintaining these guides

OpenWiki is used as a source-analysis and drafting tool, not as an unattended publisher.
This keeps generated claims behind human review.

## Update process

1. Create a disposable checkout of the current repository.
2. Copy `openwiki/INSTRUCTIONS.md` into that checkout.
3. Run `OPENWIKI_TELEMETRY_DISABLED=1 npx -y openwiki@0.2.0 code --update --print`.
4. Review every generated claim against source, tests, and current workflows.
5. Curate verified changes into `docs/user/` and `docs/developer/`.
6. Run `pnpm docs:build`, the public-docs contract test, and the normal repo gates.

Do not let an OpenWiki run rewrite the canonical `AGENTS.md` or `CLAUDE.md` in a working
checkout. OpenWiki manages marker blocks in those files, so generation belongs in the
disposable checkout.

## VitePress version policy

The site currently pins `vitepress@2.0.0-alpha.18` exactly. VitePress 1.6.4 depends on
the Vite 5 release line, and pnpm's `trustPolicy: no-downgrade` rejects the resolved
Vite 5 artifact because an earlier release had stronger registry trust evidence. The
VitePress 2 alpha uses Vite 8, which is already pinned and verified in this workspace,
so it does not require weakening the repository trust policy.

Move back to a stable VitePress release when a stable line supports Vite 8 or newer and
passes `pnpm install --frozen-lockfile`, `pnpm docs:build`, `pnpm docs:verify`, the
public-docs contract tests, and visual QA without a trust-policy exception.
