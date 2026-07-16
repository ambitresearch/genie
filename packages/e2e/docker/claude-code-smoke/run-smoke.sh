#!/usr/bin/env sh
# Runs Claude Code non-interactively against a genie MCP server reachable at
# the URL baked into /workspace/claude-config.json, with the prompt supplied in
# /workspace/prompt.txt. Emits `--output-format stream-json` (NDJSON, one
# structured event per line, including tool_use/tool_result entries) on
# stdout so the caller (m5-smoke-claude-code.test.ts) can walk the actual
# event stream and assert each documented protocol-level mcp__genie__* tool
# call ran through Claude Code's mcp__genie__mcp__genie__* wrapper and returned
# a non-error result (AC5/AC6) — a single collapsed
# `--output-format json` result cannot prove that.
# `--verbose` is required by the Claude Code CLI whenever `--print`/`-p` is
# combined with `--output-format stream-json`.
set -eu

PROMPT_FILE="/workspace/prompt.txt"
CLAUDE_CONFIG="/workspace/claude-config.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "run-smoke.sh: missing $PROMPT_FILE (mount/copy it before starting the container)" >&2
  exit 1
fi
if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "run-smoke.sh: missing $CLAUDE_CONFIG (mount/copy it before starting the container)" >&2
  exit 1
fi

exec claude \
  -p "$(cat "$PROMPT_FILE")" \
  --settings "$CLAUDE_CONFIG" \
  --mcp-config "$CLAUDE_CONFIG" \
  --strict-mcp-config \
  --bare \
  --tools "mcp__genie__mcp__genie__conjure,mcp__genie__mcp__genie__write_files,mcp__genie__mcp__genie__preview,mcp__genie__mcp__genie__validate,mcp__genie__mcp__genie__create_kit,mcp__genie__mcp__genie__plan" \
  --output-format stream-json \
  --verbose \
  --allowedTools "mcp__genie__mcp__genie__conjure,mcp__genie__mcp__genie__write_files,mcp__genie__mcp__genie__preview,mcp__genie__mcp__genie__validate,mcp__genie__mcp__genie__create_kit,mcp__genie__mcp__genie__plan"
