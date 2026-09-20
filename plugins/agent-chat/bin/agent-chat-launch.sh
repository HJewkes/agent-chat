#!/usr/bin/env bash
# Launch the agent-chat MCP server for the agent-chat plugin.
#
# The built server lives in the agent-chat repo (dist/ is gitignored), so it is
# deliberately NOT bundled into the plugin. Claude Code copies an installed
# plugin into ~/.claude/plugins/cache and refuses to resolve paths outside that
# copy, so this shim locates the real checkout at spawn time instead.
#
# Resolution order (first hit wins):
#   1. $AGENT_CHAT_ENTRY   — absolute path to dist/cli.js
#   2. $AGENT_CHAT_REPO    — repo root; uses $AGENT_CHAT_REPO/dist/cli.js
#   3. <state dir>/mcp-home — file whose first line is the repo root
#   4. agent-chat on PATH  — an `npm link`ed global bin
#
# NOTE: the repo-root var is AGENT_CHAT_REPO, deliberately NOT AGENT_CHAT_HOME.
# AGENT_CHAT_HOME is already load-bearing in src/paths.ts, where it relocates
# the runtime state dir holding chat.sock and broker.log. Overloading it here
# would silently move the socket and partition sessions from each other.
#
# Set up once:  echo "$PWD" > ~/.agent-chat/mcp-home
#
# node is resolved the same way, because PATH is not dependable here: a login
# shell whose `brew shellenv` failed under load starts Claude Code with no
# homebrew on PATH, `exec node` dies, and Claude Code then caches the failed
# connection for 15 minutes for every session on that account. Order:
#   1. $AGENT_CHAT_NODE     — absolute path to a node binary
#   2. node on PATH
#   3. <state dir>/node-path — file whose first line is that path
#   4. the usual install locations
#
# stdout is the MCP stdio transport — every diagnostic here goes to stderr.

set -euo pipefail

fail() {
  echo "agent-chat: $1" >&2
  exit 1
}

state_dir="${AGENT_CHAT_HOME:-$HOME/.agent-chat}"
entry=""

if [ -n "${AGENT_CHAT_ENTRY:-}" ]; then
  entry="$AGENT_CHAT_ENTRY"
elif [ -n "${AGENT_CHAT_REPO:-}" ]; then
  entry="$AGENT_CHAT_REPO/dist/cli.js"
elif [ -r "$state_dir/mcp-home" ]; then
  read -r repo <"$state_dir/mcp-home" || repo=""
  [ -n "$repo" ] || fail "$state_dir/mcp-home is empty; write the repo root into it."
  entry="$repo/dist/cli.js"
elif command -v agent-chat >/dev/null 2>&1; then
  exec agent-chat "$@"
else
  fail "cannot locate the agent-chat server.
Set AGENT_CHAT_REPO to the repo root, write it to $state_dir/mcp-home, or
\`npm link\` the repo so \`agent-chat\` is on PATH."
fi

[ -f "$entry" ] || fail "no server at $entry — run \`npm run build\` in the agent-chat repo."

resolve_node() {
  local candidate recorded=""
  [ -r "$state_dir/node-path" ] && { read -r recorded <"$state_dir/node-path" || recorded=""; }
  for candidate in "${AGENT_CHAT_NODE:-}" "$(command -v node 2>/dev/null || true)" "$recorded" \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

node_bin="$(resolve_node)" || fail "cannot find node: it is not on PATH ($PATH).
Set AGENT_CHAT_NODE, or write its absolute path to $state_dir/node-path."

exec "$node_bin" "$entry" "$@"
