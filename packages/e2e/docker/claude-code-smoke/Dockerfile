# M5-09 (DRO-281) AC4/AC6/AC7 — Claude Code CLI smoke image.
#
# Boots a throwaway container with the real `claude` (Claude Code) CLI, which
# connects to the host test process's real genie HTTP server so the suite can
# drive the documented conjure -> write_files -> preview -> validate chain
# through Claude Code's own agent loop (not a stand-in MCP SDK client) — see
# packages/e2e/test/m5-smoke-claude-code.test.ts, describe("AC4/AC6/AC7 ...").
#
# Mirrors the Docker-gated-conformance convention used by
# packages/e2e/test/support/gitea-fixture.ts: a single throwaway image,
# booted by testcontainers' GenericContainer, no host-side install required.
#
# NOTE: exact `@anthropic-ai/claude-code` CLI flags used by the test harness
# (`claude -p ... --setting-sources user --output-format stream-json --verbose`)
# were verified against Claude Code 2.1.210 at
# authoring time — see the test file's header comment for details on what
# could/couldn't be confirmed in this environment. `stream-json` (rather
# than the collapsed `json` mode) is required so the test can assert each
# of the four documented protocol-level mcp__genie__* calls actually ran
# through Claude Code's server-prefixed wrappers and returned a non-error
# tool_result, not just that the final summary looks plausible.
FROM node:24-slim

# The Claude Code CLI needs git for some internal operations and a CA bundle
# to reach api.anthropic.com.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.210

WORKDIR /workspace

# Non-interactive Claude Code needs a HOME it can write config/cache into.
ENV HOME=/workspace
ENV CI=1

# Keep the model driver unprivileged even though the smoke image is disposable;
# its HOME only needs config/cache writes under /workspace.
RUN chown node:node /workspace

# The test harness mounts/bind-copies:
#   /workspace/.claude/settings.json — top-level apiKeyHelper
#   /workspace/.claude.json          — HTTP genie server + headersHelper
#   /workspace/*-helper.sh        — throwaway helper scripts referenced above
#   /workspace/prompt.txt        — the non-interactive prompt to run
# and optionally sets GENIE_CLAUDE_DRIVER_MODEL when the CLI is routed through
# a gateway that does not expose Claude Code's built-in default model.
# then starts this image idle and invokes the CLI through `container.exec`
# (see run-smoke.sh) so stdout and stderr remain separate and the exact
# prompt/config can vary per test run without rebuilding the image.
COPY run-smoke.sh /usr/local/bin/run-smoke.sh
RUN chmod +x /usr/local/bin/run-smoke.sh

USER node

ENTRYPOINT ["tail", "-f", "/dev/null"]
