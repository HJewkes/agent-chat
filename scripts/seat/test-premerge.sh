#!/bin/bash
# Cases for bin/premerge against stub gh, a temp sqlite db and a temp git repo.
set -u
. "$(dirname "$0")/testdata/premerge/lib.sh"
setup_repo; setup_db

run() { out=$("$BIN/premerge" "$R" "$N" "${1:-$SHA}" "$W/clone" "${2:-}" 2>&1); rc=$?; }
empty_rules() { echo '[]' > "$W/case/rules_branches_main.json"; echo 404 > "$W/case/branches_main_protection_required_status_checks.status"; }
CR=commits_SHA_check_runs_per_page_100.json
ok_case() { new_case "${1:-$CLEAN}"; add_verdict seat-9-review msg0001 MERGE "$SHA"; }

ok_case; run;                                              check "OK" 0 "^OK .*actor=seat-9-review msg=msg0001"
ok_case; mut pulls_7.json '.head.sha="ffff"'; run;         check "head moved" 1 "^FAIL .*head ffff"
ok_case; mut pulls_7.json '.state="closed"'; run;          check "PR closed" 1 "^FAIL .*state=closed"
ok_case; mut commits_SHA_check_runs_per_page_100.json '.check_runs[1].conclusion="failure"'; run
check "required context not green" 1 "^FAIL .*req lint"
ok_case; mut commits_SHA_check_runs_per_page_100.json 'del(.check_runs[1])'; run
check "required context missing" 1 "^FAIL .*req lint"
ok_case; mut commits_SHA_check_runs_per_page_100.json '.check_runs[1].app.id=999'; run
check "wrong app id" 1 "^FAIL .*req lint"
ok_case; mut commits_SHA_check_runs_per_page_100.json '.check_runs[1].app.id=999'
echo '{"statuses":[{"context":"lint","state":"success"}]}' > "$W/case/commits_SHA_status.json"; run
check "wrong app id but green commit status" 0 "^OK "
ok_case; mut rules_branches_main.json '.[0].parameters.strict_required_status_checks_policy=true'
echo '{"behind_by":3}' > "$W/case/compare_main___SHA.json"; run
check "strict and behind" 1 "^FAIL .*strict and behind_by=3"
ok_case "$CONF"; run;                                      check "merge-tree conflict" 1 "^FAIL .*merge-tree conflict"
ok_case; add_verdict seat-9-review msg0002 FIX_FIRST "$SHA"; run
check "latest verdict FIX_FIRST" 1 "^FAIL .*not MERGE"
new_case "$MERGED"; add_verdict seat-9-review msg0005 MERGE "$MERGED"; run "$MERGED" "$CLEAN"
check "verdict head differs from reviewed head" 1 "^FAIL .*!= reviewed"
new_case "$CLEAN"; add_verdict coord-a msg0003 MERGE "$SHA"; run
check "verdict only from a coordinator" 1 "^FAIL .*no verdict from a reviewer"
ok_case; add_verdict seat-9-review msg0004 MERGE "$SHA" 77; run
check "verdict for a PR with the same number prefix is ignored" 0 "^OK .*msg=msg0001"
ok_case; echo '[]' > "$W/case/rules_branches_main.json"
echo '{"contexts":["validate","lint"],"strict":false}' > "$W/case/branches_main_protection_required_status_checks.json"; run
check "classic protection fallback" 0 "^OK .*req=\[validate,lint\]"
ok_case; empty_rules; mut commits_SHA_check_runs_per_page_100.json '.check_runs[1].conclusion="failure"'; run
check "no required list, a run is red" 1 "^FAIL .*no required list; not green: lint"
ok_case; empty_rules; run;       check "no required list, all green" 0 "^OK "

# 1: rulesets and classic protection errors are FAIL, never "all green"
ok_case; rm "$W/case/rules_branches_main.json"; echo 500 > "$W/case/rules_branches_main.status"; run
check "1 rulesets API 500" 1 "^FAIL .*rulesets api status 500"
ok_case; rm "$W/case/rules_branches_main.json"; run;       check "1 rulesets fetch fails outright" 1 "^FAIL .*rulesets api status"
ok_case; empty_rules; echo 500 > "$W/case/branches_main_protection_required_status_checks.status"; run
check "1 classic protection API 500" 1 "^FAIL .*classic protection api status 500"
ok_case; empty_rules; echo 404 > "$W/case/branches_main_protection_required_status_checks.status"; run
check "1 classic protection 404 is no protection" 0 "^OK "
ok_case; empty_rules; echo '{"contexts":["lint"],"strict":true}' > "$W/case/branches_main_protection_required_status_checks.json"
echo '{"behind_by":2}' > "$W/case/compare_main___SHA.json"; run
check "1 classic strict is kept" 1 "^FAIL .*strict and behind_by=2"
ok_case; empty_rules; echo '{"contexts":["nosuch"],"strict":false}' > "$W/case/branches_main_protection_required_status_checks.json"; run
check "1 classic required context with no run" 1 "^FAIL .*req nosuch"

# 2: check-runs, status and compare failures or wrong shapes are FAIL
ok_case; empty_rules; rm "$W/case/$CR"; run;               check "2 check-runs fetch fails" 1 "^FAIL .*check-runs api status"
ok_case; empty_rules; echo '{"check_runs":"x"}' > "$W/case/$CR"; run;  check "2 check-runs not an array" 1 "^FAIL .*check-runs unexpected shape"
ok_case; rm "$W/case/commits_SHA_status.json"; run;        check "2 status fetch fails" 1 "^FAIL .*status api status"
ok_case; rm "$W/case/compare_main___SHA.json"; run;        check "2 compare fetch fails" 1 "^FAIL .*compare api status"
ok_case; echo '{}' > "$W/case/compare_main___SHA.json"; run; check "2 compare has no behind_by" 1 "^FAIL .*compare unexpected shape"
ok_case; empty_rules; echo '{"check_runs":[]}' > "$W/case/$CR"; run
check "2 no required list and zero check runs" 1 "^FAIL .*no check runs"

# 3, 4: who may give the verdict and what it must say
new_case "$CLEAN"; add_verdict seat-9-impl msg0006 MERGE "$SHA"; run
check "3 implementer's own MERGE is ignored" 1 "^FAIL .*no verdict from a reviewer"
new_case "$CLEAN"; add_verdict seat-9-impl msg0006 MERGE "$SHA"; add_verdict seat-9-review msg0007 MERGE "$SHA"; run
check "3 reviewer verdict beats a later-in-list implementer row" 0 "^OK .*actor=seat-9-review"
ok_case; mut pulls_7.json '.head.ref="agent-chat/seat-9-review"'; run
check "3 reviewer that is also the branch agent" 1 "^FAIL .*no verdict from a reviewer"
new_case "$CLEAN"; add_verdict alice msg0008 MERGE "$SHA"; REVIEWER_PATTERN='^alice$' run
check "3 REVIEWER_PATTERN env overrides the default" 0 "^OK .*actor=alice"
new_case "$CLEAN"; add_verdict rv-1 msg0008 MERGE "$SHA"; run;   check "3 rv- prefix is a reviewer" 0 "^OK .*actor=rv-1"
new_case "$CLEAN"; add_verdict seat-9-review-r2 msg0008 MERGE "$SHA"; run;   check "3 -review-rN suffix is a reviewer" 0 "^OK "
new_case "$CLEAN"; add_verdict seat-9-review msg0009 "MERGE-BLOCKED do not" "$SHA"; run
check "4 MERGE-BLOCKED is not MERGE" 1 "^FAIL .*not MERGE"
new_case "$CLEAN"; add_verdict seat-9-review msg0009 "MERGE with nits" "$SHA"; run
check "4 MERGE followed by a space is MERGE" 0 "^OK "

# 5: S differs from RV only by a merge of the base branch
new_case "$MERGED"; add_verdict seat-9-review msg0010 MERGE "$CLEAN"; run "$MERGED" "$CLEAN"
check "5 base merged into the reviewed head" 0 "^OK .*head=$MERGED"
new_case "$CHILD"; add_verdict seat-9-review msg0010 MERGE "$CLEAN"; run "$CHILD" "$CLEAN"
check "5 extra commit on top of the reviewed head" 1 "^FAIL .*not a two-parent merge"
new_case "$BADTREE"; add_verdict seat-9-review msg0010 MERGE "$CLEAN"; run "$BADTREE" "$CLEAN"
check "5 merge with extra content in the tree" 1 "^FAIL .*differs from reviewed"
new_case "$NOTBASE"; add_verdict seat-9-review msg0010 MERGE "$CLEAN"; run "$NOTBASE" "$CLEAN"
check "5 merged parent is not on the base branch" 1 "^FAIL .*not in origin/main"
new_case "$MERGED"; add_verdict seat-9-review msg0010 MERGE "$CONF"; run "$MERGED" "$CONF"
check "5 reviewed head is not a parent" 1 "^FAIL .*not a parent"

# 6: the base fetch must succeed and the head must exist locally
ok_case; git -C "$W/clone" remote set-url origin "$W/nowhere.git"; run; git -C "$W/clone" remote set-url origin "$W/origin.git"
check "6 git fetch fails" 1 "^FAIL .*git fetch of main failed"
GONE=$(printf 'c%.0s' {1..40}); new_case "$GONE"; add_verdict seat-9-review msg0011 MERGE "$GONE"; run "$GONE"
check "6 head commit missing locally" 1 "^FAIL .*not available locally"

# 7: newest verdict from a reviewer or coordinator decides
ok_case; add_verdict coord-a msg0012 FIX_FIRST "$SHA"; run
check "7 newer coordinator FIX_FIRST beats older MERGE" 1 "^FAIL .*not MERGE"
new_case "$CLEAN"; add_verdict seat-9-review msg0012 FIX_FIRST "$SHA"; add_verdict seat-9-review msg0013 MERGE "$SHA"; run
check "7 newer reviewer MERGE beats older FIX_FIRST" 0 "^OK .*msg=msg0013"
ok_case; add_verdict coord-a msg0012 MERGE "$SHA"; run
check "7 newer coordinator MERGE does not replace the reviewer's" 0 "^OK .*actor=seat-9-review"
ok_case; add_verdict seat-9-review msg0014 WAIT "$SHA"; run
check "7 newer reviewer WAIT beats older MERGE at the same head" 1 "^FAIL .*latest verdict not MERGE: Verdict: WAIT"
new_case "$CLEAN"; add_verdict seat-9-review msg0014 WAIT "$SHA"; add_verdict seat-9-review msg0015 MERGE "$SHA"; run
check "7 reviewer MERGE after WAIT at the same head passes" 0 "^OK .*msg=msg0015"

# 8: arguments are validated before use
out=$("$BIN/premerge" 'acme/wid gets' 7 "$SHA" "$W/clone" 2>&1); rc=$?;   check "8 bad repo" 2 "^bad argument"
out=$("$BIN/premerge" "$R" 7x "$SHA" "$W/clone" 2>&1); rc=$?;             check "8 bad PR number" 2 "^bad argument"
out=$("$BIN/premerge" "$R" 7 abc123 "$W/clone" 2>&1); rc=$?;              check "8 short head sha" 2 "^bad argument"
out=$("$BIN/premerge" "$R" 7 "$CLEAN" "$W/clone" "zz$CLEAN" 2>&1); rc=$?; check "8 bad reviewed head" 2 "^bad argument"

# 9: required contexts with spaces print intact
ok_case; mut rules_branches_main.json '.[0].parameters.required_status_checks=[{"context":"build (20)"},{"context":"lint"}]'
mut "$CR" '.check_runs[0].name="build (20)"'; run
check "9 context with a space" 0 "^OK .*req=\[build (20),lint\]"
# 10: free-plan private repos answer 403 "Upgrade to GitHub Pro" for both rule calls
UP='{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}'
upgrade_403s() {
  rm -f "$W/case/rules_branches_main.json"
  echo 403 > "$W/case/rules_branches_main.status"; echo "$UP" > "$W/case/rules_branches_main.body"
  echo 403 > "$W/case/branches_main_protection_required_status_checks.status"
  echo "$UP" > "$W/case/branches_main_protection_required_status_checks.body"
}
ok_case; upgrade_403s; run;                                check "10a Upgrade 403 on both, all runs green" 0 "^OK .*req=\[\]"
ok_case; upgrade_403s; mut "$CR" '.check_runs[1].conclusion="failure"'; run
check "10b Upgrade 403 on both, a run failed" 1 "^FAIL .*not green: lint"
ok_case; upgrade_403s; echo '{"check_runs":[]}' > "$W/case/$CR"; run
check "10c Upgrade 403 on both, zero check runs" 1 "^FAIL .*no check runs"
ok_case; upgrade_403s; echo '{"message":"API rate limit exceeded for user"}' > "$W/case/rules_branches_main.body"; run
check "10d rulesets 403 rate limit" 1 "^FAIL .*rulesets api status 403"
ok_case; upgrade_403s; : > "$W/case/rules_branches_main.body"; run
check "10e rulesets 403 with no JSON body" 1 "^FAIL .*rulesets api status 403"
ok_case; upgrade_403s; echo '{"message":"Resource protected by organization SAML enforcement"}' > "$W/case/branches_main_protection_required_status_checks.body"; run
check "10f classic 403 other than Upgrade" 1 "^FAIL .*classic protection api status 403"
# 11: a context pinned to an app (integration_id) needs a green run from that app; statuses never count
pin_lint() { mut rules_branches_main.json '.[0].parameters.required_status_checks[1].integration_id=4242'; }
ok_case; pin_lint; mut "$CR" '.check_runs[1].app.id=4242'; run
check "11a pinned context green from the pinned app" 0 "^OK .*req=\[lint,validate\]"
ok_case; pin_lint; run;                                    check "11b pinned context green from another app" 1 "^FAIL .*req lint: pinned app=4242 run=none"
ok_case; pin_lint; mut "$CR" 'del(.check_runs[1])'; run;   check "11c pinned context absent" 1 "^FAIL .*req lint: pinned app=4242"
ok_case; pin_lint; echo '{"statuses":[{"context":"lint","state":"success"}]}' > "$W/case/commits_SHA_status.json"; run
check "11d pinned context with only a green commit status" 1 "^FAIL .*req lint: pinned"
ok_case; pin_lint; mut "$CR" '.check_runs[1].app.id=4242 | .check_runs[1].conclusion="failure"'; run
check "11e pinned context red from the pinned app" 1 "^FAIL .*req lint: pinned app=4242 run=failure"
ok_case; mut rules_branches_main.json '. + [{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint","integration_id":4242}]}}]'; run
check "11f pin from a second rule applies to the union" 1 "^FAIL .*req lint: pinned app=4242"
# 12: S is RV plus up to five base merges on its first-parent chain (TP-1626)
WK=$W/work
grow_main() {
  local i
  for i in 1 2 3 4 5 6; do
    git -C "$WK" checkout -q main; echo "$i" > "$WK/b$i"; git -C "$WK" add "b$i"; git -C "$WK" commit -qm "b$i"
    B[i]=$(git -C "$WK" rev-parse HEAD)
  done
  git -C "$W/origin.git" fetch -q "$WK" main:main
}
# chain <branch> <start> <base index>...: merges those base commits onto start in turn.
chain() {
  local i; git -C "$WK" checkout -q -b "$1" "$2"; shift 2
  for i in "$@"; do git -C "$WK" merge -q --no-edit "${B[i]}"; done
}
grow_main
chain two "$CLEAN" 1 2; chain three "$CLEAN" 1 2 3; chain five "$CLEAN" 1 2 3 4 5; chain six "$CLEAN" 1 2 3 4 5 6
chain evil "$CLEAN" 1; git -C "$WK" merge -q --no-commit "${B[2]}" >/dev/null 2>&1; echo evil > "$WK/g"; git -C "$WK" commit -qam evil
chain plain "$CLEAN" 1; echo y > "$WK/h"; git -C "$WK" add h; git -C "$WK" commit -qm plain; chain plain2 plain 2 3
chain offbase "$NOTBASE" 1
git -C "$W/clone" fetch -q "$WK" 'refs/heads/*:refs/remotes/work/*'
tip() { git -C "$WK" rev-parse "$1"; }
rv_case() { new_case "$1"; add_verdict seat-9-review msg0016 MERGE "$CLEAN"; run "$1" "$CLEAN"; }
rv_case "$(tip two)";     check "12 two base merges with a clean tree" 0 "^OK .*head=$(tip two)"
rv_case "$(tip three)";   check "12 three base merges" 0 "^OK "
rv_case "$(tip five)";    check "12 five base merges, the cap" 0 "^OK "
rv_case "$(tip evil)";    check "12 base merge resolution edits a PR file" 1 "^FAIL .*differs from reviewed $CLEAN plus its base merges"
rv_case "$(tip plain2)";  check "12 non-merge commit in the chain" 1 "^FAIL .*reaches non-merge $(tip plain) before reviewed"
rv_case "$(tip offbase)"; check "12 earlier merge parent not in origin/main" 1 "^FAIL .*merged parent $(tip side) is not in origin/main"
rv_case "$(tip six)";     check "12 six base merges is over the cap" 1 "^FAIL .*more than 5 base merges past reviewed"
# Unordered base parents: an older newest parent would let the squash drop or revert base commits (TP-1626 review).
mk() { git -C "$WK" commit-tree "$1" -m probe "${@:2}"; }
mtree() { git -C "$WK" merge-tree --write-tree "$1" "$2" | head -1; }
ROOT=$(git -C "$WK" rev-list --max-parents=0 main)
M6=$(mk "$(mtree "${B[6]}" "$CLEAN")" -p "$CLEAN" -p "${B[6]}"); OLDNEW=$(mk "$(mtree "${B[1]}" "$CLEAN")" -p "$M6" -p "${B[1]}")
M1=$(tip two^); ROOTNEW=$(mk "$CLEAN^{tree}" -p "$M1" -p "$ROOT")
MARKERS=$(mk "$(git -C "$WK" merge-tree --write-tree "$MAINSHA" "$CONF" | head -1)" -p "$CONF" -p "$MAINSHA")
chain evil2 "$CLEAN"; git -C "$WK" merge -q --no-commit "${B[1]}" >/dev/null 2>&1; echo evil > "$WK/g"; git -C "$WK" commit -qam evil2
git -C "$WK" merge -q --no-edit "${B[2]}"
git -C "$WK" branch -q probes "$MARKERS"; for c in "$OLDNEW" "$ROOTNEW"; do git -C "$WK" tag "p${c:0:8}" "$c"; done
git -C "$W/clone" fetch -q "$WK" 'refs/heads/*:refs/remotes/work/*' 'refs/tags/*:refs/tags/*'
rv_case "$OLDNEW";       check "12 newest merged parent older than an earlier one" 1 "^FAIL .*earlier merged parent ${B[6]} is not in newest merged parent ${B[1]}"
rv_case "$ROOTNEW";      check "12 root commit as newest merged parent with the reviewed tree" 1 "^FAIL .*earlier merged parent ${B[1]} is not in newest merged parent $ROOT"
rv_case "$(tip evil2)";  check "12 evil deeper merge under a clean newest merge" 1 "^FAIL .*differs from reviewed $CLEAN plus its base merges"
new_case "$MARKERS"; add_verdict seat-9-review msg0017 MERGE "$CONF"; run "$MARKERS" "$CONF"
check "12 single merge carrying conflict markers" 1 "^FAIL .*reviewed $CONF conflicts with merged parent $MAINSHA"
# The tp#552 shape: base touched the PR's file too, so the base merge was regenerated; that needs a new verdict.
git -C "$WK" checkout -q main; echo base-gen > "$WK/g"; git -C "$WK" add g; git -C "$WK" commit -qm regen; B[7]=$(tip main)
git -C "$W/origin.git" fetch -q "$WK" main:main
chain regen "$(tip two)"; git -C "$WK" merge -q --no-edit "${B[7]}" >/dev/null 2>&1; echo regenerated > "$WK/g"; git -C "$WK" commit -qam regen >/dev/null 2>&1
git -C "$W/clone" fetch -q "$WK" regen:refs/remotes/work/regen
rv_case "$(tip regen)";   check "12 regenerated conflict resolution in a base merge" 1 "^FAIL .*reviewed $CLEAN conflicts with merged parent ${B[7]}"
finish
