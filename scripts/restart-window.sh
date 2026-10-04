#!/usr/bin/env bash
# The daily broker restart: pre-check, update the CLI, restart, post-check (CC-210).
# Running it needs the owner's approval of the day's window. There is no --force on purpose.
#
# Exit codes:
#   0  restart-window OK
#   1  a pre-check refused, or the restart's own guard refused; the broker was not touched, and
#      after a guard refusal the checkout is rolled back to the old commit and build
#   2  a post-check failed; the new build is live and the old one is kept as node_modules.prev
#      and dist.prev (the message names the rollback command)
#   3  the restart failed; the checkout was rolled back to the old commit and build and the
#      broker restarted on it, and if that restart failed too the broker may be down
#      (run: agent-chat service start)
#   4  fetch, staged install or staged build failed, or the swap failed; the broker was not
#      touched and the live src, node_modules and dist are on the old commit
#
# Install and build run in a staging copy of the fetched commit beside the checkout
# (<checkout>.staging), never in the live tree, so a failed `npm ci` cannot empty node_modules
# under the running broker. The staged node_modules and dist are renamed into the checkout, and
# the checkout fast-forwarded to that commit, only when both steps passed. The old node_modules
# and dist stay beside them as .prev until the post-checks pass.
set -euo pipefail

[ $# -eq 0 ] || { echo "restart-window: takes no arguments; --force is the owner's call" >&2; exit 1; }

log_dir="${AGENT_CHAT_HOME:-$HOME/.agent-chat}"
PUSH_RE='(^|/)git( -[Cc] [^ ]+| --[^ ]+)* push( |$)|(^|/)git-remote-http'
MERGE_RE='(^|/)seat-merge( |$)|(^|/)bin/merge( |$)|(^|/)gh pr merge( |$)|(agent-chat|index\.js) gh-write( |$)'
blockers=()

running() { pgrep -f "$1" 2>/dev/null | sort -un | paste -sd, - || true; }

# The commit the kept .prev build was made from, in the git dir so it never dirties the tree.
head_file() { echo "$(git -C "$1" rev-parse --absolute-git-dir)/restart-window-old-head"; }

# One command that puts back the old commit and every kept .prev build, then restarts.
rollback_cmd() { # rollback_cmd <checkout> <old head, or empty when unknown>
  local cmd="cd $1" name
  [ -z "$2" ] || cmd+=" && git reset --keep $2"
  for name in node_modules dist; do
    [ ! -e "$1/$name.prev" ] || cmd+=" && mv $name $name.aside && mv $name.prev $name && rm -rf $name.aside"
  done
  echo "$cmd && agent-chat service restart"
}

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
    if [ -e "$repo/node_modules.prev" ] || [ -e "$repo/dist.prev" ]; then
      prev_head="$(cat "$(head_file "$repo")" 2>/dev/null || true)"
      blockers+=("a .prev build is left from an earlier run in $repo; to roll back: $(rollback_cmd "$repo" "$prev_head"); to keep the current build: rm -rf $repo/node_modules.prev $repo/dist.prev $(head_file "$repo")")
    fi
  fi
fi

if [ ${#blockers[@]} -gt 0 ]; then
  for b in "${blockers[@]}"; do echo "restart-window: refusing: $b" >&2; done
  exit 1
fi

# Swaps staged <name> into the checkout. Renames stay on one filesystem, so the live copy is
# only ever absent between two adjacent renames, and a failed rename puts it back.
swap_in() { # swap_in <stage> <live> <name>
  [ ! -e "$2/$3" ] || mv "$2/$3" "$2/$3.prev" || return 1
  mv "$1/$3" "$2/$3" || { [ ! -e "$2/$3.prev" ] || mv "$2/$3.prev" "$2/$3"; return 1; }
}

# Puts back every kept .prev build. The live copy is renamed aside rather than deleted first, so
# it is absent only between two renames while a broker may still be loading from it.
restore_prev() {
  local name ok=0
  for name in node_modules dist; do
    [ -e "$repo/$name.prev" ] || continue
    rm -rf "${repo:?}/$name.aside"
    [ ! -e "$repo/$name" ] || mv "$repo/$name" "$repo/$name.aside" || { ok=1; continue; }
    if mv "$repo/$name.prev" "$repo/$name"; then
      rm -rf "${repo:?}/$name.aside"
    else
      [ ! -e "$repo/$name.aside" ] || mv "$repo/$name.aside" "$repo/$name"
      ok=1
    fi
  done
  [ "$ok" -ne 0 ] || rm -f "$(head_file "$repo")"
  return $ok
}

# Fails only when the build could not be put back. A failed src reset is reported, not fatal:
# the old build is what the broker runs, so it should still be restarted on it.
roll_back() {
  restore_prev || return 1
  git -C "$repo" reset -q --keep "$old_head" ||
    echo "restart-window: the old build is back but src is not; run: git -C $repo reset --keep $old_head" >&2
}

# Fetch and build before the restart, so the broker never starts on old dist while node_modules
# changes. Live src stays on the old commit until the build is swapped in.
stage="$repo.staging"
old_head="$(git -C "$repo" rev-parse HEAD)"
stage_and_swap() {
  git fetch -q origin main || return 1
  local new_head
  new_head="$(git rev-parse FETCH_HEAD)" || return 1
  git merge-base --is-ancestor HEAD "$new_head" || { echo "restart-window: origin/main is not a fast-forward of HEAD" >&2; return 1; }
  rm -rf "$stage" && mkdir "$stage" || return 1
  git archive "$new_head" | tar -x -C "$stage" || return 1
  (cd "$stage" && npm ci && npm run build) || return 1
  echo "$old_head" > "$(head_file "$repo")" || return 1
  swap_in "$stage" "$repo" node_modules || return 1
  swap_in "$stage" "$repo" dist || { restore_prev; return 1; }
  git merge -q --ff-only "$new_head" || { restore_prev; return 1; }
}
if ! (cd "$repo" && stage_and_swap); then
  rm -rf "$stage"
  echo "restart-window: fetch, install or build failed; the broker was not touched" >&2
  exit 4
fi
rm -rf "$stage"

# Floored to the second, which can only widen the window by under a second.
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
set +e
restart_out="$(agent-chat service restart 2>&1)"
restart_code=$?
set -e
[ -z "$restart_out" ] || echo "$restart_out"
if [ "$restart_code" -ne 0 ]; then
  if [[ "$restart_out" == "refusing to restart:"* ]]; then
    roll_back || echo "restart-window: putting the old build back failed; to finish: $(rollback_cmd "$repo" "$old_head")" >&2
    echo "restart-window: refusing: the broker has work in flight (message above)" >&2
    exit 1
  fi
  echo "restart-window: the restart failed; rolling back to $old_head and restarting on it" >&2
  if roll_back && agent-chat service restart; then
    echo "restart-window: rolled back; the broker runs the old build"
  else
    echo "BROKER MAY BE DOWN: run agent-chat service start"
  fi
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
    for (const f of [`${dir}/broker.log`, `${dir}/broker.log.1`]) {
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

if [ "$failed" -ne 0 ]; then
  echo "restart-window: the old build is kept; to roll back: $(rollback_cmd "$repo" "$old_head")"
  exit 2
fi
rm -rf "$repo/node_modules.prev" "$repo/dist.prev" "$(head_file "$repo")"
echo "restart-window OK"
