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
  reset; lock="$F.lock" release="$scratch/release"
  # held until the verb returns: a fixed hold races the verb's wait on a loaded runner
  sh -c 'mkdir "$1"; while [ ! -e "$2" ]; do sleep 0.1; done; rmdir "$1"' sh "$lock" "$release" & holder=$!
  await_lock; before=$(cksum < "$F")
  expect_fail "a held lock makes the verb wait, then refuse" "locked" done AA-101
  [ "$before" = "$(cksum < "$F")" ] || report "a held lock leaves the file untouched" "file changed"
  touch "$release"; wait $holder; rm -f "$release"
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
t_roots() {
  active="$scratch/active"; aq="$active/claude-channels/sources/autonomy/queues"
  mkdir -p "$aq"; cp "$here/testdata/queue/alpha.md" "$aq/alpha.md"
  rc=$(unset AUTONOMY_ROOT; ACTIVE_ROOT="$active" "$Q" alpha done AA-101 >/dev/null 2>&1; echo $?)
  if [ "$rc" = 0 ] && ! grep -qF AA-101 "$aq/alpha.md"; then
    report "AUTONOMY_ROOT defaults to the autonomy dir under ACTIVE_ROOT" ok
  else report "AUTONOMY_ROOT defaults to the autonomy dir under ACTIVE_ROOT" "exit $rc"; fi
  rc=$(unset AUTONOMY_ROOT ACTIVE_ROOT; "$Q" alpha done AA-101 2>"$scratch/err" >/dev/null; echo $?)
  if [ "$rc" = 2 ] && grep -q 'AUTONOMY_ROOT and ACTIVE_ROOT unset' "$scratch/err"; then
    report "both roots unset fails loudly" ok
  else report "both roots unset fails loudly" "exit $rc: $(cat "$scratch/err")"; fi
}
# replace runs against the prose fixture: id-less items, quotes, $ and backticks
preset() { mkdir -p "$scratch/queues"; cp "$here/testdata/queue/prose.md" "$F"; }
t_replace() {
  name="replace swaps one id-less line and leaves the rest byte-identical"
  preset; run "$name" 0 replace "(status: red)" "(status: green)" || return
  sed 's/(status: red)/(status: green)/' "$here/testdata/queue/prose.md" > "$scratch/want"
  cmp -s "$scratch/want" "$F" && [ -z "$out" ] && report "$name" ok || report "$name" "got: $(cat "$F")"
  preset; expect_fail "replace refuses old text matching twice and names the count" "matches 2 times" \
    replace '$12.50' '$13'
  preset; expect_fail "replace writes nothing when a later pair misses" 'no match for "absent text"' \
    replace "(status: red)" "(status: green)" "absent text" "x"
  preset; expect_fail "replace refuses an empty old text" "empty old" replace "" "x"
  name="replace applies pairs in order, each against the result of the last"
  preset; run "$name" 0 replace "run 41" "run 42" "run 42 (status: red)" "run 42 (status: green)" || return
  has "$name" "CI, run 42 (status: green)" && report "$name" ok
  name="replace with an empty new deletes the text"
  preset; run "$name" 0 replace "Re-held: " "" || return
  has "$name" "- gamma review waits" && report "$name" ok
}
t_replace_stdin() {
  name="replace - takes multi-line blocks and writes \$, backticks, quotes and backslashes literally"
  preset
  out=$("$Q" alpha replace - 2>"$scratch/err" <<'BLOCKS'
<<<
- Cost line reads $12.50 today, $12.50 yesterday
  - sub bullet: no change since 'monday'
===
- Cost line: $HOME `date` 'single' "double" \n \\ done
>>>

<<<
202. Recommend MERGE on repo#41
===
202. Merged repo#41
>>>
BLOCKS
  ); rc=$?
  [ "$rc" -eq 0 ] || { report "$name" "exit $rc: $(cat "$scratch/err")"; return; }
  lacks "$name" "sub bullet: no change" || return
  has "$name" "202. Merged repo#41" || return
  grep -qxF -- '- Cost line: $HOME `date` '"'single'"' "double" \n \\ done' "$F" && report "$name" ok \
    || report "$name" "got: $(grep 'Cost line' "$F")"
  name="replace - refuses an unterminated block with exit 2, file unchanged"
  preset; before=$(cksum < "$F")
  printf '<<<\nRe-held\n===\nx\n' | "$Q" alpha replace - 2>"$scratch/err"; rc=$?
  [ "$rc" -eq 2 ] && grep -q "missing >>>" "$scratch/err" && [ "$before" = "$(cksum < "$F")" ] \
    && report "$name" ok || report "$name" "exit $rc: $(cat "$scratch/err")"
  name="replace - refuses text outside a block with exit 2"
  printf 'Re-held\n' | "$Q" alpha replace - 2>"$scratch/err"; rc=$?
  [ "$rc" -eq 2 ] && grep -q "outside" "$scratch/err" && report "$name" ok || report "$name" "exit $rc"
  name="replace - matches across a line break only as written"
  preset; expect_fail "$name" "no match" replace - <<'BLOCKS'
<<<
1. EP-3 epsilon cleanup
1. Recommend MERGE
===
x
>>>
BLOCKS
}
t_replace_usage() {
  preset; before=$(cksum < "$F")
  "$Q" alpha replace "one" "two" "three" 2>/dev/null; rc=$?
  [ "$rc" -eq 2 ] && [ "$before" = "$(cksum < "$F")" ] && report "replace refuses an odd argv count with exit 2" ok \
    || report "replace refuses an odd argv count with exit 2" "exit $rc"
}
t_replace_size() {
  reset
  printf '\n## Pad\n\n- ' >> "$F"
  base=$(wc -c < "$F" | tr -d ' ')
  awk -v k=$((4990 - base - 1)) 'BEGIN { for (i = 0; i < k; i++) printf "y" }' >> "$F"
  printf '\n' >> "$F"
  expect_fail "replace is refused past 5,000 bytes" "5,000" replace "BB-7 beta work waiting" \
    "BB-7 beta work waiting, with enough extra words to cross the limit"
}
t_set() {
  name="set rewrites the head, drops its sub-lines and keeps the - marker"
  reset; run "$name" 0 set AA-101 AA-101 merged as PR 11 || return
  has "$name" "- AA-101 merged as PR 11" || return
  lacks "$name" "alpha work open" || return
  lacks "$name" "sub bullet mentioning AA-102" || return
  has "$name" "- BB-7 beta work waiting" && report "$name" ok
  name="set on a numbered key keeps the item's own number"
  reset; run "$name" 0 set morning:5 ZZ-10 decided || return
  has "$name" "5. ZZ-10 decided" || return
  lacks "$name" "6. ZZ-10" && report "$name" ok
  name="set on a wrapped Next item drops the wrapped line"
  reset; run "$name" 0 set next:1 AA-201 rewritten || return
  has "$name" "1. AA-201 rewritten" || return
  lacks "$name" "wrapped text line" && report "$name" ok
  reset; expect_fail "set refuses a numbered key with no such item" "no item 9. in section Next" set next:9 x
  reset; expect_fail "set refuses an id naming two items" "CC-5 names 2 items" set CC-5 x
  reset; expect_fail "set refuses empty text" "set needs item text" set BB-7 " "
  reset; expect_fail "set refuses an unknown id" "ZZ-99" set ZZ-99 x
}
t_number() {
  name="done morning:3 removes Morning item 3 and leaves Next item 3"
  reset; run "$name" 0 done morning:3 || return
  lacks "$name" "ZZ-9 owner task" || return
  has "$name" "3. AA-204 third thing" || return
  case "$out" in "3. ZZ-9 owner task") report "$name" ok ;; *) report "$name" "stdout: $out" ;; esac
  name="a numbered key addresses an id-less item"
  preset; run "$name" 0 done morning:202 || return
  lacks "$name" "Recommend MERGE on repo#41" || return
  has "$name" "208. EP-9" && report "$name" ok
  name="move next:2 relocates the numbered item"
  reset; run "$name" 0 move next:2 overflow || return
  has "$name" "- AA-202 second thing" || return
  lacks "$name" "2. AA-202" && report "$name" ok
  name="park next:3 moves the item to Morning with the next number"
  reset; run "$name" 0 park next:3 || return
  has "$name" "6. AA-204 third thing" && report "$name" ok
  reset; expect_fail "a key in a bulleted section finds no numbered item" "no item 1. in section In flight" \
    done in-flight:1
  reset; expect_fail "a key naming an unknown section fails" "unknown section 'nowhere'" done nowhere:1
  reset; expect_fail "done by numbered key checks --pr" "#99" done next:1 --pr 99
}
t_top() {
  name="add --top puts the item first under the heading"
  reset; run "$name" 0 add --top in-flight "Gamma GG-1" || return
  want=$(printf '## In flight\n\n- Gamma GG-1\n- AA-101 alpha work open, PR #11.')
  got=$(grep -A3 '^## In flight' "$F")
  [ "$got" = "$want" ] && report "$name" ok || report "$name" "got: $got"
  name="add --top replaces the none placeholder"
  reset; run "$name" 0 add --top overflow "Eps EE-3" || return
  lacks "$name" "none" || return
  has "$name" "- Eps EE-3" && report "$name" ok
  reset; "$Q" alpha add --top next 2>/dev/null; rc=$?
  [ "$rc" -eq 2 ] && report "add --top without text is a usage error" ok \
    || report "add --top without text is a usage error" "exit $rc"
}
t_bytes() {
  name="a write reports its size on stderr and keeps done's stdout"
  reset; run "$name" 0 done BB-7 || return
  size=$(wc -c < "$F" | tr -d ' ')
  [ "$out" = "- BB-7 beta work waiting" ] || { report "$name" "stdout: $out"; return; }
  [ "$err" = "bin/queue: $size of 5000 bytes" ] && report "$name" ok || report "$name" "stderr: $err"
  name="a failed write reports no size"
  reset; run "$name" 1 done ZZ-99
  case "$err" in *"of 5000 bytes"*) report "$name" "stderr: $err" ;; *) report "$name" ok ;; esac
}
# backlog pointer ids (CC-760) are lowercase, may carry a dotted sub-id, and live in Morning
t_backlog_id() {
  name="done tc-131 removes the Morning pointer and leaves ZZ-9"
  reset; run "$name" 0 done tc-131 || return
  lacks "$name" "tc-131" || return
  has "$name" "3. ZZ-9 owner task" && report "$name" ok
  name="done tc-130.2 removes only that item, not tc-130"
  reset; run "$name" 0 done tc-130.2 || return
  lacks "$name" "sub-question pointer" || return
  has "$name" "4. tc-130 (two-way): parent question pointer" && report "$name" ok
  name="done tc-130 removes only that item, not tc-130.2"
  reset; run "$name" 0 done tc-130 || return
  lacks "$name" "parent question pointer" || return
  has "$name" "2. tc-130.2 (two-way)" && report "$name" ok
  reset; expect_fail "done on a task id in Morning still searches In flight and Next only" \
    "in In flight or Next" done ZZ-9
  reset; expect_fail "a backlog id with no item fails loudly" "no item anywhere names tc-999" done tc-999
  reset; expect_fail "a four-letter lowercase prefix is not a backlog id" "task id" done abcd-1
}
t_done; t_done_all; t_done_next; t_done_pr; t_park; t_add; t_move
t_leading; t_blank; t_lock; t_race
t_size; t_failures; t_missing; t_atomic; t_roots
t_replace; t_replace_stdin; t_replace_usage; t_replace_size
t_set; t_number; t_top; t_bytes; t_backlog_id
echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
