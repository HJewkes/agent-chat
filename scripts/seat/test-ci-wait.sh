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
# Repo, rules and classic protection reads answer from $FIX/default, $FIX/{rules,prot}.{json,status}: no rules by default.
echo "$*" >> "$FIX/calls"
# commits/<sha> --jq .sha: $FIX/commit.<n> by call count holds a bare sha, FAIL, or NOTFOUND (GitHub's 422).
if [[ $2 =~ /commits/[0-9a-fA-F]+$ ]]; then
  n=$(( $(cat "$FIX/commit.count" 2>/dev/null || echo 0) + 1 )); echo $n > "$FIX/commit.count"
  f=$FIX/commit.$n; [ -f "$f" ] || f=$(ls "$FIX"/commit.[0-9]* 2>/dev/null | sort -t. -k2 -n | tail -1)
  [ -n "$f" ] || exit 1
  case $(cat "$f") in
    FAIL) echo "gh: HTTP 502" >&2; exit 1 ;;
    NOTFOUND) echo "gh: No commit found for SHA: ${2##*/} (HTTP 422)" >&2; exit 1 ;;
  esac
  cat "$f"; exit 0
fi
answer() { printf 'HTTP/2.0 %s X\r\n\r\n' "$(cat "$FIX/$1.status" 2>/dev/null || echo "$2")"; cat "$FIX/$1.json" 2>/dev/null || echo "$3"; }
case "$*" in
  "api repos/o/r --jq .default_branch") cat "$FIX/default" 2>/dev/null || echo main; exit 0 ;;
  "api -i repos/o/r/rules/branches/"*) answer rules 200 '[]'; exit 0 ;;
  "api -i repos/o/r/branches/"*/protection/required_status_checks) answer prot 404 '{"message":"Not Found"}'; exit 0 ;;
esac
kind=runs; case "$*" in */status\?*) kind=status ;; esac
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
# ra <name> <status> <conclusion or ""> <app id> [started_at]: a check-run with its app, as GitHub reports it.
ra() { local c=null; [ -n "$3" ] && c="\"$3\""; printf '{"name":"%s","status":"%s","conclusion":%s,"app":{"id":%s},"started_at":"%s"}' "$1" "$2" "$c" "$4" "${5:-2026-01-01T00:00:00Z}"; }
# rules <context[:app id]>...: a required_status_checks ruleset on the base branch.
rules() { local x=() c; for c in "$@"; do case $c in *:*) x+=("{\"context\":\"${c%%:*}\",\"integration_id\":${c#*:}}");; *) x+=("{\"context\":\"$c\"}");; esac; done
  local IFS=,; echo "[{\"type\":\"required_status_checks\",\"parameters\":{\"required_status_checks\":[${x[*]}]}}]" > "$FIX/rules.json"; }

check() { # name, want rc, want output regex; reads $out $rc
  if [ "$rc" = "$2" ] && grep -Eq "$3" <<<"$out"; then echo "PASS $1"; pass=$((pass+1))
  else echo "FAIL $1: want rc=$2 /$3/ got rc=$rc: $out"; failn=$((failn+1)); fi
}
go() { out=$("$BIN/ci-wait" o/r abc1234567890abcdef1234567890abcdef12345 "$@" 2>&1); rc=$?; }

fresh; run 1 "$(cj "$(cr build completed success)" "$(cr lint completed success)")"; stat_at 1 ""
go --interval 0; check "green with check-runs only" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; run 1 "$(cj "$(cr a completed success)" "$(cr b completed skipped)" "$(cr c completed neutral)")"; stat_at 1 ""
go --interval 0; check "green with skipped and neutral" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; run 1 "$(cj "$(cr ok completed success)" "$(cr unit completed failure)" "$(cr e2e completed timed_out)")"; stat_at 1 ""
go --interval 0; check "red naming two failing jobs" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: unit=failure; e2e=timed_out$'

fresh; run 1 "$(cr ok completed success)"; stat_at 1 "$(cj "$(st ci/legacy failure)" "$(st ci/fine success)")"
go --interval 0; check "red from a commit status" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: ci/legacy=failure$'

fresh; run 1 "$(cr a completed cancelled)" ; stat_at 1 ""
go --interval 0; check "cancelled counts as red" 1 'a=cancelled'

fresh; run 1 "$(cj "$(cr slow in_progress)" "$(cr bad completed failure)")" "$(cj "$(cr slow completed success)" "$(cr bad completed failure)")"; stat_at 1 ""
go --interval 0; check "red waits for unfinished jobs, then reports all" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: bad=failure$'
[ "$(cat "$FIX/runs.count")" = 2 ] && { echo "PASS red did not stop at first poll"; pass=$((pass+1)); } || { echo "FAIL red stopped early"; failn=$((failn+1)); }

fresh; run 1 "$(cr build queued)" "$(cr build in_progress)" "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "pending then green across polls" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; run 1 "$(cr build completed success)"; stat_at 1 "$(st ci/legacy pending)"; stat_at 2 "$(st ci/legacy success)"
go --interval 0; check "pending status then green" 0 '^GREEN '

fresh; run 1 "" "$(cr build completed success)"; stat_at 1 ""
go --interval 0; check "empty list then green" 0 '^GREEN '

fresh; run 1 "$(cj "$(cr build in_progress)" "$(cr deploy queued)")"; stat_at 1 ""
go --timeout 1 --interval 1; check "timeout names pending jobs" 2 '^TIMEOUT o/r abc1234567890abcdef1234567890abcdef12345 after [0-9]+s: pending build, deploy$'

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
grep -q 'repos/o/r/commits/abc1234567890abcdef1234567890abcdef12345/check-runs?per_page=100' "$FIX/calls" && grep -q 'repos/o/r/commits/abc1234567890abcdef1234567890abcdef12345/status?per_page=100' "$FIX/calls" \
  && { echo "PASS both endpoints polled"; pass=$((pass+1)); } || { echo "FAIL endpoints"; failn=$((failn+1)); }

fresh
out=$("$BIN/ci-wait" 2>&1); rc=$?;                       check "no args exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r 2>&1); rc=$?;                    check "missing sha exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" norepo abc1234567890abcdef1234567890abcdef12345 2>&1); rc=$?;             check "repo without slash exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234567890abcdef1234567890abcdef12345 --timeout x 2>&1); rc=$?;    check "non-numeric timeout exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234567890abcdef1234567890abcdef12345 --bogus 2>&1); rc=$?;        check "unknown flag exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc1234567890abcdef1234567890abcdef12345 --interval 2>&1); rc=$?;     check "flag without value exits 64" 64 '^usage:'

out=$("$BIN/ci-wait" 'o/r;x' abc1234567890abcdef1234567890abcdef12345 2>&1); rc=$?;        check "repo with shell characters exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" a/b/c abc1234567890abcdef1234567890abcdef12345 2>&1); rc=$?;          check "repo with extra slash exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r abc12 2>&1); rc=$?;              check "sha shorter than 7 exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r xyz1234 2>&1); rc=$?;            check "non-hex sha exits 64" 64 '^usage:'
out=$("$BIN/ci-wait" o/r "$(printf 'a%.0s' {1..41})" 2>&1); rc=$?; check "sha longer than 40 exits 64" 64 '^usage:'

FULL=abc1234567890abcdef1234567890abcdef12345
fresh; run 1 "$(cr build completed success)"; stat_at 1 ""; echo "$FULL" > "$FIX/commit.1"
out=$("$BIN/ci-wait" o/r ABC1234 --interval 0 2>&1); rc=$?
check "abbreviated sha whose CI completed is expanded and green" 0 "^GREEN o/r $FULL\$"
grep -q "repos/o/r/commits/$FULL/check-runs" "$FIX/calls" && ! grep -q 'commits/ABC1234/check-runs' "$FIX/calls" \
  && { echo "PASS check-runs polled with the full sha"; pass=$((pass+1)); } || { echo "FAIL check-runs sha"; failn=$((failn+1)); }

fresh; run 1 "$(cr build completed success)"; stat_at 1 ""; echo NOTFOUND > "$FIX/commit.1"
out=$("$BIN/ci-wait" o/r abc1234 --interval 0 2>&1); rc=$?
check "abbreviated sha GitHub does not have exits 64 at once" 64 '^need a full 40-hex sha of a pushed commit: no commit abc1234 in o/r$'
grep -q check-runs "$FIX/calls" && { echo "FAIL polled an unknown sha"; failn=$((failn+1)); } || { echo "PASS no poll for an unknown sha"; pass=$((pass+1)); }

# The CC-849 incident: GitHub reports "pending" status for a commit it does not have.
fresh; run 1 ""; stat_at 1 "$(st ci/legacy pending)"; echo NOTFOUND > "$FIX/commit.1"
go --timeout 60 --interval 1; check "full sha GitHub does not have exits 64, not TIMEOUT" 64 '^need a full 40-hex sha of a pushed commit: no commit abc1234567890abcdef1234567890abcdef12345 in o/r$'

fresh; run 1 "$(cr build queued)" "$(cr build completed success)"; stat_at 1 ""; echo FAIL > "$FIX/commit.1"
out=$("$BIN/ci-wait" o/r abc1234 --interval 0 2>&1); rc=$?
check "failed lookup is transient and keeps polling" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cr build queued)"; stat_at 1 ""; echo FAIL > "$FIX/commit.1"; echo NOTFOUND > "$FIX/commit.2"
out=$("$BIN/ci-wait" o/r abc1234 --timeout 5 --interval 1 2>&1); rc=$?
check "lookup retried after a transient failure until GitHub answers" 64 '^need a full 40-hex sha'

fresh; run 1 "$(cr build completed success)"; stat_at 1 ""; echo 0000000000000000000000000000000000000000 > "$FIX/commit.1"
out=$("$BIN/ci-wait" o/r abc1234 --interval 0 2>&1); rc=$?
check "lookup answering another sha keeps the input sha" 0 '^GREEN o/r abc1234$'

fresh; run 1 "$(cj "$(many_runs 149 ok completed success)" "$(cr late completed failure)")"; stat_at 1 ""
go --interval 0; check "150 check-runs with a failure on page 2 is red" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: late=failure$'

fresh; runs_at 1 "$(many_runs 150 ok completed success)"; stat_at 1 ""
go --interval 0; check "150 green check-runs is green" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; runs_at 1 "$(cj "$(many_runs 149 ok completed success)" "$(cr late in_progress)")"; stat_at 1 ""
go --timeout 1 --interval 1; check "pending check-run on page 2 keeps waiting" 2 '^TIMEOUT .*pending late$'

fresh; runs_at 1 "$(many_runs 150 ok completed success)"; stat_at 1 ""
pages_at runs 1 check_runs 100 150 "$(many_runs 100 ok completed success)"
go --timeout 1 --interval 1; check "check-run count below total_count is transient, not green" 2 '^TIMEOUT '

fresh; run 1 "$(cr build completed success)"; pages_at status 1 statuses 30 - "$(cj "$(many_st 39 ok success)" "$(st slow pending)")"
go --timeout 1 --interval 1; check "40 statuses with a pending one past page 1 keeps waiting" 2 '^TIMEOUT .*pending slow$'

fresh; run 1 ""; pages_at status 1 statuses 30 - "$(cj "$(many_st 39 ok success)" "$(st late error)")"
go --interval 0; check "error status on page 2 is red" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: late=error$'

fresh; run 1 "" "$(cr build completed success)"; pages_at status 1 statuses 30 - "$(many_st 40 ok success)"
go --interval 0; check "40 green statuses wait for a check-run, then green" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; run 1 ""; pages_at status 1 statuses 30 40 "$(many_st 30 ok success)"
go --timeout 1 --interval 1; check "status count below total_count is transient, not green" 2 '^TIMEOUT '

fresh; run 1 ""; stat_at 1 "$(st ci/legacy success)"
go --timeout 1 --interval 1; check "no rules: status-only commit is not green" 2 '^TIMEOUT .*pending \(no check-run yet\)$'

fresh; run 1 "$(cj "$(cr gate completed action_required)" "$(cr old completed stale)")"; stat_at 1 ""
go --interval 0; check "action_required and stale are red" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: gate=action_required; old=stale$'

fresh; run 1 "$(cr ok completed success)"; stat_at 1 "$(st ci/legacy error)"
go --interval 0; check "status error is red" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: ci/legacy=error$'


# CC-781: with required checks on the base branch, GREEN needs each one green from its app; other runs do not count.
A=15368
early="$(cj "$(ra build completed success $A)" "$(ra deploy completed skipped $A)")"
queued="$(cj "$early" "$(ra dag-check queued "" $A)" "$(ra validate queued "" $A)" "$(ra hub-compose in_progress "" $A)")"
done4="$(cj "$early" "$(ra dag-check completed success $A)" "$(ra validate completed success $A)" "$(ra hub-compose completed success $A)" "$(ra egress-scan completed success $A)")"

fresh; rules dag-check egress-scan validate hub-compose; run 1 "$early"; stat_at 1 ""
go --timeout 1 --interval 1; check "early read: only non-required runs done is pending" 2 '^TIMEOUT .*pending dag-check, egress-scan, hub-compose, validate$'

fresh; rules dag-check egress-scan validate hub-compose; run 1 "$queued"; stat_at 1 ""
go --timeout 1 --interval 1; check "early read: required runs queued is pending" 2 '^TIMEOUT .*pending dag-check, egress-scan, hub-compose, validate$'

fresh; rules dag-check egress-scan validate hub-compose; run 1 "$early" "$queued" "$done4"; stat_at 1 ""
go --interval 0; check "early read, then required runs land green" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'
[ "$(cat "$FIX/runs.count")" = 3 ] && { echo "PASS green only on the third poll"; pass=$((pass+1)); } || { echo "FAIL polls: $(cat "$FIX/runs.count")"; failn=$((failn+1)); }
[ "$(grep -c '/rules/branches/main$' "$FIX/calls")" = 1 ] && { echo "PASS rules read once from the default branch"; pass=$((pass+1)); } || { echo "FAIL rules reads"; failn=$((failn+1)); }

fresh; rules validate; run 1 "$(cj "$(ra validate completed success $A)" "$(ra release completed failure $A)" "$(ra slow in_progress "" $A)")"; stat_at 1 ""
go --interval 0; check "required green while a non-required run fails or runs is green" 0 '^GREEN o/r abc1234567890abcdef1234567890abcdef12345$'

fresh; rules validate lint; run 1 "$(cj "$(ra validate completed success $A)" "$(ra lint completed failure $A)")"; stat_at 1 ""
go --interval 0; check "required failure is red" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: lint=failure$'

fresh; rules validate; run 1 "$(cj "$(ra validate completed failure $A 2026-01-01T00:00:00Z)" "$(ra validate completed success $A 2026-01-01T01:00:00Z)")"; stat_at 1 ""
go --interval 0; check "newest run of a required context wins" 0 '^GREEN '

fresh; rules validate; run 1 "$(ra validate completed skipped $A)"; stat_at 1 ""
go --interval 0; check "required skipped is red, as premerge judges it" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: validate=skipped$'

fresh; rules validate; run 1 "$(ra validate completed success 999)"; stat_at 1 ""
go --timeout 1 --interval 1; check "unpinned required run from another app is not green" 2 '^TIMEOUT .*pending validate$'

fresh; rules validate; run 1 ""; stat_at 1 "$(st validate success)"
go --interval 0; check "unpinned required context green by commit status" 0 '^GREEN '

fresh; rules validate:4242; run 1 "$(ra validate completed success 4242)"; stat_at 1 "$(st validate failure)"
go --interval 0; check "pinned context green from the pinned app" 0 '^GREEN '

fresh; rules validate:4242; run 1 "$(ra validate completed success $A)"; stat_at 1 "$(st validate success)"
go --timeout 1 --interval 1; check "pinned context ignores other apps and statuses" 2 '^TIMEOUT .*pending validate$'

fresh; echo '{"contexts":["lint"],"strict":false}' > "$FIX/prot.json"; echo 200 > "$FIX/prot.status"
run 1 "$(cj "$(ra lint in_progress "" $A)" "$(ra other completed failure $A)")" "$(cj "$(ra lint completed success $A)" "$(ra other completed failure $A)")"; stat_at 1 ""
go --interval 0; check "classic protection: required list from the fallback" 0 '^GREEN '

fresh; echo '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}' > "$FIX/rules.json"
echo 403 > "$FIX/rules.status"; run 1 "$(cr build completed failure)"; stat_at 1 ""
go --interval 0; check "upgrade 403 means no rules: all-runs rule" 1 '^RED o/r abc1234567890abcdef1234567890abcdef12345: build=failure$'

fresh; echo 500 > "$FIX/rules.status"; run 1 "$(cr build completed success)"; stat_at 1 ""
go --timeout 1 --interval 1; check "rules API error is transient, never green" 2 '^TIMEOUT .*no successful poll'

fresh; echo 500 > "$FIX/prot.status"; run 1 "$(cr build completed success)"; stat_at 1 ""
go --timeout 1 --interval 1; check "classic protection API error is transient, never green" 2 '^TIMEOUT '

fresh; echo '{"oops":1}' > "$FIX/rules.json"; run 1 "$(cr build completed success)"; stat_at 1 ""
go --timeout 1 --interval 1; check "rules of an unexpected shape never green" 2 '^TIMEOUT '

fresh; echo trunk > "$FIX/default"; run 1 "$(cr build completed success)"; stat_at 1 ""; go --interval 0
grep -q 'rules/branches/trunk$' "$FIX/calls" && grep -q 'branches/trunk/protection/required_status_checks$' "$FIX/calls" \
  && { echo "PASS rules read from the repo default branch"; pass=$((pass+1)); } || { echo "FAIL default branch"; failn=$((failn+1)); }

fresh; run 1 "$(cr build completed success)"; stat_at 1 ""; go --base release/1.x --interval 0
grep -q 'rules/branches/release/1.x$' "$FIX/calls" && ! grep -q default_branch "$FIX/calls" \
  && { echo "PASS --base skips the default branch lookup"; pass=$((pass+1)); } || { echo "FAIL --base"; failn=$((failn+1)); }
out=$("$BIN/ci-wait" o/r abc1234567890abcdef1234567890abcdef12345 --base 'a b' 2>&1); rc=$?;  check "unsafe base exits 64" 64 '^usage:'

echo "$pass passed, $failn failed"; rm -rf "$W"; [ "$failn" = 0 ]
