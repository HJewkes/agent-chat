#!/bin/sh
# Tee a Claude Code status-line payload into a per-session budget file.
#
# Reads the status-line JSON on stdin and writes a normalised subset to
# ~/.claude/status-cache/sessions/<session_id>.json, which agent-chat's
# `session_budget` tool reads. Installed into the user's status-line script by
# one guarded line; see docs/context-budget-research.md.
#
# Every failure path exits 0. This runs inside the status line, and a status
# line that errors is a status line the user turns off.
set -u

CACHE_DIR="${AGENT_CHAT_STATUS_CACHE:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/status-cache/sessions}"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
[ -n "$input" ] || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
[ -n "$session_id" ] || exit 0

# The id becomes a path segment, so anything outside the uuid alphabet is dropped
# rather than sanitised: a surprising id means a payload we do not understand.
case "$session_id" in
    *[!A-Za-z0-9_-]*) exit 0 ;;
esac

mkdir -p "$CACHE_DIR" 2>/dev/null || exit 0

tmp="$CACHE_DIR/.$session_id.$$"
printf '%s' "$input" | jq -c --argjson now "$(date +%s)" '{
    session_id: .session_id,
    cwd: (.workspace.current_dir // .cwd // null),
    model_id: (.model.id // null),
    written_at: $now,
    context: {
        used_pct: (.context_window.used_percentage // null),
        remaining_pct: (.context_window.remaining_percentage // null),
        window_size: (.context_window.context_window_size // null),
        input_tokens: (.context_window.total_input_tokens // null),
        output_tokens: (.context_window.total_output_tokens // null),
        cache_read_tokens: (.context_window.current_usage.cache_read_input_tokens // null),
        cache_creation_tokens: (.context_window.current_usage.cache_creation_input_tokens // null),
        exceeds_200k: (.exceeds_200k_tokens // false)
    },
    cost: {
        total_cost_usd: (.cost.total_cost_usd // null),
        total_duration_ms: (.cost.total_duration_ms // null),
        total_api_duration_ms: (.cost.total_api_duration_ms // null),
        lines_added: (.cost.total_lines_added // null),
        lines_removed: (.cost.total_lines_removed // null)
    },
    rate_limits: (.rate_limits // {})
}' >"$tmp" 2>/dev/null && mv -f "$tmp" "$CACHE_DIR/$session_id.json" 2>/dev/null
rm -f "$tmp" 2>/dev/null

# One session leaves one file behind forever otherwise. Gated on a stamp so the
# directory scan happens hourly, not on every status-line redraw.
stamp="$CACHE_DIR/.pruned"
if [ ! -f "$stamp" ] || [ -n "$(find "$CACHE_DIR" -maxdepth 1 -name .pruned -mmin +60 2>/dev/null)" ]; then
    find "$CACHE_DIR" -maxdepth 1 -name '*.json' -mtime +1 -delete 2>/dev/null
    : >"$stamp" 2>/dev/null
fi

exit 0
