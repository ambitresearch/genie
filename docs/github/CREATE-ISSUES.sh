#!/usr/bin/env bash
# CREATE-ISSUES.sh — bootstrap labels, milestones, and issues on GitHub.
# Idempotent: re-runs skip anything that already exists.
#
# Usage:
#   ./CREATE-ISSUES.sh                 # default repo roshangautam/genie
#   REPO=other/repo ./CREATE-ISSUES.sh # override
#
# Requires:
#   - gh CLI authenticated (gh auth status)
#   - python3 (for YAML frontmatter parsing; uses stdlib only)
#   - The github/ directory committed alongside this script

set -euo pipefail

REPO="${REPO:-roshangautam/genie}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUES_DIR="$HERE/issues"

LABELS_CREATED=0
LABELS_SKIPPED=0
MILESTONES_CREATED=0
MILESTONES_SKIPPED=0
ISSUES_CREATED=0
ISSUES_SKIPPED=0

log()   { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
err()   { printf '\033[1;31m[FAIL]\033[0m  %s\n' "$*" >&2; }

#############################################
# 1. Preflight
#############################################
log "Verifying gh auth..."
if ! gh auth status >/dev/null 2>&1; then
  err "gh CLI not authenticated. Run: gh auth login"
  exit 1
fi
ok "gh auth OK"

log "Verifying repo $REPO exists..."
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  err "Repo $REPO not found or no access. Create it first:"
  err "    gh repo create $REPO --private --description 'Harness-agnostic MCP server cloning Claude Design — AI UI-component generator'"
  exit 1
fi
ok "Repo $REPO reachable"

log "Verifying python3..."
command -v python3 >/dev/null || { err "python3 required for frontmatter parsing"; exit 1; }
ok "python3 OK"

#############################################
# 2. Labels
#############################################
log "Creating labels..."

# format: "name|hex|description"
LABELS=(
  "type:feature|1d76db|Net-new functionality"
  "type:bug|d73a4a|Defect against documented behaviour"
  "type:chore|cfd3d7|Repo housekeeping, no behaviour change"
  "type:docs|0075ca|Documentation only"
  "type:test|0e8a16|Tests, no prod-code change"
  "type:refactor|a2eeef|Internal restructure, behaviour preserved"
  "type:infra|5319e7|CI, build, release pipeline"
  "type:security|b60205|Vulnerability fix or hardening"
  "type:perf|fbca04|Performance work"
  "type:a11y|7057ff|Accessibility work"
  "type:dx|bfd4f2|Developer experience"
  "area:mcp-server|006b75|MCP server core"
  "area:mcp-tools|008672|MCP tool surface"
  "area:mcp-resources|00a86b|MCP resources surface"
  "area:mcp-prompts|1d8e3a|MCP prompts surface"
  "area:mcp-ui|0e8a16|MCP-UI / MCP Apps"
  "area:litellm|5319e7|LiteLLM gateway integration"
  "area:gitea|f9d0c4|Gitea storage adapter"
  "area:viewer|fef2c0|@genie/viewer package"
  "area:mcpb|fbca04|.mcpb bundling"
  "area:harness:claude-code|a67c00|Claude Code harness"
  "area:harness:claude-desktop|a67c00|Claude Desktop harness"
  "area:harness:codex|a67c00|Codex CLI harness"
  "area:harness:copilot|a67c00|VS Code Copilot harness"
  "area:harness:cursor|a67c00|Cursor harness"
  "area:harness:cline|a67c00|Cline harness"
  "area:harness:continue|a67c00|Continue.dev harness"
  "area:ci|cccccc|CI / release workflows"
  "area:docs|bfdadc|Project documentation"
  "priority:P0-critical|b60205|Blocks release"
  "priority:P1-high|d93f0b|Must be in current milestone"
  "priority:P2-medium|fbca04|Should be in current milestone"
  "priority:P3-low|c2e0c6|Nice to have"
  "size:XS|c5def5|< 1 h"
  "size:S|7ec7f0|1-4 h"
  "size:M|1d76db|4-8 h"
  "size:L|0e3f7c|1-3 d"
  "size:XL|0a1d4f|> 3 d"
  "status:ready|0e8a16|Ready to start"
  "status:in-progress|fbca04|In progress"
  "status:blocked|b60205|Blocked"
  "status:needs-decision|d4c5f9|Awaiting decision"
  "semver:breaking|b60205|Breaking change"
  "semver:minor|fbca04|Minor change"
  "semver:patch|c2e0c6|Patch"
  "good-first-issue|7057ff|Good first issue"
  "help-wanted|008672|Help wanted"
)

for entry in "${LABELS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  color="${rest%%|*}"
  desc="${rest#*|}"
  if gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -Fxq "$name"; then
    LABELS_SKIPPED=$((LABELS_SKIPPED+1))
  else
    if gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null 2>&1; then
      LABELS_CREATED=$((LABELS_CREATED+1))
    else
      warn "label create failed: $name"
    fi
  fi
done
ok "Labels: created=$LABELS_CREATED, skipped(exist)=$LABELS_SKIPPED"

#############################################
# 3. Milestones
#############################################
log "Creating milestones..."

# format: "title|description|due_iso"
MILESTONES=(
  "M0 — Discovery & Scaffold|Repo, governance, CI, dev-env|2026-06-28T23:59:59Z"
  "M1 — Tier-0 File Verbs|DesignSync 12-method mirror + storage + tests|2026-07-12T23:59:59Z"
  "M2 — LiteLLM Generation Surface|generate_component, refine_component, model routing|2026-07-26T23:59:59Z"
  "M3 — @dsCard Validator + Manifest|first-line regex contract + atomic write sequence|2026-08-09T23:59:59Z"
  "M4 — Preview Viewer (Vite + ui://)|@genie/viewer + MCP-Apps fallback|2026-08-30T23:59:59Z"
  "M5 — Auth + Distribution + Smoke Tests|OAuth/bearer + .mcpb/npm/Docker + 7-harness smoke|2026-09-27T23:59:59Z"
  "M6 — GA Hardening|Observability, perf, security, supply chain, launch|2026-10-11T23:59:59Z"
)

# Cache existing milestone titles → numbers
declare -A MILESTONE_NUM
while IFS=$'\t' read -r number title; do
  MILESTONE_NUM["$title"]="$number"
done < <(gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[] | [.number, .title] | @tsv')

for entry in "${MILESTONES[@]}"; do
  title="${entry%%|*}"
  rest="${entry#*|}"
  desc="${rest%%|*}"
  due="${rest#*|}"
  if [[ -n "${MILESTONE_NUM[$title]:-}" ]]; then
    MILESTONES_SKIPPED=$((MILESTONES_SKIPPED+1))
  else
    num=$(gh api --method POST "repos/$REPO/milestones" \
      -f title="$title" -f description="$desc" -f due_on="$due" \
      --jq '.number' 2>/dev/null) || { warn "milestone create failed: $title"; continue; }
    MILESTONE_NUM["$title"]="$num"
    MILESTONES_CREATED=$((MILESTONES_CREATED+1))
  fi
done
ok "Milestones: created=$MILESTONES_CREATED, skipped(exist)=$MILESTONES_SKIPPED"

#############################################
# 4. Issues
#############################################
log "Creating issues from $ISSUES_DIR..."

# Cache existing issue titles (open + closed) so we don't dup
EXISTING_TITLES=$(mktemp)
trap 'rm -f "$EXISTING_TITLES"' EXIT
gh issue list --repo "$REPO" --state all --limit 1000 --json title --jq '.[].title' > "$EXISTING_TITLES"

# Frontmatter parser in python3 (stdlib only). Reads file, prints:
#   line 1: title
#   line 2: milestone
#   line 3: comma-joined labels
#   line 4: body (base64) — to avoid quoting nightmares
PARSER='
import sys, re, base64
text = open(sys.argv[1]).read()
m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
fm_raw, body = m.group(1), m.group(2).strip()
fm = {}
for line in fm_raw.splitlines():
    kv = re.match(r"^(\w+):\s*(.*)$", line)
    if not kv: continue
    k, v = kv.group(1), kv.group(2).strip()
    if v.startswith("\"") and v.endswith("\""):
        v = v[1:-1]
    elif v.startswith("[") and v.endswith("]"):
        items = [x.strip().strip("\"\x27") for x in v[1:-1].split(",")]
        v = ",".join(x for x in items if x)
    fm[k] = v
print(fm.get("title", ""))
print(fm.get("milestone", ""))
print(fm.get("labels", ""))
sys.stdout.write(base64.b64encode(body.encode()).decode())
print()
'

for f in "$ISSUES_DIR"/*.md; do
  parsed=$(python3 -c "$PARSER" "$f")
  title=$(printf '%s' "$parsed" | sed -n '1p')
  milestone=$(printf '%s' "$parsed" | sed -n '2p')
  labels_csv=$(printf '%s' "$parsed" | sed -n '3p')
  body_b64=$(printf '%s' "$parsed" | sed -n '4p')

  if grep -Fxq "$title" "$EXISTING_TITLES"; then
    ISSUES_SKIPPED=$((ISSUES_SKIPPED+1))
    continue
  fi

  body=$(printf '%s' "$body_b64" | base64 -d)

  # Build --label flags
  LABEL_ARGS=()
  IFS=',' read -ra LBL <<< "$labels_csv"
  for l in "${LBL[@]}"; do
    [[ -n "$l" ]] && LABEL_ARGS+=("--label" "$l")
  done

  # Build --milestone flag
  MS_ARGS=()
  if [[ -n "$milestone" ]]; then
    MS_ARGS=("--milestone" "$milestone")
  fi

  if gh issue create --repo "$REPO" \
       --title "$title" \
       --body  "$body" \
       "${LABEL_ARGS[@]}" \
       "${MS_ARGS[@]}" >/dev/null 2>&1; then
    ISSUES_CREATED=$((ISSUES_CREATED+1))
    printf '\033[1;32m[ OK ]\033[0m  %s\n' "$title"
  else
    warn "issue create failed: $title"
  fi
done

#############################################
# 5. Summary
#############################################
printf '\n'
ok "==== SUMMARY ===="
ok "Labels:     created=$LABELS_CREATED, skipped(exist)=$LABELS_SKIPPED"
ok "Milestones: created=$MILESTONES_CREATED, skipped(exist)=$MILESTONES_SKIPPED"
ok "Issues:     created=$ISSUES_CREATED, skipped(exist)=$ISSUES_SKIPPED"
ok "Repo:       https://github.com/$REPO/issues"
