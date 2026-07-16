#!/usr/bin/env bash
# anthropic-api-key-helper.sh — prints Claude Code's own model-API credential
# to stdout. Never echo the key anywhere else (logs, terminals); this script
# should be the only place that reads it out of your secret store.
#
# Usage:
#   chmod +x anthropic-api-key-helper.sh
#   reference it under the top-level "apiKeyHelper" field in ~/.claude.json
#   or your Claude Code settings file — see docs/harness/claude-code.md's
# "Combined example: HTTP transport + top-level apiKeyHelper" section.
set -euo pipefail

# Prefer the OS keychain / secret manager over a plaintext env var when a
# credential can actually be retrieved. An installed client with no matching
# item must fall through to the next source.
credential=""
if command -v security >/dev/null 2>&1; then
  # macOS Keychain
  credential=$(security find-generic-password -a "$USER" -s anthropic-api-key -w 2>/dev/null || true)
fi
if [ -z "$credential" ] && command -v op >/dev/null 2>&1; then
  # 1Password CLI
  credential=$(op read "op://vault/anthropic-api-key/credential" 2>/dev/null || true)
fi

if [ -n "$credential" ]; then
  printf '%s' "$credential"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  # Last resort: an environment variable set by a launcher, not committed
  # anywhere.
  printf '%s' "$ANTHROPIC_API_KEY"
else
  echo "anthropic-api-key-helper.sh: no credential source found" >&2
  exit 1
fi
