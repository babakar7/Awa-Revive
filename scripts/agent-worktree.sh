#!/usr/bin/env bash
#
# agent-worktree.sh — one git worktree per agent/topic, so parallel agents
# (Claude Code sessions, kilo, humans) never share a dirty working tree.
#
# Worktrees live in the SIBLING dir ../resabot-worktrees/<topic> — outside the
# repo (invisible to `railway up` and `tsc`) and outside /tmp (survives reboot).
# Delivery is a direct merge to main: rebase on origin/main, build+test, then
# push HEAD:main → Railway auto-deploys. No PR required.
#
# Usage:
#   scripts/agent-worktree.sh new <topic>     # create + npm ci + copy .env
#   scripts/agent-worktree.sh ship [--full]   # rebase+build+test+push HEAD:main (run INSIDE a worktree)
#   scripts/agent-worktree.sh done [<topic>]  # remove the worktree + its branch (merged-only)
#   scripts/agent-worktree.sh list            # list worktrees with dirty-file counts
set -euo pipefail

# ROOT = the HUB checkout, always — even when this script runs from a worktree's
# own copy (BASH_SOURCE then lives in the worktree, so deriving ROOT from it made
# the ship/done guards fire everywhere). --git-common-dir points to the hub's
# .git from any worktree.
ROOT="$(dirname "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)")"
BASE="$(dirname "$ROOT")/resabot-worktrees"

die() { echo "error: $*" >&2; exit 1; }

cmd_new() {
  local topic="${1:-}"
  [ -n "$topic" ] || die "usage: agent-worktree.sh new <topic>"
  local dir="$BASE/$topic"
  [ -e "$dir" ] && die "worktree already exists: $dir"
  git -C "$ROOT" show-ref --quiet "refs/heads/agent/$topic" && die "branch agent/$topic already exists"

  echo "→ fetching origin…"
  git -C "$ROOT" fetch origin
  echo "→ creating worktree $dir off origin/main…"
  mkdir -p "$BASE"
  git -C "$ROOT" worktree add -b "agent/$topic" "$dir" origin/main
  if [ -f "$ROOT/.env" ]; then cp "$ROOT/.env" "$dir/.env"; echo "→ copied .env"; else echo "! no .env in hub to copy"; fi
  echo "→ npm ci…"
  ( cd "$dir" && npm ci )
  echo
  echo "✓ ready: cd $dir"
  echo "  work on branch agent/$topic; \`npm run dev\` auto-picks a free port."
  echo "  deliver with: npm run agent:ship   (then: npm run agent:done -- $topic)"
}

cmd_ship() {
  local full=0
  [ "${1:-}" = "--full" ] && full=1
  local top; top="$(git rev-parse --show-toplevel)"
  [ "$top" != "$ROOT" ] || die "refusing to ship from the hub ($ROOT). cd into a worktree first."
  [ -z "$(git status --porcelain)" ] || die "commit your work first — working tree is dirty."

  echo "→ fetch + rebase on origin/main…"
  git fetch origin
  git rebase origin/main
  echo "→ build + test…"
  npm run build && npm test
  [ "$full" = 1 ] && { echo "→ integration tests…"; npm run test:integration; }

  local tries=0
  until git push origin HEAD:main; do
    tries=$((tries + 1))
    [ "$tries" -ge 3 ] && die "push rejected 3× — resolve manually."
    echo "! push rejected (someone else landed first) — re-syncing (attempt $tries)…"
    git fetch origin && git rebase origin/main && npm run build && npm test
  done
  echo "✓ pushed to main — Railway auto-deploys. Verify /healthz, then: npm run agent:done"
}

cmd_done() {
  local topic="${1:-}"
  if [ -z "$topic" ]; then
    local top; top="$(git rev-parse --show-toplevel)"
    [ "$top" != "$ROOT" ] || die "usage from the hub: agent-worktree.sh done <topic>"
    topic="$(basename "$top")"
  fi
  local dir="$BASE/$topic"
  echo "→ removing worktree $dir…"
  git -C "$ROOT" worktree remove "$dir"        # refuses if dirty
  git -C "$ROOT" branch -d "agent/$topic"      # -d: only if merged
  git -C "$ROOT" worktree prune
  echo "✓ removed worktree + branch agent/$topic"
}

cmd_list() {
  git -C "$ROOT" worktree list | while read -r path rest; do
    if [ -d "$path" ]; then
      local n; n="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      printf "%s  [%s dirty]  %s\n" "$path" "$n" "$rest"
    fi
  done
}

case "${1:-}" in
  new)  shift; cmd_new "$@" ;;
  ship) shift; cmd_ship "$@" ;;
  done) shift; cmd_done "$@" ;;
  list) shift; cmd_list "$@" ;;
  *) die "usage: agent-worktree.sh {new <topic>|ship [--full]|done [<topic>]|list}" ;;
esac
