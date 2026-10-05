#!/bin/bash
# Cases for bin/task-note against the real active-work CLI pointed at a temp ACTIVE_ROOT.
set -u
BIN=${BIN_OVERRIDE:-$(cd "$(dirname "$0")" && pwd)}
W=${TMPDIR:-/tmp}/seat-test-task-note/$$
rm -rf "$W"; mkdir -p "$W"
export ACTIVE_ROOT=$W/root TMPDIR=$W
pass=0 failn=0
TASK=$ACTIVE_ROOT/demo/tasks/D-1.yml

fresh() {
  rm -rf "$ACTIVE_ROOT" "$W"/task-note-*.lock; mkdir -p "$ACTIVE_ROOT"
  active-work new --title t demo >/dev/null 2>&1; active-work task add demo --title x >/dev/null 2>&1
}
notes() { python3 -c 'import sys,yaml; v=yaml.safe_load(open(sys.argv[1])).get("notes"); print(type(v).__name__+":"+repr(v))' "$TASK"; }
check() { # name, expected notes repr
  local got; got=$(notes)
  if [ "$got" = "$2" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: want $2 got $got"; failn=$((failn+1)); fi
}

fresh; "$BIN/task-note" demo D-1 "-leading dash" >/dev/null 2>&1;   check "note starting with a dash" "str:'-leading dash'"
fresh; "$BIN/task-note" demo D-1 "123" >/dev/null 2>&1;             check "numeric note stays a string" "str:'123'"
fresh; "$BIN/task-note" demo D-1 "true" >/dev/null 2>&1;            check "boolean-looking note stays a string" "str:'true'"
fresh; "$BIN/task-note" demo D-1 ":colon" >/dev/null 2>&1;          check "leading colon stays a string" "str:':colon'"
fresh; "$BIN/task-note" demo D-1 first >/dev/null 2>&1; "$BIN/task-note" demo D-1 second >/dev/null 2>&1
check "second note appends after the first" "str:'first\nsecond'"
fresh; for i in 1 2 3 4 5; do "$BIN/task-note" demo D-1 "n$i" >/dev/null 2>&1 & done; wait
got=$(notes); n=$(grep -o 'n[1-5]' <<<"$got" | sort -u | wc -l | tr -d ' ')
[ "$n" = 5 ] && { echo "PASS concurrent appends all survive"; pass=$((pass+1)); } || { echo "FAIL concurrent appends: $got"; failn=$((failn+1)); }
fresh; mkdir "$W/task-note-demo-D-1.lock"; out=$(LOCK_TRIES=2 "$BIN/task-note" demo D-1 x 2>&1); rc=$?
[ "$rc" = 1 ] && grep -q "^FAIL lock busy" <<<"$out" && [ "$(notes)" = "NoneType:None" ] \
  && { echo "PASS held lock fails and writes nothing"; pass=$((pass+1)); } || { echo "FAIL held lock: rc=$rc $out"; failn=$((failn+1)); }
fresh; out=$("$BIN/task-note" demo D-9 x 2>&1); rc=$?
[ "$rc" = 1 ] && grep -q "^FAIL no task file" <<<"$out" && { echo "PASS missing task fails"; pass=$((pass+1)); } || { echo "FAIL missing task: rc=$rc $out"; failn=$((failn+1)); }
fresh; out=$(env -u ACTIVE_ROOT "$BIN/task-note" demo D-1 x 2>&1); rc=$?
[ "$rc" = 2 ] && grep -q "^ACTIVE_ROOT unset" <<<"$out" && [ "$(notes)" = "NoneType:None" ] \
  && { echo "PASS unset ACTIVE_ROOT fails and writes nothing"; pass=$((pass+1)); } || { echo "FAIL unset ACTIVE_ROOT: rc=$rc $out"; failn=$((failn+1)); }
fresh; ls "$W"/task-note-*.lock >/dev/null 2>&1; "$BIN/task-note" demo D-1 y >/dev/null 2>&1
ls "$W"/task-note-*.lock >/dev/null 2>&1 && { echo "FAIL lock left behind"; failn=$((failn+1)); } || { echo "PASS lock released"; pass=$((pass+1)); }
echo "$pass passed, $failn failed"; rm -rf "$W"; [ "$failn" = 0 ]
