#!/bin/sh
# Fixture test for queue-turns: kinds, sidechain and out-of-day rows, turns per message id, tz day boundary.
set -u
here=$(cd "$(dirname "$0")" && pwd)
data="$here/testdata/queue-turns"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/seat-test-queue-turns.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
pass=0 failn=0

report() {
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "PASS $1"
  else failn=$((failn + 1)); echo "FAIL $1 ($2)"; fi
}
run() { out=$("$here/queue-turns" "$@" 2>&1); }
# expect <name> <exact line>: the output has that line
expect() {
  if printf '%s\n' "$out" | grep -qxF "$2"; then report "$1" ok; else report "$1" "$(printf '%s' "$out" | tr '\n' '|')"; fi
}

run 2026-10-10 --tz UTC --roots "$data/pair"
expect "a queue script call counts as script though it has no heredoc" "script 1"
expect "a heredoc writing a queue file counts as heredoc" "heredoc 1"
expect "adoption is script over all writes" "adoption 50% (1 of 2 writes)"

run 2026-10-10 --tz UTC --roots "$data/mixed"
expect "a queue script fed by a heredoc counts as script" "script 1"
expect "a python heredoc counts as heredoc, not the script" "heredoc 1"
expect "the Edit tool counts once, without the sidechain or next-day edit" "edit-tool 1"
expect "the Write tool counts as write-tool" "write-tool 1"
expect "sed -i counts as sed-i" "sed-i 1"
expect "a Bash cat and a Read count as reads, a repeated tool use id once" "read 2"
expect "two tool uses under one message id are one turn" "turns 5"
expect "reads are outside the adoption denominator" "adoption 20% (1 of 5 writes)"

run 2026-10-10 --tz UTC --roots "$data/tz"
expect "a 05:30Z row is not on the UTC day before" "edit-tool 0"
expect "no writes reports adoption as n/a" "adoption n/a (0 writes)"
run 2026-10-10 --tz America/Denver --roots "$data/tz"
expect "a 05:30Z row belongs to the previous Denver day" "edit-tool 1"
run 2026-10-11 --tz America/Denver --roots "$data/tz"
expect "the same row is not on its UTC date in Denver" "edit-tool 0"

run 2026-10-10 --tz UTC --roots "$data/pair" "$data/mixed"
expect "several roots are summed" "turns 7"

mkdir -p "$scratch/home/.claude/projects" "$scratch/home/.claude-profiles/p1/projects"
cp -R "$data/pair/." "$scratch/home/.claude/projects/"
cp -R "$data/mixed/." "$scratch/home/.claude-profiles/p1/projects/"
out=$(HOME="$scratch/home" "$here/queue-turns" 2026-10-10 --tz UTC 2>&1)
expect "default roots cover ~/.claude and every profile" "turns 7"

run 10-10-2026
case "$out" in *"invalid"*) report "a malformed date is a usage error" ok ;; *) report "a malformed date is a usage error" "$out" ;; esac

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
