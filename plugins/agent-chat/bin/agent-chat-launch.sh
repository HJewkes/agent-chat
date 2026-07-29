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

exec node "$entry" "$@"
