# M5-09 (DRO-281) AC4/AC6/AC7 — Claude Code CLI smoke image.
#
# Boots a throwaway container with the real `claude` (Claude Code) CLI and
# genie's built server, so the m5-smoke-claude-code test suite can drive the
# documented conjure -> write_files -> preview -> validate chain through
# Claude Code's own agent loop (not a stand-in MCP SDK client) — see
# packages/e2e/test/m5-smoke-claude-code.test.ts, describe("AC4/AC6/AC7 ...").
#
# Mirrors the Docker-gated-conformance convention used by
# packages/e2e/test/support/gitea-fixture.ts: a single throwaway image,
# booted by testcontainers' GenericContainer, no host-side install required.
#
# NOTE: exact `@anthropic-ai/claude-code` CLI flags used by the test harness
# (`claude -p ... --mcp-config ... --output-format stream-json --verbose`)
# were verified against a locally available `claude` binary (2.x) at
# authoring time — see the test file's header comment for details on what
# could/couldn't be confirmed in this environment. `stream-json` (rather
# than the collapsed `json` mode) is required so the test can assert each
# of the four documented mcp__genie__* tool calls actually ran and returned
# a non-error tool_result, not just that the final summary looks plausible.
FROM node:24-slim

# The Claude Code CLI needs git for some internal operations and a CA bundle
# to reach api.anthropic.com.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Non-interactive Claude Code needs a HOME it can write config/cache into.
ENV HOME=/workspace
ENV CI=1

# The test harness mounts/bind-copies:
#   /workspace/mcp-config.json   — generated `--mcp-config` JSON (HTTP transport
#                                   pointing at the in-process genie server on
#                                   the host, reachable via host.docker.internal)
#   /workspace/prompt.txt        — the non-interactive prompt to run
# and invokes the CLI itself (see run-smoke.sh) so the exact prompt/config can
# vary per test run without rebuilding the image.
COPY run-smoke.sh /usr/local/bin/run-smoke.sh
RUN chmod +x /usr/local/bin/run-smoke.sh

ENTRYPOINT ["/usr/local/bin/run-smoke.sh"]
