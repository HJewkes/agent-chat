#!/bin/bash
# Shared harness for test-premerge.sh and test-merge.sh: temp repo, temp db, stubs on PATH.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN=${BIN_OVERRIDE:-$(cd "$here/../.." && pwd)}
W=${TMPDIR:-/tmp}/seat-test-premerge/$$
R=acme/widgets N=7 pass=0 failn=0
rm -rf "$W"; mkdir -p "$W"
export PATH="$here/stubs:$PATH" EVENTS_DB=$W/events.db STUB_LOG=$W/put.log
export COORDINATORS="coord-a coord-b" SEAT=test-seat FIXDIR=$W/case

# Commits are built in $W/work and fetched into the bare origin, never pushed: the global pre-push scan refuses a repo with no default branch.
setup_repo() {
  git init -q -b main "$W/work"; cd "$W/work" || exit 1
  git config user.email t@example.com; git config user.name t
  echo base > f; git add f; git commit -qm base
  git checkout -qb clean; echo x > g; git add g; git commit -qm clean; CLEAN=$(git rev-parse HEAD)
  git checkout -q main; git checkout -qb conflict; echo theirs > f; git commit -qam conflict; CONF=$(git rev-parse HEAD)
  git checkout -q main; echo ours > f; git commit -qam ours
  MAINSHA=$(git rev-parse HEAD)
  git checkout -q -b merged clean; git merge -q --no-edit main; MERGED=$(git rev-parse HEAD)
  git checkout -q -b badtree clean; git merge -q --no-edit main; echo extra > extra; git add extra; git commit -q --amend --no-edit; BADTREE=$(git rev-parse HEAD)
  git checkout -q clean; git checkout -q -b child; echo y > h; git add h; git commit -qm child; CHILD=$(git rev-parse HEAD)
  git checkout -q "$(git rev-list --max-parents=0 main)"; git checkout -q -b side; echo s > side; git add side; git commit -qm side
  git checkout -q -b notbase clean; git merge -q --no-edit side; NOTBASE=$(git rev-parse HEAD)
  git checkout -q main; cd "$OLDPWD" || exit 1
  seed_clone
}

# seed_clone: origin holds main, clean and conflict; the clone also has the local-only branches.
seed_clone() {
  git init -q --bare -b main "$W/origin.git"
  git -C "$W/origin.git" fetch -q "$W/work" main:main clean:clean conflict:conflict || exit 1
  git clone -q "$W/origin.git" "$W/clone" || exit 1
  git -C "$W/clone" config user.email t@example.com; git -C "$W/clone" config user.name t
  git -C "$W/clone" fetch -q "$W/work" clean:clean conflict:conflict merged:merged badtree:badtree child:child side:side notbase:notbase || exit 1
}

setup_db() {
  sqlite3 "$EVENTS_DB" "create table events (id integer primary key autoincrement, ts integer not null, kind text not null, actor text not null, target text, msg_id text, ref text, body text, meta text)"
}

# add_verdict <actor> <msg_id> <MERGE|FIX_FIRST> <head> [pr]
add_verdict() {
  local body; body=$(printf 'Verdict: %s\nPR: %s#%s\nHead: %s\nBlocking: none' "$3" "$R" "${5:-$N}" "$4")
  sqlite3 "$EVENTS_DB" "insert into events (ts,kind,actor,msg_id,body) values (0,'message','$1','$2','$body')"
}

# new_case <sha>: fresh fixtures for that head, empty verdict table, no PUT log.
new_case() {
  SHA=$1; export FIXSHA=$SHA
  rm -rf "$W/case" "$STUB_LOG"; cp -R "$here/base" "$W/case"
  sed -i.bak "s/@SHA@/$SHA/g" "$W/case"/*.json; rm -f "$W/case"/*.bak
  sqlite3 "$EVENTS_DB" "delete from events"
}

# mut <fixture file> <jq filter>
mut() { jq -c "$2" "$W/case/$1" > "$W/tmp.json" && mv "$W/tmp.json" "$W/case/$1"; }

# check <name> <expected exit> <pattern in last output line>; reads $out and $rc
check() {
  local last; last=$(tail -1 <<<"$out")
  if [ "$rc" = "$2" ] && grep -q -- "$3" <<<"$last"; then echo "PASS $1"; pass=$((pass+1))
  else echo "FAIL $1 (rc=$rc, want $2 /$3/): $last"; failn=$((failn+1)); fi
}

finish() { echo "$pass passed, $failn failed"; rm -rf "$W"; [ "$failn" = 0 ]; }
