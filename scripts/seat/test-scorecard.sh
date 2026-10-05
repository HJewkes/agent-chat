#!/bin/sh
# Fixture test for bin/scorecard: each of the eleven rows, the --json form, and a missing source printing 'not measured'.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-scorecard.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
fx="$here/testdata/scorecard"
sqlite3 "$scratch/factory.db" < "$fx/factory.sql"
sqlite3 "$scratch/events.db" < "$fx/events.sql"
export SCORECARD_FACTORY_DB="$scratch/factory.db" SCORECARD_EVENTS_DB="$scratch/events.db"
export SCORECARD_LOGS="$fx/logs" SCORECARD_TASKS="$fx/tasks" SCORECARD_NOW=1791115200 # 2026-10-04T12:00Z
pass=0 failn=0

report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
# expect <name> <metric> <needle>: the metric's line contains needle
expect() {
  line=$(printf '%s\n' "$out" | grep "^SCORECARD $2:")
  case "$line" in *"$3"*) report "$1" ok ;; *) report "$1" "line: $line" ;; esac
}

out=$("$here/scorecard" 2>&1)
expect "merges per day counts only runs with no approval step" "Merges per day by Shepherd with no human step" "0.67 per day (1 with no human step of 2 merges in 1.5 days)"
expect "ready to merged gives median and p90 from task created" "Task ready to merged" "median 630 min, p90 654 min"
expect "register to merge gives the median" "Register to merge" "median 45.0 min (n=2)"
expect "change failure counts red main and reverts per merge" "Change failure rate" "red main 50.0 percent (2 of 4); reverts 25.0 percent (1 of 4)"
expect "audit defects are named as not measured" "Change failure rate" "post-merge audit defects not measured"
expect "time red is the median of thawed episodes" "Time main stays red" "median 40 min over 1 episodes (1 still red)"
expect "first-pass FIX_FIRST counts the first non-WAIT verdict per PR in the window" "First-pass FIX_FIRST share" "50.0 percent (3 of 6)"
expect "mechanical share is n/a while no FIX_FIRST carries a Class line" "Mechanical first-blocker share" "n/a (no Class line yet; 3 unclassified of 3 FIX_FIRST rounds)"
expect "mechanical share carries the hand-checked baseline" "Mechanical first-blocker share" "baseline 6.9 percent (21 of 305"
expect "seat merge share excludes PRs Shepherd merged" "Share of merges by seat merge script" "50.0 percent (2 of 4)"
expect "waiting row counts pending approvals older than 60 minutes" "Approved and waiting over 60 minutes" "1 PRs over 60 min, oldest 28 hours"
expect "coordinator spawns count milestone dispatches by seat" "Coordinator spawns for milestone tasks" "75.0 percent (3 of 4)"
expect "cost sums retired usd_est per merged task across seats and windows" "Cost per merged PR" '$1.67 per merged task (median $1.50; $5.00 over 3 merged tasks) [usd_est on 3 of 3 merged tasks]'
expect "each row carries its baseline" "Register to merge" "baseline median 15.0 min"

json=$("$here/scorecard" --json 2>&1)
n=$(printf '%s' "$json" | python3 -c 'import json,sys; r=json.load(sys.stdin)["rows"]; print(len(r), all(x["measured"] for x in r))')
[ "$n" = "11 True" ] && report "json form has eleven measured rows" ok || report "json form has eleven measured rows" "$n"

# Class lines: a repeat at the same actor, PR and Head counts once; a second reviewer is its own round
verdict() { printf "(1791050000000,'message','%s','Verdict: FIX_FIRST\nPR: o/proj#%s\nHead: %s%b')" "$1" "$2" "$3" "${4:+\nClass: $4}"; }
{ echo "create table events (id integer primary key autoincrement, ts integer not null, kind text not null, actor text not null, target text, msg_id text, ref text, body text, meta text);"
  echo "insert into events (ts, kind, actor, body) values $(verdict rv 10 e rebase), $(verdict rv 10 e rebase), $(verdict rv2 10 e lint),"
  echo " $(verdict rv 11 f defect), $(verdict rv 12 g test), $(verdict rv 13 h), $(verdict rv 14 i ci-red);"
} | sqlite3 "$scratch/classes.db"
out=$(SCORECARD_EVENTS_DB="$scratch/classes.db" "$here/scorecard" 2>&1)
expect "mechanical share counts deduped classified rounds and reports unclassified" "Mechanical first-blocker share" "60.0 percent (3 of 5) of classified; 1 unclassified of 6 FIX_FIRST rounds"

low=$(SCORECARD_LOGS="$fx/logs-lowcov" "$here/scorecard" 2>&1)
case "$(printf '%s\n' "$low" | grep '^SCORECARD Cost per merged PR:')" in
  *": not measured (usd_est on 1 of 3 merged tasks) |"*) report "cost below 80 percent usd_est coverage prints not measured with the coverage" ok ;;
  *) report "cost below 80 percent usd_est coverage prints not measured with the coverage" "$low" ;; esac
c=$(SCORECARD_LOGS="$fx/logs-lowcov" "$here/scorecard" --json 2>&1 | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["rows"] if x["id"]=="cost"][0]; print(r["value"], r["measured"], r["tasks_with_usd_est"], r["merged_tasks"])')
[ "$c" = "None False 1 3" ] && report "low-coverage cost is null in json with coverage fields" ok || report "low-coverage cost is null in json with coverage fields" "$c"

# a WAL database in a read-only directory cannot open mode=ro, so the fallback opens it immutable and says so on stderr
mkdir "$scratch/ro"; sqlite3 "$scratch/ro/factory.db" "pragma journal_mode=wal; create table t(x);" > /dev/null
rm -f "$scratch/ro/factory.db-wal" "$scratch/ro/factory.db-shm"; chmod 555 "$scratch/ro"
err=$(SCORECARD_FACTORY_DB="$scratch/ro/factory.db" "$here/scorecard" 2>&1 >/dev/null)
chmod 755 "$scratch/ro"
case "$err" in *"WAL contents are not read"*) report "immutable fallback warns on stderr that WAL is not read" ok ;; *) report "immutable fallback warns on stderr that WAL is not read" "stderr: $err" ;; esac

out=$("$here/scorecard" --since 2026-10-05 2>&1)
expect "an empty window prints not measured for the merge rate" "Merges per day by Shepherd with no human step" "not measured"

export SCORECARD_FACTORY_DB="$scratch/missing.db" SCORECARD_EVENTS_DB="$scratch/missing-events.db" SCORECARD_LOGS="$scratch/none"
out=$("$here/scorecard" 2>&1)
missing=$(printf '%s\n' "$out" | grep -c ': not measured')
[ "$missing" -eq 11 ] && report "missing sources print not measured on every row" ok || report "missing sources print not measured on every row" "$missing rows"
case "$out" in *": 0 "*|*": 0.00"*) report "missing sources never print 0" "found a zero" ;; *) report "missing sources never print 0" ok ;; esac

echo "scorecard: $pass passed, $failn failed"
[ "$failn" -eq 0 ]
