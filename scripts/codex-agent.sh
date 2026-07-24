#!/usr/bin/env bash
#
# codex-agent.sh — create an isolated agent worktree, then run Codex inside it.
#
# Usage:
#   scripts/codex-agent.sh <feature-label> [Codex prompt or options]
#
# Examples:
#   scripts/codex-agent.sh fix-calendar "Fix the calendar bug and add a test"
#   scripts/codex-agent.sh fix-calendar
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)")"
WORKTREE_SCRIPT="$SCRIPT_DIR/agent-worktree.sh"
BASE="$(dirname "$ROOT")/resabot-worktrees"

die() { echo "error: $*" >&2; exit 1; }

topic="${1:-}"
[ -n "$topic" ] || die "usage: codex-agent.sh <feature-label> [Codex prompt or options]"
shift

command -v codex >/dev/null 2>&1 || die "Codex CLI is not available on PATH"
"$WORKTREE_SCRIPT" new "$topic"

worktree="$BASE/$topic"
[ -d "$worktree" ] || die "worktree was not created: $worktree"

echo "→ launching Codex in $worktree…"
cd "$worktree"
exec codex "$@"
