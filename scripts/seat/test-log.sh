#!/bin/sh
# Fixture test for bin/log: the journal it appends to, the stamp, and each refusal.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-log.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
L="$here/log"
pass=0 failn=0

report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
# run <name> <expected-exit> <log args...>; leaves $err, $rc
run() {
  name=$1 want=$2; shift 2
  "$L" "$@" 2>"$scratch/err"; rc=$?
  err=$(cat "$scratch/err")
  [ "$rc" -eq "$want" ] || { report "$name" "exit $rc, want $want: $err"; return 1; }
}

root="$scratch/autonomy"
mkdir -p "$root/logs/alpha"
J="$root/logs/alpha/$(date +%F).md"

AUTONOMY_ROOT="$root" run "appends to the seat journal under AUTONOMY_ROOT" 0 alpha first entry \
  && { grep -q ' first entry$' "$J" 2>/dev/null && report "appends to the seat journal under AUTONOMY_ROOT" ok \
    || report "appends to the seat journal under AUTONOMY_ROOT" "journal: $(cat "$J" 2>&1)"; }
grep -Eq '^[0-2][0-9]:[0-5][0-9] first entry$' "$J" 2>/dev/null && report "each line starts with an HH:MM stamp" ok \
  || report "each line starts with an HH:MM stamp" "journal: $(cat "$J" 2>&1)"

AUTONOMY_ROOT="$root" run "a second entry is appended, not overwritten" 0 alpha second entry \
  && { [ "$(wc -l < "$J" | tr -d ' ')" -eq 2 ] && report "a second entry is appended, not overwritten" ok \
    || report "a second entry is appended, not overwritten" "journal: $(cat "$J")"; }

AUTONOMY_ROOT="$root" run "an unknown seat is refused" 1 nosuch text \
  && { case "$err" in *"no log dir for seat 'nosuch'"*) report "an unknown seat is refused" ok ;;
    *) report "an unknown seat is refused" "message: $err" ;; esac; }
[ ! -e "$root/logs/nosuch" ] && report "an unknown seat gets no journal" ok || report "an unknown seat gets no journal" "dir created"

AUTONOMY_ROOT="$root" run "a missing text is a usage error" 2 alpha && report "a missing text is a usage error" ok

active="$scratch/active"
mkdir -p "$active/claude-channels/sources/autonomy/logs/alpha"
(unset AUTONOMY_ROOT; ACTIVE_ROOT="$active" "$L" alpha from active root 2>"$scratch/err"); rc=$?
grep -q ' from active root$' "$active/claude-channels/sources/autonomy/logs/alpha/$(date +%F).md" 2>/dev/null \
  && [ "$rc" -eq 0 ] && report "AUTONOMY_ROOT defaults to the autonomy dir under ACTIVE_ROOT" ok \
  || report "AUTONOMY_ROOT defaults to the autonomy dir under ACTIVE_ROOT" "exit $rc: $(cat "$scratch/err")"

(unset AUTONOMY_ROOT ACTIVE_ROOT; "$L" alpha text 2>"$scratch/err"); rc=$?
[ "$rc" -eq 2 ] && grep -q 'AUTONOMY_ROOT and ACTIVE_ROOT unset' "$scratch/err" \
  && report "both roots unset fails loudly" ok || report "both roots unset fails loudly" "exit $rc: $(cat "$scratch/err")"

echo "log: $pass passed, $failn failed"
[ "$failn" -eq 0 ]
