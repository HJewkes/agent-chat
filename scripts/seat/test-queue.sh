#!/bin/sh
# Fixture test for bin/queue: every verb and every failure case.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-queue.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
export AUTONOMY_ROOT="$scratch"
Q="$here/queue"
F="$scratch/queues/alpha.md"
pass=0 failn=0

reset() { mkdir -p "$scratch/queues"; cp "$here/testdata/queue/alpha.md" "$F"; }
report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
# run <name> <expected-exit> <queue args...>; leaves $out, $err, $rc
run() {
  name=$1 want=$2; shift 2
  out=$("$Q" alpha "$@" 2>"$scratch/err"); rc=$?
  err=$(cat "$scratch/err")
  [ "$rc" -eq "$want" ] || { report "$name" "exit $rc, want $want: $err"; return 1; }
}
has() { grep -qF -- "$2" "$F" || { report "$1" "missing: $2"; return 1; }; }
lacks() { ! grep -qF -- "$2" "$F" || { report "$1" "still present: $2"; return 1; }; }
# expect_fail <name> <needle> <queue args...>: exit 1, message has needle, file unchanged
expect_fail() {
  name=$1 needle=$2; shift 2
  before=$(cksum < "$F")
  run "$name" 1 "$@" || return 0
  case "$err" in *"$needle"*) ;; *) report "$name" "message '$err' lacks '$needle'"; return 0 ;; esac
  [ "$before" = "$(cksum < "$F")" ] || { report "$name" "file changed"; return 0; }
  report "$name" ok
}
finish() { [ -n "${1:-}" ] && report "$1" ok; }

t_done() {
  reset; run "done removes item block with sub-bullets" 0 done AA-101 || return
  lacks "done removes item block with sub-bullets" "AA-101" || return
  lacks "done removes item block with sub-bullets" "AA-102" || return
  has "done removes item block with sub-bullets" "BB-7" || return
  case "$out" in *"AA-101 alpha work"*"AA-102"*) report "done removes item block with sub-bullets" ok ;;
    *) report "done removes item block with sub-bullets" "stdout: $out" ;; esac
}
t_done_all() {
  reset; run "done removes every item naming the task" 0 done CC-5 || return
  lacks "done removes every item naming the task" "CC-5" || return
  lacks "done removes every item naming the task" "CC-6" || return
  report "done removes every item naming the task" ok
}
t_done_next() {
  reset; run "done removes a wrapped item from Next" 0 done AA-201 || return
  lacks "done removes a wrapped item from Next" "wrapped text line" || return
  has "done removes a wrapped item from Next" "AA-202" || return
  report "done removes a wrapped item from Next" ok
}
t_done_pr() {
  reset; run "done --pr accepts a matching PR" 0 done AA-101 --pr 11 || return
  lacks "done --pr accepts a matching PR" "AA-101" || return
  report "done --pr accepts a matching PR" ok
  reset; expect_fail "done --pr refuses a PR the item lacks" "#12" done AA-101 --pr 12
  reset; expect_fail "done --pr does not match #1 inside #11" "#1" done AA-101 --pr 1
}
t_park() {
  reset; run "park moves item to Morning with next number" 0 park BB-7 || return
  lacks "park moves item to Morning with next number" "- BB-7 beta work" || return
  has "park moves item to Morning with next number" "6. BB-7 beta work waiting" || return
  report "park moves item to Morning with next number" ok
  reset; run "park carries sub-bullets and renumbers from Next" 0 park AA-201 || return
  has "park carries sub-bullets and renumbers from Next" "6. AA-201 first thing" || return
  has "park carries sub-bullets and renumbers from Next" "   wrapped text line" || return
  report "park carries sub-bullets and renumbers from Next" ok
}
t_add() {
  reset; run "add to a bulleted section" 0 add in-flight "Gamma work GG-1" || return
  has "add to a bulleted section" "- Gamma work GG-1" || return
  report "add to a bulleted section" ok
  reset; run "add to a numbered section takes the next number" 0 add next "Delta DD-2" || return
  has "add to a numbered section takes the next number" "4. Delta DD-2" || return
  report "add to a numbered section takes the next number" ok
  reset; run "add replaces the none placeholder in Overflow" 0 add overflow "Eps EE-3" || return
  lacks "add replaces the none placeholder in Overflow" "none" || return
  has "add replaces the none placeholder in Overflow" "- Eps EE-3" || return
  report "add replaces the none placeholder in Overflow" ok
  reset; run "add matches sections case-insensitively by prefix" 0 add MORN "Zeta" || return
  has "add matches sections case-insensitively by prefix" "6. Zeta" || return
  report "add matches sections case-insensitively by prefix" ok
}
t_move() {
  reset; run "move to a numbered section renumbers" 0 move BB-7 next || return
  has "move to a numbered section renumbers" "4. BB-7 beta work waiting" || return
  lacks "move to a numbered section renumbers" "- BB-7 beta work" || return
  report "move to a numbered section renumbers" ok
  reset; run "move to a bulleted section drops the number" 0 move AA-202 overflow || return
  has "move to a bulleted section drops the number" "- AA-202 second thing" || return
  lacks "move to a bulleted section drops the number" "2. AA-202 second" || return
  lacks "move to a bulleted section drops the number" "none" || return
  report "move to a bulleted section drops the number" ok
  reset; run "move finds an item in Morning" 0 move ZZ-10 inflight || return
  has "move finds an item in Morning" "- ZZ-10 owner task" || return
  report "move finds an item in Morning" ok
}
t_size() {
  reset
  printf '\n## Pad\n\n- ' >> "$F"
  base=$(wc -c < "$F" | tr -d ' ')
  awk -v k=$((4990 - base - 1)) 'BEGIN { for (i = 0; i < k; i++) printf "y" }' >> "$F"
  printf '\n' >> "$F"
  [ "$(wc -c < "$F" | tr -d ' ')" -eq 4990 ] || { report "fixture builds a 4,990-byte file" "wrong size"; return; }
  expect_fail "add is refused at 4,990 bytes" "5,000" add next "This line pushes the file past the limit"
  run "a small add still fits at 4,990 bytes" 0 add next "ok" || return
  report "a small add still fits at 4,990 bytes" ok
}
t_failures() {
  reset; expect_fail "unknown id fails loudly (done)" "ZZ-99" done ZZ-99
  expect_fail "id only in Morning is not done-able" "ZZ-9" done ZZ-9
  expect_fail "id prefix is not a whole word" "AA-10" done AA-10
  expect_fail "id with a longer fraction is not a match" "AA-203" done AA-203
  expect_fail "unknown id fails loudly (park)" "ZZ-99" park ZZ-99
  expect_fail "unknown id fails loudly (move)" "ZZ-99" move ZZ-99 next
  expect_fail "park refuses an id naming two items" "CC-5" park CC-5
  expect_fail "move refuses an id naming two items" "CC-5" move CC-5 next
  expect_fail "move refuses an unknown section" "section" move BB-7 nowhere
  expect_fail "add refuses an unknown section" "section" add nowhere "text"
  expect_fail "malformed id is refused" "task id" done bogus
}
t_missing() {
  before=$(ls "$scratch/queues")
  out=$("$Q" ghost done AA-1 2>"$scratch/err"); rc=$?
  if [ "$rc" -eq 1 ] && grep -q "ghost" "$scratch/err" && [ "$before" = "$(ls "$scratch/queues")" ]; then
    report "missing seat file fails and writes nothing" ok
  else report "missing seat file fails and writes nothing" "rc=$rc"; fi
}
t_atomic() {
  reset; "$Q" alpha add next "Atomic AT-1" >/dev/null
  if ls "$scratch/queues" | grep -q '^\.queue\.'; then report "no temp files left behind" "leftover"
  else report "no temp files left behind" ok; fi
}

# seed <text>: replace the fixture with a one-section file holding the text
seed() { reset; printf '# Queue: alpha\n\n## In flight\n\n%b\n\n## Next\n\n1. NX-1 filler\n' "$1" > "$F"; }
t_leading() {
  for v in "done" "park" "move"; do
    reset; a=; [ "$v" = move ] && a=next
    expect_fail "$v refuses an id that is only mentioned mid-line" "line(s) 8" $v CC-6 $a
  done
  reset; expect_fail "done refuses an id that is only in a sub-bullet" "line(s) 6" done AA-102
  seed '- BB-1 after AA-1\n- AA-1 real item'
  run "done AA-1 keeps the item that mentions AA-1 later" 0 done AA-1 || return
  has "done AA-1 keeps the item that mentions AA-1 later" "BB-1 after AA-1" || return
  lacks "done AA-1 keeps the item that mentions AA-1 later" "- AA-1 real" || return
  report "done AA-1 keeps the item that mentions AA-1 later" ok
  seed '- AA-1 block\n  - sub bullet mentions AA-2\n- AA-2 real item'
  run "done AA-2 keeps an AA-1 block that mentions AA-2 in a sub-bullet" 0 done AA-2 || return
  has "done AA-2 keeps an AA-1 block that mentions AA-2 in a sub-bullet" "sub bullet mentions AA-2" || return
  lacks "done AA-2 keeps an AA-1 block that mentions AA-2 in a sub-bullet" "- AA-2 real" || return
  report "done AA-2 keeps an AA-1 block that mentions AA-2 in a sub-bullet" ok
  reset; run "done matches a **AA-7:** leading id" 0 done AA-7 || return
  lacks "done matches a **AA-7:** leading id" "bold lead" || return
  report "done matches a **AA-7:** leading id" ok
  reset; run "done matches a repo#12 leading id" 0 done repo#12 || return
  lacks "done matches a repo#12 leading id" "slash-style" || return
  has "done matches a repo#12 leading id" "short-number" || return
  report "done matches a repo#12 leading id" ok
  reset; run "done repo#1 does not match repo#12" 0 done repo#1 || return
  has "done repo#1 does not match repo#12" "slash-style" || return
  lacks "done repo#1 does not match repo#12" "short-number" || return
  report "done repo#1 does not match repo#12" ok
  seed '- BAA-1 not ours\n- AA-2 ours'
  expect_fail "an id inside a longer word is not reported as a mention" "no item" done AA-1
}
# the blank line around a deleted block must collapse to one
t_blank() {
  seed '- AA-1 first\n\n- AA-2 middle\n\n- AA-3 last'
  run "done between two blank lines leaves exactly one" 0 done AA-2 || return
  want=$(printf '# Queue: alpha\n\n## In flight\n\n- AA-1 first\n\n- AA-3 last\n\n## Next\n\n1. NX-1 filler\n')
  [ "$(cat "$F")" = "$want" ] && report "done between two blank lines leaves exactly one" ok \
    || report "done between two blank lines leaves exactly one" "got: $(cat "$F")"
}
await_lock() { n=0; while [ ! -d "$lock" ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n + 1)); done; }
t_lock() {
  reset; lock="$F.lock"
  sh -c 'mkdir "$1"; sleep 7; rmdir "$1"' sh "$lock" & holder=$!
  await_lock; before=$(cksum < "$F")
  expect_fail "a held lock makes the verb wait, then refuse" "locked" done AA-101
  [ "$before" = "$(cksum < "$F")" ] || report "a held lock leaves the file untouched" "file changed"
  wait $holder
  reset; sh -c 'mkdir "$1"; sleep 1; rmdir "$1"' sh "$lock" & holder=$!
  await_lock
  run "a lock released within the wait lets the verb proceed" 0 done AA-101 || { wait $holder; return; }
  wait $holder; lacks "a lock released within the wait lets the verb proceed" "AA-101" || return
  report "a lock released within the wait lets the verb proceed" ok
  reset; mkdir "$lock"; touch -t 202001010000 "$lock"
  run "a stale lock is taken over" 0 done AA-101 || return
  lacks "a stale lock is taken over" "AA-101" || return
  [ ! -d "$lock" ] && report "a stale lock is taken over" ok || report "a stale lock is taken over" "lock left behind"
  reset; "$Q" alpha done AA-101 >/dev/null
  [ ! -d "$lock" ] && report "the lock is removed after a normal run" ok || report "the lock is removed after a normal run" "lock left behind"
  reset; "$Q" alpha done NOPE-1 >/dev/null 2>&1
  [ ! -d "$lock" ] && report "the lock is removed after a failed run" ok || report "the lock is removed after a failed run" "lock left behind"
}
# a shim awk edits the file after the read, as a concurrent editor would
t_race() {
  reset; shim="$scratch/shim"; mkdir -p "$shim"; real=$(command -v awk)
  printf '#!/bin/sh\necho "- RACE-1 concurrent edit" >> "%s"\nexec %s "$@"\n' "$F" "$real" > "$shim/awk"
  chmod +x "$shim/awk"
  before=$(PATH="$shim:$PATH"; "$Q" alpha done BB-7 2>"$scratch/err" >/dev/null; echo $?)
  if [ "$before" = 1 ] && grep -q "changed" "$scratch/err" && has "a change between read and write is refused" "RACE-1" \
     && has "a change between read and write is refused" "BB-7 beta work"; then
    report "a change between read and write is refused, nothing written" ok
  else report "a change between read and write is refused, nothing written" "rc=$before $(cat "$scratch/err")"; fi
}
t_done; t_done_all; t_done_next; t_done_pr; t_park; t_add; t_move
t_leading; t_blank; t_lock; t_race
t_size; t_failures; t_missing; t_atomic
echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
