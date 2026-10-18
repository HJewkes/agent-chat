#!/bin/sh
# Fixture test for backlog (CC-765): lint rules, add, list, due, resolve, close, root resolution.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-backlog.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
B="$here/backlog"
R="$here/testdata/backlog/records"
S="$scratch/root/backlog/seat-a"
LOG="$scratch/calls.log"
pass=0 failn=0

printf '#!/bin/sh\necho "task-note $*" >> "%s"\n' "$LOG" > "$scratch/task-note"
printf '#!/bin/sh\necho "queue $*" >> "%s"\n' "$LOG" > "$scratch/queue"
chmod +x "$scratch/task-note" "$scratch/queue"
export AUTONOMY_ROOT="$scratch/root" BACKLOG_TASK_NOTE="$scratch/task-note" BACKLOG_QUEUE="$scratch/queue"
unset BACKLOG_NOW

report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
# run <name> <expected-exit> <backlog args...>; leaves $out, $err
run() {
  name=$1 want=$2; shift 2
  out=$("$B" "$@" 2>"$scratch/err"); rc=$?
  err=$(cat "$scratch/err")
  [ "$rc" -eq "$want" ] || { report "$name" "exit $rc, want $want: $err"; return 1; }
}
says() { case "$2" in *"$3"*) ;; *) report "$1" "'$2' lacks '$3'"; return 1 ;; esac; }
store() { rm -rf "$scratch/root" "$LOG"; mkdir -p "$S"; for id in "$@"; do cp "$R/$id.yml" "$S/"; done; }
field() { grep -E "^$2:" "$S/$1.yml" | sed "s/^$2: *//"; }
# bad <name> <needle> <fixture> <sed script>: the mutated fixture fails lint with needle
bad() {
  name=$1 needle=$2 fixture=$3; shift 3
  sed "$@" "$R/$fixture.yml" > "$scratch/bad.yml"
  run "$name" 1 lint "$scratch/bad.yml" && says "$name" "$err" "$needle" && report "$name" ok
}

t_lint() {
  run "lint passes every fixture" 0 lint "$R/tc-131.yml" "$R/tc-130.2.yml" "$R/tc-129.yml" &&
    report "lint passes every fixture" ok
  bad "lint fails a missing trade_off" "trade_off is missing" tc-131 '/^trade_off:/d'
  bad "lint fails a bare-heading option" "bare heading" tc-131 's/proposed: Approve.*/proposed: "Option A:"/'
  bad "lint fails a long option that ends in a colon" "bare heading" tc-131 's/proposed: Approve.*/proposed: "Approve the plan as follows:"/'
  bad "lint fails visual with no captures" "visual is set with no captures" tc-130.2 's/^visual: null/visual: {captures: []}/'
  bad "lint fails pr without gate_reason" "pr needs url, summary and gate_reason" tc-131 '/gate_reason:/d'
  bad "lint fails a recommended option that is not a key" "is not an option key" tc-131 's/  option: A/  option: C/'
  bad "lint fails id tc-130_2" "is not like tc-131" tc-130.2 's/^id: tc-130.2/id: tc-130_2/'
  bad "lint fails a one-way door with no why_owner" "needs why_owner" tc-131 '/^why_owner:/d'
  bad "lint fails a capture outside <id>/img/" "under tc-131/img/" tc-131 's|file: tc-131/img/after|file: img/after|'
  bad "lint fails a capture that climbs out with .." "under tc-131/img/" tc-131 's|file: tc-131/img/after.png|file: tc-131/img/../../escaped.png|'
  bad "lint fails a capture with an absolute path" "under tc-131/img/" tc-131 's|file: tc-131/img/after.png|file: /tmp/after.png|'
  bad "lint fails a capture with a . segment" "under tc-131/img/" tc-131 's|file: tc-131/img/after.png|file: tc-131/./img/after.png|'
}
t_add() {
  store; cp -R "$R/tc-131" "$scratch/"; sed '/^opened_at:/d' "$R/tc-131.yml" > "$scratch/tc-131.yml"
  name="add stores the record, its captures, status open and opened_at"
  BACKLOG_NOW=2026-10-11T09:00:00Z run "$name" 0 add seat-a "$scratch/tc-131.yml" || return
  [ -f "$S/tc-131/img/after.png" ] || { report "$name" "capture not copied"; return; }
  [ "$(field tc-131 status)" = open ] && [ "$(field tc-131 opened_at)" = 2026-10-11T09:00:00.000Z ] &&
    report "$name" ok || report "$name" "status $(field tc-131 status), opened_at $(field tc-131 opened_at)"
  run "add refuses an existing record" 1 add seat-a "$R/tc-131.yml" && says "add refuses an existing record" "$err" exists &&
    report "add refuses an existing record" ok
  run "add refuses a record for another seat" 1 add seat-b "$R/tc-130.2.yml" &&
    says "add refuses a record for another seat" "$err" "is not 'seat-b'" && report "add refuses a record for another seat" ok
}
# draft <dir>: a tc-131 draft with its captures in <dir>, for the symlink cases
draft() { rm -rf "$1"; mkdir -p "$1"; cp -R "$R/tc-131" "$R/tc-131.yml" "$1/"; }
# refuses <name> <needle> <draft dir>: add exits 1 with needle, writes no record and nothing outside the store
refuses() {
  run "$1" 1 add seat-a "$3/tc-131.yml" && says "$1" "$err" "$2" || return
  [ ! -f "$S/tc-131.yml" ] && [ ! -e "$scratch/outside/after.png" ] && report "$1" ok || report "$1" "wrote through"
}
t_add_escape() {
  store; mkdir -p "$scratch/outside"
  sed 's|file: tc-131/img/after.png|file: tc-131/img/../../escaped.png|' "$R/tc-131.yml" > "$scratch/esc.yml"
  name="add refuses a .. capture and writes nothing outside the record"
  run "$name" 1 add seat-a "$scratch/esc.yml" && [ ! -e "$S/escaped.png" ] && [ ! -e "$scratch/root/escaped.png" ] &&
    report "$name" ok
  store; mkdir -p "$S/tc-131"; ln -s "$scratch/outside" "$S/tc-131/img"; draft "$scratch/d1"
  refuses "add refuses a store img dir that is a symlink" "is a symlink" "$scratch/d1"
  store; mkdir -p "$S/tc-131/img"; ln -s "$scratch/outside/after.png" "$S/tc-131/img/after.png"; draft "$scratch/d2"
  refuses "add refuses a destination capture that is a symlink" "is a symlink" "$scratch/d2"
  store; draft "$scratch/d3"; printf secret > "$scratch/outside/secret"
  rm "$scratch/d3/tc-131/img/after.png"; ln -s "$scratch/outside/secret" "$scratch/d3/tc-131/img/after.png"
  refuses "add refuses a source capture that is a symlink" "is a symlink" "$scratch/d3"
  store; draft "$scratch/d4"; mv "$scratch/d4/tc-131/img" "$scratch/outside/img4"; ln -s "$scratch/outside/img4" "$scratch/d4/tc-131/img"
  refuses "add refuses a source img dir that is a symlink" "through a symlink" "$scratch/d4"
  rm -rf "$scratch/outside"
}
t_list() {
  store tc-131 tc-130.2 tc-129; name="list --status filters the store"
  run "$name" 0 list seat-a --status deferred || return
  [ "$(printf '%s\n' "$out" | cut -f1)" = tc-129 ] && report "$name" ok || report "$name" "out: $out"
}
t_due() {
  store tc-131 tc-130.2 tc-129; name="due lists nothing at 11 h 59 m"
  BACKLOG_NOW=2026-10-10T11:59:00Z run "$name" 0 due || return
  [ -z "$out" ] && [ "$(field tc-129 status)" = deferred ] && report "$name" ok || report "$name" "out: $out"
  name="due lists the open two-way at 12 h 1 m, never the one-way"
  BACKLOG_NOW=2026-10-10T12:01:00Z run "$name" 0 due || return
  [ "$out" = "$S/tc-130.2.yml" ] && report "$name" ok || report "$name" "out: $out"
  name="due reopens an expired defer with the clock restarted"
  says "$name" "$err" "reopened tc-129" || return
  [ "$(field tc-129 status)" = open ] && [ -z "$(field tc-129 deferred_until)" ] &&
    [ "$(field tc-129 opened_at)" = 2026-10-10T12:01:00.000Z ] && report "$name" ok || report "$name" "record not reopened"
}
t_resolve() {
  store tc-130.2; name="resolve --by decider without --cite fails and leaves the record"
  run "$name" 1 resolve tc-130.2 --by decider --answer A --confidence 0.8 || return
  says "$name" "$err" "needs --cite" && [ "$(field tc-130.2 status)" = open ] && [ ! -f "$LOG" ] && report "$name" ok
  run "resolve refuses an answer that is not a key" 1 resolve tc-130.2 --by decider --answer C --cite d1 --confidence 0.8 &&
    says "resolve refuses an answer that is not a key" "$err" "is not one of A, B" && report "resolve refuses an answer that is not a key" ok
  name="resolve --by decider --cite sets decided and notes the task"
  BACKLOG_NOW=2026-10-11T00:00:00Z run "$name" 0 resolve tc-130.2 --by decider --answer A --cite decisions.md#12 --confidence 0.8 || return
  [ "$(field tc-130.2 status)" = decided ] || { report "$name" "status $(field tc-130.2 status)"; return; }
  says "$name" "$(cat "$LOG")" "task-note claude-channels CC-760 [tc-130.2] decider: A (cite decisions.md#12" && report "$name" ok
  run "resolve refuses a record that is not open" 1 resolve tc-130.2 --escalate --answer A --rationale r &&
    says "resolve refuses a record that is not open" "$err" "is decided, not open" && report "resolve refuses a record that is not open" ok
}
t_escalate() {
  store tc-130.2
  run "escalate without --rationale is a usage error" 2 resolve tc-130.2 --escalate --answer A &&
    report "escalate without --rationale is a usage error" ok
  name="escalate sets escalated and notes the task"
  run "$name" 0 resolve tc-130.2 --escalate --answer B --rationale "no precedent" || return
  [ "$(field tc-130.2 status)" = escalated ] && says "$name" "$(cat "$LOG")" "[tc-130.2] decider escalated, leaning B" &&
    report "$name" ok
}
t_close() {
  store tc-131; name="close moves the record to closed/ and runs queue done"
  run "$name" 0 close tc-131 || return
  [ ! -f "$S/tc-131.yml" ] && grep -q '^status: closed' "$S/closed/tc-131.yml" || { report "$name" "file not moved"; return; }
  says "$name" "$(cat "$LOG")" "queue seat-a done tc-131" && report "$name" ok
  run "close of a closed record fails" 1 close tc-131 && says "close of a closed record fails" "$err" "no open record" && report "close of a closed record fails" ok
}
t_roots() {
  name="both roots unset: exit 2"
  out=$(env -u AUTONOMY_ROOT -u ACTIVE_ROOT "$B" list 2>&1); rc=$?
  [ "$rc" -eq 2 ] && says "$name" "$out" "AUTONOMY_ROOT and ACTIVE_ROOT unset" && report "$name" ok ||
    { [ "$rc" -eq 2 ] || report "$name" "exit $rc: $out"; }
  name="ACTIVE_ROOT alone finds the autonomy store"
  mkdir -p "$scratch/active/claude-channels/sources/autonomy/backlog/seat-a"
  cp "$R/tc-129.yml" "$scratch/active/claude-channels/sources/autonomy/backlog/seat-a/"
  out=$(env -u AUTONOMY_ROOT ACTIVE_ROOT="$scratch/active" "$B" list 2>&1)
  says "$name" "$out" "tc-129" && report "$name" ok
}
t_lint; t_add; t_add_escape; t_list; t_due; t_resolve; t_escalate; t_close; t_roots
echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
