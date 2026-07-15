#!/usr/bin/env sh
# Runs Claude Code non-interactively against a genie MCP server reachable at
# the URL baked into /workspace/mcp-config.json, with the prompt supplied in
# /workspace/prompt.txt. Emits `--output-format stream-json` (NDJSON, one
# structured event per line, including tool_use/tool_result entries) on
# stdout so the caller (m5-smoke-claude-code.test.ts) can walk the actual
# event stream and assert each documented mcp__genie__* tool call ran and
# returned a non-error result (AC5/AC6) — a single collapsed
# `--output-format json` result cannot prove that.
# `--verbose` is required by the Claude Code CLI whenever `--print`/`-p` is
# combined with `--output-format stream-json`.
set -eu

PROMPT_FILE="/workspace/prompt.txt"
MCP_CONFIG="/workspace/mcp-config.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "run-smoke.sh: missing $PROMPT_FILE (mount/copy it before starting the container)" >&2
  exit 1
fi
if [ ! -f "$MCP_CONFIG" ]; then
  echo "run-smoke.sh: missing $MCP_CONFIG (mount/copy it before starting the container)" >&2
  exit 1
fi

exec claude \
  -p "$(cat "$PROMPT_FILE")" \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --output-format stream-json \
  --verbose \
  --allowedTools "mcp__genie__conjure,mcp__genie__write_files,mcp__genie__preview,mcp__genie__validate,mcp__genie__create_kit,mcp__genie__plan" \
  --allow-dangerously-skip-permissions
