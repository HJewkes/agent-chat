#!/usr/bin/env bash
# ExecStart of agent-chat-redeploy.service (CC-1695): runs restart-window.sh so the restarted
# broker's parent is the systemd user manager, never a worker MCP or an agent shell, and logs
# the broker's pid, lstart and ppid and the dist mtime before and after.
# A seat triggers it with: systemctl --user start agent-chat-redeploy
# Exits with restart-window.sh's code.
set -uo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
log_dir="${AGENT_CHAT_HOME:-$HOME/.agent-chat}"

broker_state() { # broker_state <label>
  local pid lstart="-" ppid="-" mtime="-"
  pid="$(cat "$log_dir/broker.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
    lstart="$(ps -o lstart= -p "$pid" | xargs)"
    ppid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
  else
    pid="${pid:-none} (not running)"
  fi
  [ ! -e "$repo/dist/cli.js" ] || mtime="$(date -u -r "$repo/dist/cli.js" +%Y-%m-%dT%H:%M:%SZ)"
  echo "redeploy: $1 broker pid=$pid lstart=$lstart ppid=$ppid dist_mtime=$mtime"
}

# A function, parsed whole before it runs, so the restart's checkout swap cannot change this file mid-read.
main() {
  local code
  echo "redeploy: start $(date -u +%Y-%m-%dT%H:%M:%SZ) in $repo"
  broker_state old
  "$repo/scripts/restart-window.sh"
  code=$?
  broker_state new
  echo "redeploy: restart-window.sh exited $code"
  return "$code"
}

main "$@"
exit $?
