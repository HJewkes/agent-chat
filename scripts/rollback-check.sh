#!/usr/bin/env bash
# Prove a past revision still builds and serves /health, before rolling the live broker back to it.
set -euo pipefail

sha="${1:?usage: scripts/rollback-check.sh <git-sha> [port] [--home <seed>]}"
shift
port=7699
seed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home)
      seed="${2:?usage: --home <seed-dir>}"
      shift 2
      ;;
    *)
      port="$1"
      shift
      ;;
  esac
done
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
work="$(mktemp -d "${TMPDIR:-/tmp}/agent-chat-rollback.XXXXXX")"
pid=""

cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

if curl -fsS -m 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
  echo "rollback-check: port $port already answers /health; pick another" >&2
  exit 2
fi

git -C "$repo" rev-parse --verify --quiet "$sha^{commit}" >/dev/null ||
  { echo "rollback-check: $sha is not a commit in $repo" >&2; exit 2; }

mkdir -p "$work/src" "$work/home"
if [ -n "$seed" ]; then
  [ -d "$seed" ] || { echo "rollback-check: --home seed $seed is not a directory" >&2; exit 2; }
  echo "rollback-check: seeding \$work/home from $seed (an events.db with agent_execution tables already in it)"
  cp -R "$seed/." "$work/home/"
fi
git -C "$repo" archive "$sha" | tar -x -C "$work/src"
echo "rollback-check: building $sha in $work/src"
(cd "$work/src" && npm ci --no-audit --no-fund --silent && npx tsc)

AGENT_CHAT_HOME="$work/home" AGENT_CHAT_PORT="$port" \
  node "$work/src/dist/cli.js" broker >"$work/broker.out" 2>&1 &
pid=$!

for _ in $(seq 1 50); do
  if body="$(curl -fsS -m 1 "http://127.0.0.1:$port/health" 2>/dev/null)"; then
    echo "rollback-check: $sha OK on port $port"
    echo "$body"
    if ! ls_out="$(AGENT_CHAT_HOME="$work/home" node "$work/src/dist/cli.js" agent ls 2>&1)"; then
      echo "rollback-check: $sha answered /health but 'agent ls' failed" >&2
      echo "$ls_out" >&2
      exit 1
    fi
    echo "rollback-check: agent ls —"
    echo "$ls_out"
    exit 0
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done

echo "rollback-check: broker built from $sha never answered /health" >&2
cat "$work/broker.out" >&2
exit 1
