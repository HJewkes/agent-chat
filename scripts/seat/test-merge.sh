#!/bin/bash
# Cases for bin/merge: the PUT runs only after premerge says OK.
set -u
. "$(dirname "$0")/testdata/premerge/lib.sh"
setup_repo; setup_db

run() { out=$("$BIN/merge" "$R" "$N" "$SHA" "$W/clone" "$@" 2>&1); rc=$?; }
puts() { [ -f "$STUB_LOG" ] && grep -c -- '^--$' "$STUB_LOG" || echo 0; }
no_put() { [ "$(puts)" = 0 ] && echo "PASS $1: no PUT" && pass=$((pass+1)) || { echo "FAIL $1: PUT ran"; failn=$((failn+1)); }; }
# expected_put: the stub agent-chat log of one squash PUT carrying the stub formatter's output for this case.
expected_put() {
  printf '%s\n' gh-write -- api -X PUT "repos/$R/pulls/$N/merge" -f merge_method=squash -f sha="$SHA" \
    -f "commit_title=$(jq -r '"\(.title) (#\(.prNumber))"' "$W/case/fmt.in")" -f "commit_message=$(jq -r .body "$W/case/fmt.in")"
  echo ---
}
ok_case() { new_case "$CLEAN"; add_verdict seat-9-review msg0001 MERGE "$SHA"; }

ok_case; run;                                     check "OK merges" 0 "^OK merged $R#$N squash mergesha"
[ "$(puts)" = 1 ] && echo "PASS OK: exactly one PUT" && pass=$((pass+1)) || { echo "FAIL OK: PUT count $(puts)"; failn=$((failn+1)); }
grep -q -- "^Reviewer seat-9-review Verdict: MERGE at head ${SHA:0:8} (msg msg0001)\..*Merged by test-seat\.$" "$STUB_LOG" \
  && { echo "PASS commit_message carries reviewer, head and msg_id"; pass=$((pass+1)); } || { echo "FAIL commit_message"; failn=$((failn+1)); }
[ "$(cat "$STUB_LOG")" = "$(expected_put)" ] \
  && { echo "PASS PUT sends the formatter's subject and body verbatim"; pass=$((pass+1)); } || { echo "FAIL PUT is not the formatter output: $(cat "$STUB_LOG")"; failn=$((failn+1)); }
jq -e --arg c "Reviewer seat-9-review Verdict: MERGE at head ${SHA:0:8} (msg msg0001)." \
  '.title == "WID-12: Add the widget sorter" and .prNumber == 7 and .taskIds == ["WID-12"] and (.body | startswith("Sorts widgets by size.\n\n" + $c))
   and .commits[0] == {subject: "Add the widget sorter", body: "Sorts by size.\n\nCo-authored-by: T <t@example.com>"}' "$W/case/fmt.in" >/dev/null \
  && { echo "PASS formatter input holds the PR, its commits and the citation"; pass=$((pass+1)); } || { echo "FAIL formatter input: $(cat "$W/case/fmt.in")"; failn=$((failn+1)); }
grep -qiE -- "co-authored-by|signed-off-by|@example\.com" "$STUB_LOG" \
  && { echo "FAIL PUT carries a trailer or email"; failn=$((failn+1)); } || { echo "PASS PUT carries no trailer or email"; pass=$((pass+1)); }
grep -q -- "^merge_method=squash$" "$STUB_LOG" && grep -q -- "^sha=$SHA$" "$STUB_LOG" \
  && { echo "PASS PUT pins squash and head sha"; pass=$((pass+1)); } || { echo "FAIL PUT flags"; failn=$((failn+1)); }

ok_case; mut pulls_7.json '.head.sha="ffff"'; run;  check "FAIL head moved" 1 "^FAIL "; no_put "head moved"
ok_case; mut commits_SHA_check_runs_per_page_100.json '.check_runs[0].conclusion="failure"'; run
check "FAIL required context red" 1 "^FAIL "; no_put "required context red"
new_case "$CLEAN"; add_verdict coord-b msg0009 MERGE "$SHA"; run
check "FAIL verdict from coordinator only" 1 "^FAIL "; no_put "coordinator-only verdict"
ok_case; add_verdict seat-9-review msg0002 FIX_FIRST "$SHA"; run
check "FAIL FIX_FIRST" 1 "^FAIL "; no_put "FIX_FIRST"
new_case "$CONF"; add_verdict seat-9-review msg0003 MERGE "$SHA"; run
check "FAIL merge-tree conflict" 1 "^FAIL "; no_put "merge-tree conflict"

ok_case; out=$(env -u SEAT "$BIN/merge" "$R" "$N" "$SHA" "$W/clone" 2>&1); rc=$?
check "FAIL without SEAT" 1 "^FAIL SEAT"; no_put "no SEAT"
ok_case; SQUASH_MESSAGE_BIN=no-such-formatter run;  check "FAIL when the formatter is missing" 1 "^FAIL squash message: no-such-formatter not found"; no_put "formatter missing"
ok_case; STUB_FMT_FAIL=1 run;                       check "FAIL when the formatter exits 2" 1 "^FAIL squash message: titan-squash-message exited 2"; no_put "formatter exit 2"
ok_case; rm "$W/case/pulls_7_commits_per_page_100.json"; run
check "FAIL when the PR commits cannot be read" 1 "^FAIL squash message: cannot read pulls/7/commits"; no_put "commits unreadable"
ok_case; STUB_PUT_FAIL=1 run;                       check "FAIL when the PUT is rejected" 1 "^FAIL merge PUT"
ok_case; WAIT_INTERVAL=0 run --wait-main;           check "--wait-main green" 0 "^MAIN green"
ok_case; mut commits_mergesha_check_runs_per_page_100.json '.check_runs[0].conclusion="failure"'; WAIT_INTERVAL=0 run --wait-main
check "--wait-main red names the failing check, exit 3" 3 "^MAIN red post-merge"
ok_case; mut commits_mergesha_check_runs_per_page_100.json '.check_runs[0].status="in_progress"'; WAIT_INTERVAL=1 WAIT_MAX=1 run --wait-main
check "--wait-main timeout, exit 4" 4 "^MAIN timeout"
new_case "$MERGED"; add_verdict seat-9-review msg0020 MERGE "$CLEAN"; out=$("$BIN/merge" "$R" "$N" "$MERGED" "$W/clone" "$CLEAN" 2>&1); rc=$?
check "OK merges a base-merge head" 0 "^OK merged"
grep -q -- "^Reviewer seat-9-review Verdict: MERGE at head ${CLEAN:0:8} .*Merged head $MERGED is the reviewed head plus a merge" "$STUB_LOG" \
  && { echo "PASS commit_message carries S when RV differs"; pass=$((pass+1)); } || { echo "FAIL commit_message with differing S"; failn=$((failn+1)); }
out=$("$BIN/merge" "$R" "$N" bad "$W/clone" 2>&1); rc=$?;   check "FAIL on a bad argument names the reason" 1 "^FAIL premerge: bad argument"
ok_case; out=$(env -u COORDINATORS "$BIN/merge" "$R" "$N" "$SHA" "$W/clone" 2>&1); rc=$?; check "FAIL on unset COORDINATORS" 1 "^FAIL premerge: COORDINATORS unset"; no_put "unset COORDINATORS"
finish
