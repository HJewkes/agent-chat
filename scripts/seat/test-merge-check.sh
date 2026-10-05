#!/bin/bash
# Cases for bin/merge-check against synthetic fixtures: a bare origin, a clone, no network, no identity.
# usage: test-merge-check.sh   (MERGE_CHECK=<path> tests a different copy of the script)
set -u
here=$(cd "$(dirname "$0")" && pwd)
MC=${MERGE_CHECK:-$here/merge-check}
W=${TMPDIR:-/tmp}/seat-test-merge-check/$$
pass=0 failn=0
rm -rf "$W"; mkdir -p "$W/tmp" "$W/home" "$W/stubs" "$W/hooks"
# Scrub for fixtures and default runs; cases that need the machine's kind of environment set it per call.
export HOME=$W/home GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
trap 'chmod -R u+w "$W" 2>/dev/null; rm -rf "$W"' EXIT

tg() { git -C "$1" -c user.name=t -c user.email=t@example.com "${@:2}"; }
commit() { printf '%s\n' "$3" > "$1/$2"; tg "$1" add "$2"; tg "$1" commit -qm "$4"; }

# fx <name> <default branch>: origin, clone and a base commit on the default branch.
fx() {
  D=$W/$1 DEF=$2 O=$W/$1/origin.git C=$W/$1/clone; mkdir -p "$D"
  git init -q --template= --bare -b "$DEF" "$O"; git clone -q --template= "$O" "$C" 2>/dev/null
  git -C "$O" config uploadpack.allowAnySHA1InWant true
  tg "$C" config user.useConfigOnly true
  commit "$C" CHANGELOG.md "- base" base; tg "$C" push -q origin "$DEF"
  BASE=$(tg "$C" rev-parse HEAD)
}
# mkbranch <name> <file> <content> [file content]: commits on a branch from the base; sets HEAD_SHA, stays on default.
mkbranch() {
  tg "$C" checkout -q -b "$1" "$BASE"; commit "$C" "$2" "$3" "$1"
  [ $# -lt 5 ] || commit "$C" "$4" "$5" "$1 again"
  HEAD_SHA=$(tg "$C" rev-parse HEAD); tg "$C" checkout -q "$DEF"
}
other() { git clone -q --template= "$O" "$D/other" 2>/dev/null; }
# adv <file> <content>: origin gains a commit that the clone has not fetched.
adv() { other; commit "$D/other" "$1" "$2" advance; tg "$D/other" push -q origin "$DEF"; rm -rf "$D/other"; }
# advforce <file> <content>: origin's default branch is rewritten to base plus one commit.
advforce() { other; tg "$D/other" reset -q --hard "$BASE"; commit "$D/other" "$1" "$2" rewrite; tg "$D/other" push -q -f origin "$DEF"; rm -rf "$D/other"; }
# advbranch <name> <file> <content>: a branch that exists only on origin; sets HEAD_SHA.
advbranch() {
  other; tg "$D/other" checkout -q -b "$1" "$BASE"; commit "$D/other" "$2" "$3" "$1"
  tg "$D/other" push -q origin "$1"; HEAD_SHA=$(tg "$D/other" rev-parse HEAD); rm -rf "$D/other"
}
snap() { tg "$C" rev-parse HEAD; tg "$C" for-each-ref refs/heads; tg "$C" status --porcelain; }

run() { out=$(TMPDIR=$W/tmp "$MC" "$@" 2>&1); rc=$?; last=$(tail -1 <<<"$out"); }
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 :: ${2:-} :: $out"; failn=$((failn+1)); }
check() {
  if [ "$rc" = "$2" ] && [[ $last =~ $3 ]]; then ok "$1"; else bad "$1" "rc=$rc want $2, last line vs $3"; fi
}
has() { if grep -qE -- "$2" <<<"$out"; then ok "$1"; else bad "$1" "missing $2"; fi; }
hasnt() { if grep -qE -- "$2" <<<"$out"; then bad "$1" "unexpected $2"; else ok "$1"; fi; }
# verdict_only <name>: exactly one line starts with OK or FAIL, and it is the last.
verdict_only() {
  local n; n=$(grep -cE '^(OK|FAIL) ' <<<"$out")
  if [ "$n" = 1 ] && [[ $last =~ ^(OK|FAIL)\  ]]; then ok "$1"; else bad "$1" "verdict-like lines=$n"; fi
}
# clean_state <name> <snapshot before>: only the main worktree, no temp dir, checkout untouched.
clean_state() {
  local n; n=$(tg "$C" worktree list | wc -l | tr -d ' ')
  if [ "$n" = 1 ] && [ -z "$(ls -A "$W/tmp")" ] && [ "$(snap)" = "$2" ]; then ok "$1: nothing left behind"
  else bad "$1: nothing left behind" "worktrees=$n tmp=$(ls "$W/tmp") snapshot changed=$([ "$(snap)" = "$2" ] || echo yes)"; fi
}
case_run() { local s; s=$(snap); run "$@"; SNAP=$s; }

# stub npm/pnpm: log the call; STUB_FAIL=<first arg> fails that step; STUB_SLEEP sleeps; STUB_LOCK leaves an undeletable dir.
for pm in npm pnpm; do
  cat > "$W/stubs/$pm" <<STUB
#!/bin/bash
echo "$pm \$*" >> "\$STUB_LOG"
[ -n "\${STUB_SLEEP:-}" ] && sleep "\$STUB_SLEEP"
[ -n "\${STUB_LOCK:-}" ] && { mkdir -p locked; touch locked/f; chmod 555 locked; }
[ "\$1" = "\${STUB_FAIL:-none}" ] && { echo "boom line"; echo "OK fake child output"; echo "FAIL fake child output"; exit 1; }
exit 0
STUB
  chmod +x "$W/stubs/$pm"
done
export STUB_LOG=$W/stub.log
ST="$W/stubs:$PATH"

# clean merge: parents are origin's tip and the head
fx clean main; mkbranch feat g.txt x; adv h.txt y; TIP=$(git -C "$O" rev-parse main)
case_run --no-build "$C" "$HEAD_SHA"
check "clean merge is OK" 0 "^OK .* merges into main $TIP \(merge\)$"
has "clean merge prints origin tip and head as parents" "^parents: $TIP $HEAD_SHA$"
has "clean merge prints main" "^main: $TIP$"
has "clean merge prints merge-base" "^merge-base: $BASE$"
clean_state "clean merge" "$SNAP"

# stale local origin: the fetch reveals a CHANGELOG conflict
fx stale main; tg "$C" config rerere.enabled true; mkbranch feat CHANGELOG.md "- feature"
OLD=$(tg "$C" rev-parse origin/main); adv CHANGELOG.md "- other"
case_run --no-build "$C" "$HEAD_SHA"
check "stale origin conflict" 1 "^FAIL conflict: CHANGELOG.md$"
[ "$(tg "$C" rev-parse origin/main)" != "$OLD" ] && ok "stale origin was fetched" || bad "stale origin was fetched"
[ -z "$(ls -A "$C/.git/rr-cache" 2>/dev/null)" ] && ok "rerere records nothing" || bad "rerere records nothing"
clean_state "conflict" "$SNAP"

# 1: a tag or local branch named origin/main must not shadow the remote-tracking ref
for kind in tag branch; do
  fx "shadow$kind" main; mkbranch feat CHANGELOG.md "- feature"; adv CHANGELOG.md "- other"; TIP=$(git -C "$O" rev-parse main)
  if [ $kind = tag ]; then tg "$C" tag origin/main "$BASE"; else tg "$C" branch origin/main "$BASE"; fi
  case_run --no-build "$C" "$HEAD_SHA"
  check "1 $kind named origin/main: conflict is found" 1 "^FAIL conflict: CHANGELOG.md$"
  has "1 $kind named origin/main: main is origin's tip" "^main: $TIP$"
  clean_state "1 $kind named origin/main" "$SNAP"
done

# a head already in origin/main merges into itself: never OK
fx self main; adv h.txt y; git -C "$C" fetch -q origin; TIP=$(tg "$C" rev-parse origin/main)
case_run --no-build "$C" "$TIP";   check "head equal to origin tip" 1 "^FAIL head is already in main"
clean_state "head equal to tip" "$SNAP"
case_run --no-build "$C" "$BASE";  check "head older than origin tip" 1 "^FAIL head is already in main"
fx selfstale main; mkbranch feat g.txt x; tg "$C" push -q origin feat; git -C "$O" update-ref refs/heads/main "$HEAD_SHA"
case_run --no-build "$C" "$HEAD_SHA"; check "head landed on origin after the clone" 1 "^FAIL head is already in main"

# a head that descends from the default branch fast-forwards
fx ff main; mkbranch feat g.txt x
case_run --no-build "$C" "$HEAD_SHA"
check "fast-forward is OK" 0 "^OK .* \(fast-forward\)$"
has "fast-forward line" "^fast-forward: head descends from main$"
clean_state "fast-forward" "$SNAP"
# merge.ff=false makes a real merge commit for the same shape: not a fast-forward
fx noff main; tg "$C" config merge.ff false; mkbranch feat g.txt x; TIP=$(git -C "$O" rev-parse main)
case_run --no-build "$C" "$HEAD_SHA"
check "merge.ff=false gives a merge" 0 "^OK .* \(merge\)$"
has "merge.ff=false prints both parents" "^parents: $TIP $HEAD_SHA$"; hasnt "merge.ff=false is not a fast-forward" "^fast-forward:"

# default branch is not main
fx trunkrepo trunk; mkbranch feat g.txt x; adv h.txt y
case_run --no-build "$C" "$HEAD_SHA"; check "default branch trunk" 0 "^OK .* merges into trunk .* \(merge\)$"
clean_state "trunk" "$SNAP"

# fetch failures: origin gone (ls-remote), and a fetch that cannot lock its ref
fx nofetch main; mkbranch feat g.txt x; adv h.txt y; mv "$O" "$O.gone"
case_run --no-build "$C" "$HEAD_SHA"; check "origin unreachable" 1 "^FAIL fetch: cannot reach origin$"
clean_state "origin unreachable" "$SNAP"; mv "$O.gone" "$O"
fx lockperm main; mkbranch feat g.txt x; adv h.txt y
mkdir -p "$C/.git/refs/remotes/origin"; : > "$C/.git/refs/remotes/origin/main.lock"
case_run --no-build "$C" "$HEAD_SHA"; check "5 fetch keeps failing on a lock" 1 "^FAIL fetch: git fetch origin main failed$"
clean_state "5 lock" "$SNAP"; rm -f "$C/.git/refs/remotes/origin/main.lock"
fx locktmp main; mkbranch feat g.txt x; adv h.txt y
mkdir -p "$C/.git/refs/remotes/origin"; : > "$C/.git/refs/remotes/origin/main.lock"
( sleep 1; rm -f "$C/.git/refs/remotes/origin/main.lock" ) & lockpid=$!
case_run --no-build "$C" "$HEAD_SHA"; wait $lockpid; check "5 fetch retries past a transient lock" 0 "^OK "
# a rewritten default branch needs a forced fetch
fx forced main; mkbranch feat g.txt x; adv h.txt y; git -C "$C" fetch -q origin; advforce k.txt z
case_run --no-build "$C" "$HEAD_SHA"; check "force-pushed default branch" 0 "^OK .* \(merge\)$"
# several runs at once against one clone
fx par main; mkbranch feat g.txt x; adv h.txt y; s=$(snap)
for i in 1 2 3 4; do TMPDIR=$W/tmp "$MC" --no-build "$C" "$HEAD_SHA" > "$W/par.$i" 2>&1 & done; wait
okn=$(cat "$W"/par.? | grep -c '^OK '); out=$(cat "$W"/par.?)
[ "$okn" = 4 ] && ok "5 four concurrent runs all OK" || bad "5 four concurrent runs all OK" "ok=$okn"
clean_state "5 concurrent runs" "$s"
# a shallow clone cannot find a merge base
fx shallow main; advbranch feat g.txt x; adv h.txt y; adv h2.txt y2; git clone -q --template= --depth 1 "file://$O" "$D/sh" 2>/dev/null; C=$D/sh
case_run --no-build "$C" "$HEAD_SHA"; check "5 shallow clone" 1 "^FAIL shallow clone: cannot find a merge base$"
clean_state "5 shallow clone" "$SNAP"

# origin moving between ls-remote and the fetch: a git shim reports a different tip than the fetch delivers
REALGIT=$(command -v git); mkdir -p "$W/shim"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = ls-remote ] && { "%s" "$@" | sed "s/^[0-9a-f]\\{40\\}/%s/"; exit 0; }; done\nexec "%s" "$@"\n' "$REALGIT" "$(printf '1%.0s' {1..40})" "$REALGIT" > "$W/shim/git"; chmod +x "$W/shim/git"
fx race main; mkbranch feat g.txt x; adv h.txt y
PATH="$W/shim:$PATH" case_run --no-build "$C" "$HEAD_SHA"; check "origin tip differs from what ls-remote reported" 1 "^FAIL origin/main is [0-9a-f]{40} but origin reports 1{40}$"
clean_state "tip mismatch" "$SNAP"

# bad shas and arguments
fx args main; mkbranch feat g.txt x; Z=$(printf '0%.0s' {1..40}); UP=$(tr a-f A-F <<<"$HEAD_SHA")
case_run --no-build "$C" "$Z";                     check "unknown sha" 1 "^FAIL unknown sha"
case_run --no-build "$C" "${HEAD_SHA:0:8}";        check "short sha" 1 "^FAIL not a full 40-hex sha"
case_run --no-build "$C" "$UP";                    check "upper-case sha" 1 "^FAIL not a full 40-hex sha"
case_run --no-build "$C" "$(tg "$C" rev-parse "$HEAD_SHA^{tree}")";       check "tree sha" 1 "^FAIL not a commit"
case_run --no-build "$C" "$(tg "$C" rev-parse "$HEAD_SHA:CHANGELOG.md")"; check "blob sha" 1 "^FAIL not a commit"
clean_state "bad sha" "$SNAP"
run --no-build "$W" "$Z";                          check "not a repository" 1 "^FAIL not a git repository"
run "$C";                                          check "one argument is a usage error" 2 "^usage:"
run --no-build "$C" "$HEAD_SHA" extra;             check "three arguments is a usage error" 2 "^usage:"
# a head that only exists on origin is fetched by sha
fx bysha main; advbranch feat g.txt x; adv h.txt y
case_run --no-build "$C" "$HEAD_SHA"; check "sha missing locally is fetched" 0 "^OK .* \(merge\)$"
# a head with no common history: git refuses, and that is a FAIL
fx orphan main; HEAD_SHA=$(tg "$C" commit-tree -m orphan "$(tg "$C" hash-object -t tree -w /dev/null)"); adv h.txt y
case_run --no-build "$C" "$HEAD_SHA"; check "unrelated history is a merge failure" 1 "^FAIL merge$"; has "unrelated history names none" "^merge-base: none$"
clean_state "unrelated history" "$SNAP"
# a repository with commit signing on and no identity anywhere
fx sign main; mkbranch feat g.txt x; adv h.txt y; tg "$C" config commit.gpgsign true; tg "$C" config gpg.program /usr/bin/false
case_run --no-build "$C" "$HEAD_SHA"; check "signing is forced off" 0 "^OK .* \(merge\)$"
# a hook that moves HEAD off origin's tip breaks the parents guarantee
fx hookhead main; mkbranch feat g.txt x; adv h.txt y; mkdir -p "$C/.git/hooks"
printf '#!/bin/bash\ngit -c user.name=h -c user.email=h@example.com commit -q --allow-empty -m hook\n' > "$C/.git/hooks/post-checkout"; chmod +x "$C/.git/hooks/post-checkout"
case_run --no-build "$C" "$HEAD_SHA"; check "parents must be origin's tip and the head" 1 "^FAIL merge parents are not origin/main and the head$"
clean_state "hook moved HEAD" "$SNAP"

# build path with stubbed npm/pnpm (npm ci needs a lockfile and an install is not guaranteed offline)
fx build main; mkbranch feat package.json '{"scripts":{"test":"exit 1"}}'; adv h.txt y
: > "$STUB_LOG"; STUB_FAIL=test PATH=$ST case_run "$C" "$HEAD_SHA"
check "failing test step" 1 "^FAIL test$"; has "failing test prints its output" "^\| boom line$"
has "child output is prefixed" "^\| OK fake child output$"; verdict_only "3 only the last line is a verdict"
grep -qx "npm ci" "$STUB_LOG" && grep -qx "npm run build --if-present" "$STUB_LOG" && ok "npm path calls ci, build" || bad "npm path calls ci, build"
clean_state "failing test" "$SNAP"
STUB_FAIL=ci PATH=$ST case_run "$C" "$HEAD_SHA";        check "failing install step" 1 "^FAIL install$"
STUB_FAIL=run PATH=$ST case_run "$C" "$HEAD_SHA";       check "failing build step" 1 "^FAIL build$"
PATH=$ST case_run "$C" "$HEAD_SHA";              check "passing scripts" 0 "^OK .* \(merge, build, test\)$"
PATH=$ST case_run --no-test "$C" "$HEAD_SHA";    check "--no-test" 0 "^OK .* \(merge, build\)$"
: > "$STUB_LOG"; PATH=$ST case_run --no-build "$C" "$HEAD_SHA"
[ ! -s "$STUB_LOG" ] && ok "--no-build runs nothing" || bad "--no-build runs nothing"
fx pnpmrepo main; mkbranch feat pnpm-lock.yaml "lock" package.json '{}'; adv h.txt y; : > "$STUB_LOG"
PATH=$ST case_run "$C" "$HEAD_SHA"; check "pnpm repository" 0 "^OK .* \(merge, build, test\)$"
grep -qx "pnpm install --frozen-lockfile" "$STUB_LOG" && grep -qx "pnpm run --if-present build" "$STUB_LOG" && grep -qx "pnpm test" "$STUB_LOG" \
  && ok "4 pnpm path calls install, build --if-present, test" || bad "4 pnpm path calls install, build --if-present, test"
STUB_FAIL=install PATH=$ST case_run "$C" "$HEAD_SHA";   check "pnpm failing install" 1 "^FAIL install$"
STUB_FAIL=run PATH=$ST case_run "$C" "$HEAD_SHA";       check "pnpm failing build" 1 "^FAIL build$"
if command -v pnpm >/dev/null; then
  fx realpnpm main; mkbranch feat package.json '{"name":"x","version":"1.0.0"}' pnpm-lock.yaml "lockfileVersion: '9.0'"; adv h.txt y
  case_run --no-test "$C" "$HEAD_SHA"; check "4 real pnpm, no build script" 0 "^OK .* \(merge, build\)$"
  rm -rf "$W/tmp/node-compile-cache"
fi
fx nopkg main; mkbranch feat g.txt x; adv h.txt y
case_run "$C" "$HEAD_SHA"; check "4 no package.json without --no-build" 1 "^FAIL no package.json: pass --no-build$"
clean_state "4 no package.json" "$SNAP"

# 3: an interrupted run ends with FAIL interrupted and leaves nothing behind
fx intr main; mkbranch feat package.json '{}'; adv h.txt y
for sig in TERM INT HUP; do
  SNAP=$(snap)
  # perl restores the default SIGINT, which a background job inherits as ignored
  STUB_SLEEP=2 PATH=$ST TMPDIR=$W/tmp perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' "$MC" "$C" "$HEAD_SHA" >"$W/intr.out" 2>&1 & pid=$!
  for _ in $(seq 60); do [ "$(tg "$C" worktree list | wc -l | tr -d ' ')" = 2 ] && break; sleep 0.1; done
  kill -$sig $pid; wait $pid 2>/dev/null; rc=$?; out=$(cat "$W/intr.out"); last=$(tail -1 <<<"$out")
  check "3 SIG$sig: FAIL interrupted" 1 "^FAIL interrupted$"; clean_state "3 SIG$sig" "$SNAP"
done
# 3: a second signal during cleanup does not stop the cleanup
mkdir -p "$W/slowshim"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = remove ] && { : > "%s"; sleep 1.5; }; done\nexec "%s" "$@"\n' "$W/slow.mark" "$REALGIT" > "$W/slowshim/git"; chmod +x "$W/slowshim/git"
fx twice main; mkbranch feat package.json '{}'; adv h.txt y; SNAP=$(snap); rm -f "$W/slow.mark"
STUB_SLEEP=2 PATH="$W/slowshim:$ST" TMPDIR=$W/tmp perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' "$MC" "$C" "$HEAD_SHA" >"$W/twice.out" 2>&1 & pid=$!
for _ in $(seq 60); do [ "$(tg "$C" worktree list | wc -l | tr -d ' ')" = 2 ] && break; sleep 0.1; done
kill -TERM $pid
for _ in $(seq 100); do [ -e "$W/slow.mark" ] && break; sleep 0.1; done
kill -TERM $pid; wait $pid 2>/dev/null; rc=$?; out=$(cat "$W/twice.out"); last=$(tail -1 <<<"$out")
check "3 second TERM during cleanup: FAIL interrupted" 1 "^FAIL interrupted$"; clean_state "3 second TERM during cleanup" "$SNAP"
# 3: output of a failing merge or worktree add is quoted, so it cannot pose as a verdict
fx mergeout main; mkbranch feat g.txt x; adv h.txt y; mkdir -p "$C/.git/hooks"
printf '#!/bin/bash\necho "OK hook output"; echo "FAIL hook output"; exit 1\n' > "$C/.git/hooks/pre-merge-commit"; chmod +x "$C/.git/hooks/pre-merge-commit"
case_run --no-build "$C" "$HEAD_SHA"; check "3 failing merge" 1 "^FAIL merge$"
has "3 merge output is prefixed" "^\| FAIL hook output$"; verdict_only "3 merge output cannot fake a verdict"
fx addout main; mkbranch feat g.txt x; adv h.txt y; mkdir -p "$W/addshim"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = add ] && { echo "OK shim output"; echo "FAIL shim output"; exit 1; }; done\nexec "%s" "$@"\n' "$REALGIT" > "$W/addshim/git"; chmod +x "$W/addshim/git"
PATH="$W/addshim:$PATH" case_run --no-build "$C" "$HEAD_SHA"; check "3 failing worktree add" 1 "^FAIL worktree add$"
has "3 worktree add output is prefixed" "^\| FAIL shim output$"; verdict_only "3 worktree add output cannot fake a verdict"
# 3: a worktree that cannot be removed is reported before the verdict, and the verdict is FAIL
fx stuck main; mkbranch feat package.json '{}'; adv h.txt y
STUB_LOCK=1 PATH=$ST case_run "$C" "$HEAD_SHA"
check "3 cleanup failure is the verdict" 1 "^FAIL cleanup: .*merge-check\..* left behind$"
has "3 cleanup problem is printed" "^cleanup: could not remove "; verdict_only "3 cleanup failure: one verdict line"
[ "$(grep -n '^cleanup:' <<<"$out" | cut -d: -f1)" -lt "$(grep -c '' <<<"$out")" ] && ok "3 cleanup problem comes before the verdict" || bad "3 cleanup problem comes before the verdict"
chmod -R u+w "$W/tmp"; rm -rf "$W"/tmp/merge-check.*; tg "$C" worktree prune

# 6: the machine's kind of environment: an injected core.hooksPath and a global rerere.enabled
printf '#!/bin/bash\necho "OK hook says hi"\n' > "$W/hooks/post-checkout"; cp "$W/hooks/post-checkout" "$W/hooks/pre-merge-commit"; chmod +x "$W"/hooks/*
fx envhooks main; mkbranch feat g.txt x; adv h.txt y
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=$W/hooks case_run --no-build "$C" "$HEAD_SHA"
check "6 with an injected core.hooksPath" 0 "^OK .* \(merge\)$"; verdict_only "6 hook output cannot fake a verdict"
clean_state "6 hooksPath" "$SNAP"
printf '[rerere]\n\tenabled = true\n' > "$W/rerere.cfg"
fx envrerere main; mkbranch feat CHANGELOG.md "- feature"; adv CHANGELOG.md "- other"
GIT_CONFIG_GLOBAL=$W/rerere.cfg case_run --no-build "$C" "$HEAD_SHA"
check "6 with rerere enabled globally" 1 "^FAIL conflict: CHANGELOG.md$"
[ -z "$(ls -A "$C/.git/rr-cache" 2>/dev/null)" ] && ok "6 global rerere records nothing" || bad "6 global rerere records nothing"
clean_state "6 global rerere" "$SNAP"

# 7: a merge driver is flagged when it touches a path of the merge
fx driver main; printf 'CHANGELOG.md merge=union\n' > "$C/.gitattributes"; tg "$C" add .gitattributes; tg "$C" commit -qm attrs; tg "$C" push -q origin main
BASE=$(tg "$C" rev-parse HEAD); mkbranch feat CHANGELOG.md "- feature"; adv CHANGELOG.md "- other"
case_run --no-build "$C" "$HEAD_SHA"; check "7 union driver merges what a plain merge would conflict" 0 "^OK .* \(merge\)$"
has "7 note names the driver path" "^note: merge driver on CHANGELOG.md$"
case_run --no-build "$C" "$HEAD_SHA" >/dev/null; fx nodriver main; mkbranch feat g.txt x; adv h.txt y
case_run --no-build "$C" "$HEAD_SHA"; hasnt "7 no note without a merge attribute" "^note:"

echo "pass $pass fail $failn"
[ "$failn" = 0 ]
