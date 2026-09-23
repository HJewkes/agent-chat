#!/usr/bin/env bash
# Prove a kill -9'd broker comes back with an intact ledger: the headless agent
# it was holding reattaches, the gap classifies as ledger_only_since_restart
# (CC-102's boot reconciliation is what would otherwise write that row; it is
# not built yet, which is exactly the divergence this class exists to name),
# and events.db passes SQLite's own integrity check throughout.
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
dist="$repo/dist/cli.js"
[ -f "$dist" ] || { echo "ledger-kill9-check: $dist missing; run npm run build first" >&2; exit 2; }

# An explicit, non-default port: the default (7600) is the live broker's, and
# two brokers racing for one port is exactly the hazard this rehearsal must not
# create on a machine that also runs the real thing.
port="${1:-7691}"
if curl -fsS -m 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
  echo "ledger-kill9-check: port $port already answers /health; pick another" >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/ac-kill9.XXXXXX")"
home="$work/home"
bin="$work/bin"
mkdir -p "$home/profiles" "$bin"

cleanup() {
  if [ -f "$home/broker.pid" ]; then
    pid="$(cat "$home/broker.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  fi
  pkill -9 -f "$bin/stub.js" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# `agent spawn` has no --surface/--isolation flags, and every builtin profile
# defaults to a visible pane (profiles.ts): a headless run needs a profile file.
cat >"$home/profiles/headless.json" <<'JSON'
{
  "model": "sonnet",
  "allowedTools": [],
  "isolation": "none",
  "surface": "headless"
}
JSON

# The stand-in for `claude`: reconnects and re-registers under the same
# agentId whenever the socket drops, the way a real MCP subprocess's
# `BrokerClient` would. A raw socket loop rather than `BrokerClient` itself —
# that class's `connect()` falls back to SPAWNING A BROKER when its first
# attempt fails, which is exactly what must not happen while this script is
# the only thing allowed to start or stop the broker under test.
cat >"$bin/stub.js" <<'JS'
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const sock = path.join(process.env.AGENT_CHAT_HOME, 'chat.sock')
const logf = path.join(process.env.AGENT_CHAT_HOME, 'stub.log')
const log = m => fs.appendFileSync(logf, `${Date.now()} ${m}\n`)
const frame =
  JSON.stringify({
    t: 'register',
    name: process.env.AGENT_CHAT_NAME,
    agentId: process.env.AGENT_CHAT_AGENT_ID,
    workingOn: 'kill9 rehearsal',
    cwd: process.cwd(),
    pid: process.pid,
  }) + '\n'
function connectLoop() {
  log('connecting')
  const conn = net.connect(sock)
  conn.on('connect', () => {
    log('connected, writing register')
    conn.write(frame)
  })
  conn.on('data', d => log(`data: ${d.toString().trim()}`))
  conn.on('error', e => log(`error: ${e.message}`))
  conn.on('close', () => {
    log('closed')
    setTimeout(connectLoop, 200)
  })
}
connectLoop()
setInterval(() => {}, 3600000)
JS
cat >"$bin/claude" <<SH
#!/bin/sh
exec "$(command -v node)" "$bin/stub.js"
SH
chmod +x "$bin/claude"

start_broker() {
  AGENT_CHAT_HOME="$home" AGENT_CHAT_PORT="$port" AGENT_CHAT_LEDGER_SHADOW=1 PATH="$bin:$PATH" \
    node "$dist" broker >>"$work/broker.out" 2>&1 &
  disown
  for _ in $(seq 1 100); do
    [ -S "$home/chat.sock" ] && [ -f "$home/broker.pid" ] && return 0
    sleep 0.1
  done
  echo "ledger-kill9-check: broker never bound its socket" >&2
  cat "$work/broker.out" >&2
  exit 1
}

doctor() {
  AGENT_CHAT_HOME="$home" AGENT_CHAT_PORT="$port" node "$dist" doctor lifecycle 2>&1
}

echo "ledger-kill9-check: starting the broker in $home"
start_broker

echo "ledger-kill9-check: spawning a headless agent"
spawn_out="$(AGENT_CHAT_HOME="$home" PATH="$bin:$PATH" node "$dist" agent spawn kill9-probe headless "kill -9 rehearsal")"
echo "$spawn_out"
agent_id="$(printf '%s\n' "$spawn_out" | sed -n 's/^Spawned [^ ]* (\([^)]*\))\.$/\1/p')"
[ -n "$agent_id" ] || { echo "ledger-kill9-check: could not read the agent id from: $spawn_out" >&2; exit 1; }

echo "ledger-kill9-check: waiting for /api/lifecycle to settle (the spawn's row reaches running)"
out=""
settled=""
for _ in $(seq 1 150); do
  if out="$(doctor)"; then
    if printf '%s\n' "$out" | grep -q '^shadow on: 0 divergences'; then
      settled=1
      break
    fi
  fi
  sleep 0.2
done
[ -n "$settled" ] || { echo "ledger-kill9-check: never reached a steady lifecycle state before the kill" >&2; printf '%s\n' "$out" >&2; exit 1; }

pid_before="$(cat "$home/broker.pid")"
echo "ledger-kill9-check: kill -9 the broker (pid $pid_before)"
kill -9 "$pid_before"
for _ in $(seq 1 50); do kill -0 "$pid_before" 2>/dev/null || break; sleep 0.1; done

echo "ledger-kill9-check: restarting the broker over the same home"
start_broker

echo "ledger-kill9-check: waiting for the agent to reattach"
out=""
reattached=""
for _ in $(seq 1 300); do
  if out="$(doctor)"; then
    if printf '%s\n' "$out" | grep -q "$agent_id" && printf '%s\n' "$out" | grep -q 'ledger_only_since_restart'; then
      reattached=1
      break
    fi
  fi
  sleep 0.2
done
if [ -z "$reattached" ]; then
  echo "ledger-kill9-check: never saw ledger_only_since_restart for $agent_id after the restart" >&2
  printf '%s\n' "$out" >&2
  echo "--- stub.log ---" >&2
  cat "$home/stub.log" >&2
  echo "--- broker.out ---" >&2
  cat "$work/broker.out" >&2
  exit 1
fi

echo "ledger-kill9-check: doctor lifecycle —"
printf '%s\n' "$out"

classes="$(printf '%s\n' "$out" | grep -E '^(ok|FAIL) ' | awk '{print $2}' | sort -u)"
other="$(printf '%s\n' "$classes" | grep -v '^ledger_only_since_restart$' || true)"
if [ -n "$other" ]; then
  echo "ledger-kill9-check: divergence classes other than ledger_only_since_restart: $other" >&2
  exit 1
fi

integrity="$(sqlite3 "$home/events.db" 'pragma integrity_check;')"
echo "ledger-kill9-check: pragma integrity_check -> $integrity"
[ "$integrity" = "ok" ] || { echo "ledger-kill9-check: integrity_check failed: $integrity" >&2; exit 1; }

echo "ledger-kill9-check: OK"
