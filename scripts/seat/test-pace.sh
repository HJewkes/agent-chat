#!/bin/sh
# Fixture test for bin/pace: glide target, sources, stale and missing readings, history rows.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-pace.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
cp -R "$here/testdata/pace/." "$scratch/"
sed "s|@DIR@|$scratch|g" "$scratch/charter.md.in" > "$scratch/charter.md"
export AUTONOMY_ROOT="$scratch" PACE_WATCHDOG="$scratch/watchdog.json" PACE_FILE="$scratch/pace.json"
H="$scratch/pool-readings.jsonl"
NOW=1791309600 # 72 h into the window that resets at 1791655200
pass=0 failn=0

report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
run() { out=$(PACE_NOW=$1 "$here/pace" 2>&1); }
# expect <name> <pool> <needle>: the pool's PACE line contains needle
expect() {
  line=$(printf '%s\n' "$out" | grep "^PACE $2 ")
  case "$line" in *"$3"*) report "$1" ok ;; *) report "$1" "line: $line" ;; esac
}
rows() { grep -c "\"pool\": \"$1\"" "$H"; }

run $NOW
expect "glide target is half the day 7 line at mid-path" claude "41 | target 49 | behind 8 | needs 19.0/day"
expect "a pool above the glide path is on pace" workout "target 49 | on pace"
expect "five-hour reading and time to reset are shown" claude "5h 30 | resets "
expect "time to reset is in days and hours" claude "(4d 0h) | reading 3 min old"
expect "a fresher watchdog reading wins over the status cache" agents "30 | target 49 | behind 19"
expect "an older watchdog reading loses to the status cache" claude " 41 |"
expect "a reading older than 15 minutes is marked stale" old "reading 20 min old stale"
case "$(printf '%s\n' "$out" | grep '^PACE claude ')" in *stale*) report "a fresh reading is not stale" "marked stale" ;;
  *) report "a fresh reading is not stale" ok ;; esac
expect "a pool without a status file prints no reading" dark "no reading"

[ "$(wc -l < "$H" | tr -d ' ')" -eq 4 ] && report "one history row per pool with a reading" ok \
  || report "one history row per pool with a reading" "$(cat "$H")"
grep -q '"pool": "agents", "seven_day": 30, "five_hour": 6, "resets_at": 1791655200, "source": "watchdog", "age_s": 60' "$H" \
  && report "history row carries the reading fields" ok || report "history row carries the reading fields" "$(cat "$H")"

run $((NOW + 60))
[ "$(wc -l < "$H" | tr -d ' ')" -eq 4 ] && report "an identical reading is not written again" ok \
  || report "an identical reading is not written again" "$(wc -l < "$H") rows"
sed 's/"used_percentage": 41/"used_percentage": 44/' "$scratch/claude/status-cache/sessions/s1.json" > "$scratch/s" \
  && mv "$scratch/s" "$scratch/claude/status-cache/sessions/s1.json"
run $((NOW + 60))
[ "$(rows claude)" -eq 2 ] && [ "$(rows workout)" -eq 1 ] && report "a changed reading appends one row for that pool" ok \
  || report "a changed reading appends one row for that pool" "claude $(rows claude), workout $(rows workout)"

run $((NOW + 71 * 3600))
expect "the day 6 line caps the glide target" claude "target 96 |"
run $((NOW + 7 * 86400))
expect "a past resets_at reads 0 for the new window" claude "  0 | target 49 | behind 49 | needs 32.7/day"
expect "a reading from the window before is marked stale" claude "min old stale"
run $((NOW + 84 * 3600))
expect "inside the last 24 h needs counts to the reset" claude "target 98 | behind 54 | needs 108.0/day"

before=$(wc -l < "$H" | tr -d ' ')
sed 's/"used_percentage": 44/"used_percentage": 50/' "$scratch/claude/status-cache/sessions/s1.json" > "$scratch/s" \
  && mv "$scratch/s" "$scratch/claude/status-cache/sessions/s1.json"
echo '{}' > "$PACE_FILE"
run $NOW
expect "the view still prints while the watchdog writes pace.json" claude " 50 | target 49 |"
[ "$(wc -l < "$H" | tr -d ' ')" -eq "$before" ] && report "no history row is appended while the watchdog is the writer" ok \
  || report "no history row is appended while the watchdog is the writer" "$before rows before, $(wc -l < "$H") after"
touch -t 202001010000 "$PACE_FILE"
run $NOW
[ "$(wc -l < "$H" | tr -d ' ')" -eq $((before + 1)) ] && report "a pace.json no pass has written for an hour hands the history back" ok \
  || report "a pace.json no pass has written for an hour hands the history back" "$before rows before, $(wc -l < "$H") after"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
