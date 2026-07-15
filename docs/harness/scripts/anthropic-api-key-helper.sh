#!/usr/bin/env bash
# anthropic-api-key-helper.sh — prints Claude Code's own model-API credential
# to stdout. Never echo the key anywhere else (logs, terminals); this script
# should be the only place that reads it out of your secret store.
#
# Usage:
#   chmod +x anthropic-api-key-helper.sh
#   claude config set apiKeyHelper /absolute/path/to/anthropic-api-key-helper.sh
# or reference it directly under the top-level "apiKeyHelper" field in
# ~/.claude.json / a project .mcp.json — see docs/harness/claude-code.md's
# "Combined example: HTTP transport + top-level apiKeyHelper" section.
set -euo pipefail

# Prefer the OS keychain / secret manager over a plaintext env var when
# available. Examples (pick the one that matches your environment):
if command -v security >/dev/null 2>&1; then
  # macOS Keychain
  security find-generic-password -a "$USER" -s anthropic-api-key -w
elif command -v op >/dev/null 2>&1; then
  # 1Password CLI
  op read "op://vault/anthropic-api-key/credential"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  # Last resort: an environment variable set by a launcher, not committed
  # anywhere.
  printf '%s' "$ANTHROPIC_API_KEY"
else
  echo "anthropic-api-key-helper.sh: no credential source found" >&2
  exit 1
fi
