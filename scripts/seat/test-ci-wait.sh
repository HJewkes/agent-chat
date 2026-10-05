#!/bin/bash
# Cases for bin/ci-wait against a fake gh that serves canned JSON per call count.
set -u
BIN=${BIN_OVERRIDE:-$(cd "$(dirname "$0")" && pwd)}
W=${TMPDIR:-/tmp}/seat-test-ci-wait/$$
rm -rf "$W"; mkdir -p "$W"
pass=0 failn=0

cat > "$W/gh" <<'FAKE'
#!/bin/bash
# Serves $FIX/<kind>.<n> (a --slurp page array) by call count, or the highest file past the end. "FAIL" exits 1.
# Without --paginate it returns only page one, as the real gh does.
kind=runs; case "$*" in */status*) kind=status ;; esac
echo "$*" >> "$FIX/calls"
n=$(( $(cat "$FIX/$kind.count" 2>/dev/null || echo 0) + 1 )); echo $n > "$FIX/$kind.count"
f=$FIX/$kind.$n; [ -f "$f" ] || f=$(ls "$FIX"/$kind.[0-9]* | sort -t. -k2 -n | tail -1)
[ "$(cat "$f")" = FAIL ] && exit 1
a=" $* "
if [[ $a == *" --paginate "* && $a == *" --slurp "* ]]; then cat "$f"
else python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[0]))' "$f" 2>/dev/null || cat "$f"; fi
FAKE
chmod +x "$W/gh"

fresh() { rm -rf "$W/fix"; mkdir -p "$W/fix"; export FIX=$W/fix GH=$W/gh; }
run() { local n=$1 c; shift; for c in "$@"; do runs_at "$n" "$c"; n=$((n+1)); done; }
# pages_at <kind> <n> <key> <page size> <total_count or -> <items csv>: writes the page array gh --paginate --slurp would print.
pages_at() {
  python3 -c '
import json, sys
kind, n, key, size, total, items = sys.argv[1:]
items = json.loads("[" + items + "]")
total = len(items) if total == "-" else int(total)
size = int(size)
pages = [{"total_count": total, key: items[i:i + size]} for i in range(0, max(len(items), 1), size)]
json.dump(pages, open("%s/%s.%s" % (__import__("os").environ["FIX"], kind, n), "w"))
' "$@"
}
runs_at() { pages_at runs "$1" check_runs 100 - "$2"; }
stat_at() { pages_at status "$1" statuses 100 - "$2"; }
many_runs() { local i x=(); for ((i=1; i<=$1; i++)); do x+=("$(cr "$2$i" "$3" "${4:-}")"); done; local IFS=,; echo "${x[*]}"; }
many_st() { local i x=(); for ((i=1; i<=$1; i++)); do x+=("$(st "$2$i" "$3")"); done; local IFS=,; echo "${x[*]}"; }
cr() { local c=null; [ -n "${3:-}" ] && c="\"$3\""; printf '{"name":"%s","status":"%s","conclusion":%s}' "$1" "$2" "$c"; }
cj() { local x=("$@"); local IFS=,; echo "${x[*]}"; }
st() { printf '{"context":"%s","state":"%s"}' "$1" "$2"; }

check() { # name, want rc, want output regex; reads $out $rc
  if [ "$rc" = "$2" ] && grep -Eq "$3" <<<"$out"; then echo "PASS $1"; pass=$((pass+1))
  else echo "FAIL $1: want rc=$2 /$3/ got rc=$rc: $out"; failn=$((failn+1)); fi
}
go() { out=$("$BIN/ci-wait" o/r abc1234 "$@" 2>&1); rc=$?; }

fresh; run 1 "$(cj "$(cr build completed success)" "$(cr lint completed success)")"; stat_at 1 ""
go --interval 0; check "green with check-runs only" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cj "$(cr a completed success)" "$(cr b completed skipped)" "$(cr c completed neutral)")"; stat_at 1 ""
go --interval 0; check "green with skipped and neutral" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cj "$(cr ok completed success)" "$(cr unit completed failure)" "$(cr e2e completed timed_out)")"; stat_at 1 ""
go --interval 0; check "red naming two failing jobs" 1 '^RED o/r abc1234: unit=failure; e2e=timed_out$'

fresh; run 1 "$(cr ok completed success)"; stat_at 1 "$(cj "$(st ci/legacy failure)" "$(st ci/fine success)")"
go --interval 0; check "red from a commit status" 1 '^RED o/r abc1234: ci/legacy=failure$'

fresh; run 1 "$(cr a completed cancelled)" ; stat_at 1 ""
go --interval 0; check "cancelled counts as red" 1 'a=cancelled'

fresh; run 1 "$(cj "$(cr slow in_progress)" "$(cr bad completed failure)")" "$(cj "$(cr slow completed success)" "$(cr bad completed failure)")"; stat_at 1 ""
go --interval 0; check "red waits for unfinished jobs, then reports all" 1 '^RED o/r abc1234: bad=failure$'
[ "$(cat "$FIX/runs.count")" = 2 ] && { echo "PASS red did not stop at first poll"; pass=$((pass+1)); } || { echo "FAIL red stopped early"; failn=$((failn+1)); }

fresh; run 1 "$(cr build queued)" "$(cr build in_progress)" "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "pending then green across polls" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cr build completed success)"; stat_at 1 "$(st ci/legacy pending)"; stat_at 2 "$(st ci/legacy success)"
go --interval 0; check "pending status then green" 0 '^GREEN '

fresh; run 1 "" "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "empty list then green" 0 '^GREEN '

fresh; run 1 "$(cj "$(cr build in_progress)" "$(cr deploy queued)")"; stat_at 1 ""
go --timeout 1 --interval 1; check "timeout names pending jobs" 2 '^TIMEOUT o/r abc1234 after [0-9]+s: pending build, deploy$'

fresh; run 1 ""; stat_at 1 ""
go --timeout 1 --interval 1; check "empty list until timeout" 2 '^TIMEOUT .*nothing reported'

fresh; echo FAIL > "$FIX/runs.1"; runs_at 2 "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "transient gh failure then green" 0 '^GREEN '

fresh; echo 'not json' > "$FIX/runs.1"; runs_at 2 "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "bad JSON then green" 0 '^GREEN '

fresh; echo FAIL > "$FIX/runs.1"; stat_at 1 ""
go --timeout 1 --interval 1; check "persistent gh failure times out, never red" 2 '^TIMEOUT '

fresh; run 1 "$(cr build completed success)"; stat_at 1 ""; go --interval 0
grep -q 'graphql' "$FIX/calls" && { echo "FAIL called graphql"; failn=$((failn+1)); } || { echo "PASS only REST endpoints called"; pass=$((pass+1)); }
grep -q 'repos/o/r/commits/abc1234/check-runs?per_page=100' "$FIX/calls" && grep -q 'repos/o/r/commits/abc1234/status?per_page=100' "$FIX/calls" \
  && { echo "PASS both endpoints polled"; pass=$((pass+1)); } || { echo "FAIL endpoints"; failn=$((failn+1)); }

fresh
out=$("$BIN/ci-wait" 2>&1); rc=$?;                       check "no args exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r 2>&1); rc=$?;                    check "missing sha exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" norepo abc1234 2>&1); rc=$?;             check "repo without slash exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234 --timeout x 2>&1); rc=$?;    check "non-numeric timeout exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234 --bogus 2>&1); rc=$?;        check "unknown flag exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234 --interval 2>&1); rc=$?;     check "flag without value exits 64" 64 '^usage:'

out=$("$BIN/ci-wait" 'o/r;x' abc1234 2>&1); rc=$?;        check "repo with shell characters exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" a/b/c abc1234 2>&1); rc=$?;          check "repo with extra slash exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc12 2>&1); rc=$?;              check "sha shorter than 7 exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r xyz1234 2>&1); rc=$?;            check "non-hex sha exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r "$(printf 'a%.0s' {1..41})" 2>&1); rc=$?; check "sha longer than 40 exits 64" 64 '^usage:'

fresh; run 1 "$(cj "$(many_runs 149 ok completed success)" "$(cr late completed failure)")"; stat_at 1 ""
go --interval 0; check "150 check-runs with a failure on page 2 is red" 1 '^RED o/r abc1234: late=failure$'

fresh; runs_at 1 "$(many_runs 150 ok completed success)"; stat_at 1 ""
go --interval 0; check "150 green check-runs is green" 0 '^GREEN o/r abc1234$'

fresh; runs_at 1 "$(cj "$(many_runs 149 ok completed success)" "$(cr late in_progress)")"; stat_at 1 ""
go --timeout 1 --interval 1; check "pending check-run on page 2 keeps waiting" 2 '^TIMEOUT .*pending late$'

fresh; runs_at 1 "$(many_runs 150 ok completed success)"; stat_at 1 ""
pages_at runs 1 check_runs 100 150 "$(many_runs 100 ok completed success)"
go --timeout 1 --interval 1; check "check-run count below total_count is transient, not green" 2 '^TIMEOUT '

fresh; run 1 ""; pages_at status 1 statuses 30 - "$(cj "$(many_st 39 ok success)" "$(st slow pending)")"
go --timeout 1 --interval 1; check "40 statuses with a pending one past page 1 keeps waiting" 2 '^TIMEOUT .*pending slow$'

fresh; run 1 ""; pages_at status 1 statuses 30 - "$(cj "$(many_st 39 ok success)" "$(st late error)")"
go --interval 0; check "error status on page 2 is red" 1 '^RED o/r abc1234: late=error$'

fresh; run 1 ""; pages_at status 1 statuses 30 - "$(many_st 40 ok success)"
go --interval 0; check "40 green statuses with no check-runs is green" 0 '^GREEN o/r abc1234$'

fresh; run 1 ""; pages_at status 1 statuses 30 40 "$(many_st 30 ok success)"
go --timeout 1 --interval 1; check "status count below total_count is transient, not green" 2 '^TIMEOUT '

fresh; run 1 ""; stat_at 1 "$(st ci/legacy success)"
go --interval 0; check "status-only commit is green" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cj "$(cr gate completed action_required)" "$(cr old completed stale)")"; stat_at 1 ""
go --interval 0; check "action_required and stale are red" 1 '^RED o/r abc1234: gate=action_required; old=stale$'

fresh; run 1 "$(cr ok completed success)"; stat_at 1 "$(st ci/legacy error)"
go --interval 0; check "status error is red" 1 '^RED o/r abc1234: ci/legacy=error$'

echo "$pass passed, $failn failed"; rm -rf "$W"; [ "$failn" = 0 ]
