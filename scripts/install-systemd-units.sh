#!/usr/bin/env bash
# Installs agent-chat-broker.service and agent-chat-redeploy.service as systemd --user units
# (CC-1695), filled in for this checkout, and reloads the user manager. Starts nothing.
# The owner runs it once from their own terminal: the units keep this shell's PATH.
set -euo pipefail

[ -z "${AGENT_CHAT_NAME:-}" ] || {
  echo "install-systemd-units: refusing: this is an agent session; the units would keep its PATH" >&2
  exit 1
}
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
node="$(command -v node)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$dest" "$HOME/.agent-chat"

for unit in agent-chat-broker.service agent-chat-redeploy.service; do
  sed -e "s|@NODE@|$node|g" -e "s|@CLI@|$repo/dist/cli.js|g" -e "s|@REPO@|$repo|g" -e "s|@PATH@|$PATH|g" \
    "$repo/ops/systemd/$unit" > "$dest/$unit"
  echo "installed $dest/$unit"
done
systemctl --user daemon-reload
