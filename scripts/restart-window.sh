#!/usr/bin/env bash
# The daily broker restart: pre-check, restart, rebuild the installed CLI, post-check (CC-210).
# Running it needs the owner's approval of the day's window. There is no --force on purpose.
set -euo pipefail

[ $# -eq 0 ] || { echo "restart-window: takes no arguments; --force is the owner's call" >&2; exit 1; }

db="${RESTART_WINDOW_DB:-$HOME/.agent-chat/events.db}"
blockers=()

pushes="$(pgrep -f '(^|/)git-remote-http|^git( .*)? push' 2>/dev/null | sort -un | paste -sd, - || true)"
[ -z "$pushes" ] || blockers+=("a git push is running (pid $pushes)")

cli="$(command -v agent-chat || true)"
repo=""
if [ -z "$cli" ]; then
  blockers+=("agent-chat is not on PATH")
else
  target="$(readlink -f "$cli")"
  repo="$(git -C "$(dirname "$target")" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$repo" ]; then
    blockers+=("installed agent-chat ($target) is not inside a git checkout")
  else
    branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
    [ "$branch" = main ] || blockers+=("installed checkout $repo is on '$branch', not main")
    [ -z "$(git -C "$repo" status --porcelain)" ] || blockers+=("installed checkout $repo has uncommitted changes")
  fi
fi

if [ ${#blockers[@]} -gt 0 ]; then
  for b in "${blockers[@]}"; do echo "restart-window: refusing: $b" >&2; done
  exit 1
fi

started_ms=$(( $(date +%s) * 1000 ))
if ! agent-chat service restart; then
  echo "restart-window: refusing: agent-chat service restart failed (output above)" >&2
  exit 1
fi

(cd "$repo" && npm ci && npm run build)

failed=0
check() { # check <label> <ok: 0|1>
  if [ "$2" -eq 0 ]; then echo "ok: $1"; else echo "FAIL: $1"; failed=1; fi
}
count() { sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='$1' AND ts >= $started_ms" 2>/dev/null || echo "?"; }

n="$(count broker_started)"
check "exactly one broker_started since restart (found $n)" "$([ "$n" = 1 ] && echo 0 || echo 1)"
n="$(count ledger_shadow_error)"
check "no ledger_shadow_error since restart (found $n)" "$([ "$n" = 0 ] && echo 0 || echo 1)"
if agent-chat agent ls --json | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null; then
  check "agent ls --json parses" 0
else
  check "agent ls --json parses" 1
fi

[ "$failed" -eq 0 ] || exit 2
echo "restart-window OK"
