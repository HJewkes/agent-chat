# Return contract

The broker appends one of these blocks to the brief of every agent a registered session spawns,
chosen by the profile, with `<spawner>` replaced by the spawner's registered name. Do not paste
them into a brief. The broker reads this file on each spawn: the fenced text under a heading is
the block, and the heading is the contract's name.

A profile takes the contract its `returnContract` field names (`implementer`, `reviewer` or
`none`). A profile without the field takes the contract its name carries as a whole word
(`<prefix>-implementer`, `<prefix>-reviewer-<suffix>`), and only when it is a worker whose grants
agree: an implementer may Edit, a reviewer may not. Every other profile takes none.

## implementer

```
Check `gh api repos/<owner>/<repo> --jq .visibility`. In a public repo, never commit or
paste captured real data into code, fixtures, PR bodies or comments: task lists, charter or
seat files, /Users paths, emails, or IDs and text from private repos. Use synthetic
fixtures. First run `git log origin/<default> --oneline --grep <ID>` and stop if it has
landed. Branch from origin/<default>; check `git log origin/<default>..HEAD`. Commit before
mutating; never `git checkout` uncommitted work. Scratch files go in the worktree or
`$TMPDIR/<your name>`. Make GitHub writes (merge PUT, PR create, comment, PR body PATCH)
through `agent-chat gh-write -- <gh args>` when `agent-chat gh-write --help` prints a usage
line naming `gh-write`; otherwise use plain `gh`, and verify each write landed. On a 403
"API rate limit exceeded" with core quota left, wait 5 minutes and retry once. Before the
first push in agent-chat, run `npm ci` in your worktree: its pre-push egress hook needs the
scanner there and fails closed otherwise (CC-313). Never use --no-verify. Wait for CI with
`gh run watch <id> --exit-status` in the foreground. Never end a turn on a background task,
a sleep or a ScheduleWakeup: a headless agent exits at turn end and the task dies with it.
Load tests kill burners with `pkill -f '<pattern>'` and confirm with pgrep. A PR that
narrows a timeout reports per-case CI times against the new limit. You are NOT done at "PR
opened". Your LAST action must be chat_send to <spawner> starting with
`Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`, `PR: <owner>/<repo>#<n>` and
`Head: <full sha>` lines, then CI status.
```

## reviewer

```
Plain-text stdout is invisible to <spawner>. Your LAST action must be chat_send to
<spawner>, under 1,200 characters in total, starting with exactly these three lines:
Verdict: MERGE            (or FIX_FIRST)
PR: <owner>/<repo>#<n>
Head: <full 40-hex head sha>
Then blocking items before nits. A verdict counts only when Head equals the PR's current
head exactly.
```
