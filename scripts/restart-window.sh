#!/usr/bin/env bash
# The daily broker restart: pre-check, update the CLI, restart, post-check (CC-210).
# Running it needs the owner's approval of the day's window. There is no --force on purpose.
#
# Exit codes:
#   0  restart-window OK
#   1  a pre-check refused, or the restart's own guard refused; the broker was not touched
#   2  a post-check failed
#   3  the restart failed and the broker may be down (run: agent-chat service start)
#   4  pull, install or build failed; the broker was not touched
set -euo pipefail

[ $# -eq 0 ] || { echo "restart-window: takes no arguments; --force is the owner's call" >&2; exit 1; }

log_dir="${AGENT_CHAT_HOME:-$HOME/.agent-chat}"
PUSH_RE='(^|/)git push( |$)|(^|/)git-remote-http'
MERGE_RE='(^|/)seat-merge( |$)|(^|/)bin/merge( |$)|(^|/)gh pr merge( |$)|(agent-chat|index\.js) gh-write( |$)'
blockers=()

running() { pgrep -f "$1" 2>/dev/null | sort -un | paste -sd, - || true; }

pids="$(running "$PUSH_RE")"
[ -z "$pids" ] || blockers+=("a git push is running (pid $pids)")
pids="$(running "$MERGE_RE")"
[ -z "$pids" ] || blockers+=("a merge is running (pid $pids)")

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

# Pull and build before the restart, so the broker never starts on old dist while node_modules changes.
if ! (cd "$repo" && git pull --ff-only origin main && npm ci && npm run build); then
  echo "restart-window: pull, install or build failed; the broker was not touched" >&2
  exit 4
fi

# Floored to the second, which can only widen the window by under a second.
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
set +e
restart_out="$(agent-chat service restart 2>&1)"
restart_code=$?
set -e
[ -z "$restart_out" ] || echo "$restart_out"
if [ "$restart_code" -ne 0 ]; then
  if [[ "$restart_out" == "refusing to restart:"* ]]; then
    echo "restart-window: refusing: the broker has work in flight (message above)" >&2
    exit 1
  fi
  echo "BROKER MAY BE DOWN: run agent-chat service start"
  exit 3
fi

failed=0
check() { # check <label> <ok: 0|1>
  if [ "$2" -eq 0 ]; then echo "ok: $1"; else echo "FAIL: $1"; failed=1; fi
}
# Counts broker.log lines (JSON, ISO ts) of one event at or after the restart, across the rotated file too.
count() {
  node -e '
    const fs = require("fs")
    const [dir, event, since] = process.argv.slice(1)
    let n = 0
    for (const f of [`${dir}/broker.log.1`, `${dir}/broker.log`]) {
      if (!fs.existsSync(f)) continue
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        try {
          const row = JSON.parse(line)
          if (row.event === event && row.ts >= since) n++
        } catch {}
      }
    }
    console.log(n)
  ' "$log_dir" "$1" "$started_at" 2>/dev/null || echo "?"
}

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
