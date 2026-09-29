# Leak guard

agent-chat is a public repository, and a branch is public the moment it is pushed. The leak
guard scans text before it leaves the machine and refuses when it finds private data. This page
covers slices 1 and 2 of CC-265: the deny-list, the scanner, `agent-chat leak-scan` and the
pre-push hook on every spawned agent. The PreToolUse guard, the burndown backstop and the owner
override are later slices.

## The deny-list

The deny-list is `private-denylist.json` in the agent-chat home (`~/.agent-chat/` unless
`AGENT_CHAT_HOME` moves it). The owner writes it by hand and keeps it at mode 0600. No
repository holds it, no fixture copies it, and the scanner never prints its entries.

```json
{
  "owner-email": ["someone@example.com"],
  "private-name": ["a-seat-name", "a-private-repo"],
  "private-path": ["some/private/dir/"]
}
```

Every key is optional. Any other key, a non-string entry or an empty entry makes the file
unreadable rather than silently dropping the entry.

| Category       | Source                                                                 | Match                                                                                   |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `home-path`    | the running user's home from `os.homedir()` at scan time, never stored | the home prefix as a whole path segment, and the `~/` form of the active-work data root |
| `owner-email`  | `owner-email`                                                          | the exact address, case-insensitive                                                     |
| `private-name` | `private-name`                                                         | a whole word, case-insensitive                                                          |
| `private-path` | `private-path`                                                         | a substring, case-insensitive                                                           |

`~/projects/<repo>` paths are not flagged, because public docs already use them.

A built-in allow-list lets synthetic fixtures pass: `/Users/example`, `/home/example`,
`/Users/test*`, and any address at `example.com`, `example.org`, `*.test` or `*.invalid`. It
applies to the matched span only, so `/Users/example/x` passes while the real home still fails.
Tests must use these forms or other made-up values, never captured real data.

## What is scanned

`--range <from>..<to>` scans each commit in the range on its own: the lines it adds
(`git log -p --unified=0 --text`), the paths of files it adds, and its message. A push
publishes every commit, so a leak that one commit adds and a later commit removes still fails,
at the commit that added it. A merge is diffed against its first parent. A removed line never
counts, so a commit that only deletes a leak passes. Binary files are scanned as text, and long
lines are scanned in linear time.

`--text-file <file>` scans every line of a file, such as a PR title or body before it is posted.

## Output never echoes a secret

A finding prints as `file:line  category`, prefixed in a range scan by the 12-character sha of
the commit that added it. A finding in a commit message adds
`(commit message)`, and a finding in a file name adds `(file name)`. If a file path itself
matches, the matched part is shown as `[redacted]`. Nothing prints the matched text or the
deny-list entry. That rule covers stdout, stderr, `--json`, and the error messages about a
broken deny-list, which name the problem but never quote the file. `src/__tests__/leak-scan.test.ts`
enforces this by searching every output stream for the fixture entries.

`--json` prints `{ "denylist": "ok" | "missing" | "empty" | "unreadable", "findings": [...] }`.
Each finding holds `site`, `file`, `line`, `category` and `fingerprint`, and `commit` in a range
scan. The fingerprint is a short
hash of the category, entry, file and line text. A later slice uses it as the override key.

## Exit codes

| Code | Meaning                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | clean, with a readable deny-list                                                                                                             |
| 1    | at least one finding                                                                                                                         |
| 2    | the scan cannot pass: the deny-list is missing or unreadable, the range is not `<from>..<to>`, git could not read it, or the flags are wrong |

A deny-list that parses but has no entries counts as missing. A missing deny-list and an
unreadable one are reported differently on stderr, but both fail
closed. The scan still enforces `home-path`, which needs no file. It exits 1 if that finds
something, and 2 otherwise, because a scan without the owner's entries has not shown the text
is clean. An unreadable file is one that exists but cannot be read, is not valid JSON, or has the
wrong shape.

## Checking a branch by hand

```sh
agent-chat leak-scan --range origin/main..HEAD
```

## The pre-push hook on every spawned agent

Every agent the broker spawns carries `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.hooksPath` and
`GIT_CONFIG_VALUE_0=<agent-chat home>/git-hooks` in its environment. git reads these as
command-line config, so every repository the agent pushes from uses the guard's hooks, and no
repository's `.git/config` is written. A profile's `env` cannot set any `GIT_CONFIG_*` key. A
human's own shell has none of these variables, so the owner's pushes are unaffected.

The broker rewrites `git-hooks/` at each spawn. `pre-push` runs
`agent-chat leak-scan --pre-push --remote=<name> --url=<url>` with git's ref lines on stdin, then
runs the repository's own `pre-push` with the same arguments and stdin. The push is refused if
either one fails, and the repository's hook runs even when the scan has already refused. The
repository's hook is found with `git rev-parse --git-path hooks` with the guard's variables
removed, so a repository's own `core.hooksPath` (husky, lefthook) is honoured.

`node` and `agent-chat` are found on the agent's `PATH` when the hook runs. The hook never bakes
in a path, because a versioned node or a worktree's `dist/` can disappear. If either is missing,
the hook prints one line starting `leak-scan: guard NOT run, this push was not scanned` that names
the missing tool. It then lets the push go ahead, still running the repository's own hook. This
fails open on purpose: a missing guard must not refuse every push from every agent, and the
burndown backstop (a later slice) still reports a leak that got through. The fix is to put node on
the agent's `PATH` or run `npm link` in the agent-chat checkout.

Each shim costs a shell and one git call, so only hooks that gate something are chained:
`pre-commit`, `commit-msg`, `pre-merge-commit`, `pre-rebase`, `post-checkout`, `post-merge`,
`post-rewrite`, the three `applypatch` hooks, `pre-auto-gc` and `sendemail-validate`.
`reference-transaction`, `post-index-change`, `prepare-commit-msg` and `post-commit` fire on every
commit without gating it and are not chained, so a repository's own copies of those do not run
for agents. Server-side hooks never run in an agent's repository.

For each pushed ref the scan covers the commits the remote does not have yet: those not reachable
from the remote's tracking refs or from the sha the remote reports for that ref. A deleted ref
pushes nothing and is not scanned.

| Deny-list                  | Clean push                           | Findings, private remote | Findings, public or unknown remote |
| -------------------------- | ------------------------------------ | ------------------------ | ---------------------------------- |
| readable                   | allowed                              | warned, allowed          | refused                            |
| missing or with no entries | allowed                              | warned, allowed          | refused (home-path only)           |
| present but unreadable     | refused unless the remote is private | warned, allowed          | refused                            |

A missing or empty deny-list prints one line naming the file and pointing here, and checks
`home-path` only. That lets the hook ship before the owner writes the file. An unreadable one
refuses, because a file that exists was meant to be enforced. Its message says to fix the file's
permissions or delete it.

Visibility comes from `gh api repos/<owner>/<repo> --jq .visibility` (REST, never GraphQL) and is
cached for 24 hours in `repo-visibility.json` in the agent-chat home. `internal` counts as
private. A failed lookup, an unexpected answer or a non-GitHub remote is unknown, which refuses
on findings exactly as public does. Only known answers are cached, so a failed lookup is retried
on the next push. Lookups happen only when there is something to refuse.

A refusal prints each finding as `file:line  category` on stderr, and never the remote URL or a
deny-list entry.

The owner's escape hatch for an emergency is `git push` from their own shell, which carries no
`GIT_CONFIG_*` variables and so runs no guard hook.

The hook alone does not stop an agent that tries to skip it. `git push --no-verify` skips every
pre-push hook, and `git -c core.hooksPath=<dir> push` points git elsewhere, since command-line
config overrides the environment. The PreToolUse bypass guard in a later slice (S4) denies both.
