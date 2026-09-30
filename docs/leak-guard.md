# Leak guard

agent-chat is a public repository, and a branch is public the moment it is pushed. The leak
guard scans text before it leaves the machine and refuses when it finds private data. This page
covers slices 1 and 2 of CC-265: the deny-list, the scanner, `agent-chat leak-scan` and the
pre-push hook on every spawned agent. The PreToolUse guard, the burndown backstop and the owner
override are later slices. The pre-push hook calls `titan-egress-scan` from
`@titan-design/egress-scan`, not `agent-chat leak-scan`: egress-scan is the scanning engine going
forward (CC-298), and this repository's scanner stays only until its remaining callers move.

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
`TITAN_EGRESS_REQUIRE_TERMS=1 titan-egress-scan pre-push <remote>` with the push's ref lines on
stdin, in the environment and the directory described below. It then runs the repository's own
`pre-push` with git's arguments and git's own ref lines. The push is refused if either one fails, and the repository's
hook runs even when the scan has already refused. The repository's hook is found with
`git rev-parse --git-path hooks` with the guard's variables removed, so a repository's own
`core.hooksPath` (husky, lefthook) is honoured.

Before scanning, the hook runs `titan-egress-scan --help` and looks for `pre-push`. A scanner
whose help works but lacks the command fails open with the same `guard NOT run` line and the
install hint. A scanner whose help check fails, or that passes it and then fails the scan, refuses
the push, because a guard that starts and then crashes has not shown the push is clean.

Each shim costs a shell and one git call, so only hooks that gate something are chained:
`pre-commit`, `commit-msg`, `pre-merge-commit`, `pre-rebase`, `post-checkout`, `post-merge`,
`post-rewrite`, the three `applypatch` hooks, `pre-auto-gc` and `sendemail-validate`.
`reference-transaction`, `post-index-change`, `prepare-commit-msg` and `post-commit` fire on every
commit without gating it and are not chained, so a repository's own copies of those do not run
for agents. Server-side hooks never run in an agent's repository.

What is scanned, and the rules, are egress-scan's: see its README. It exits 0 when clean, 1 on
findings and 2 on a usage or configuration error. The hook refuses on any non-zero exit.

### Inputs the agent's environment cannot change

The broker writes two values into the hook at each spawn. `PATH` is the broker's own `PATH`,
with relative entries dropped, and the whole hook runs under it. The term list is
`<home>/.config/titan-egress/private-terms`, where the home comes from the passwd entry
(`os.userInfo()`), not `$HOME`.

The hook starts git and the scanner for the scan through `env -i`, with that `PATH`, the term
list path and `TITAN_EGRESS_REQUIRE_TERMS` and nothing else. No variable of the agent's reaches
them: not `HOME`, `XDG_CONFIG_HOME`, `CI`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*` or
`GIT_*`. The repository's own hook still runs with the agent's environment and the agent's
`PATH`.

The hook's first line is `#!/bin/sh -p`. On macOS `sh` is bash 3.2, which imports shell
functions from `BASH_FUNC_<name>%%` variables and options from `SHELLOPTS`. A function named
`titan-egress-scan` replaced the scanner, and `SHELLOPTS=noexec` made the hook read its script,
run nothing and exit 0. With `-p` bash does neither. This was run on macOS `sh` (bash 3.2.57)
and on dash 0.5.12 (Ubuntu 24.04), which takes the flag and imports no functions in any case.
The `/bin/dash` that macOS ships rejects `-p` (`Illegal option -p`). Other shells are UNVERIFIED.
On a machine whose `/bin/sh` rejects the flag, the hook cannot start and every agent push is
refused.

Baking the two values in is safe because they come from the broker, which the owner started, and
the hook is rewritten at every spawn. The hook still bakes in no node or scanner path, only a
search path, so a node upgrade does not strand it. The owner's own `XDG_CONFIG_HOME` is ignored
as well: keep the term list under `~/.config`.

If `node` or `titan-egress-scan` is missing from the broker's `PATH`, the hook prints one line
starting `leak-scan: guard NOT run, this push was not scanned` that names the missing tool. It
then lets the push go ahead, still running the repository's own hook. This is a fail-open, and
it is the same as before this hardening: a leaky push from a machine with no scanner installed
goes through with one warning line. Whether it should refuse instead is an open owner decision.
The fix is to put node on the broker's `PATH`, or run `npm i -g @titan-design/egress-scan`, then
restart the broker.

### What the scanner reads

The scanner runs in an empty scratch repository that borrows the pushing repository's object
store (`objects/info/alternates`). It sees commits and nothing else. The worktree, the index,
the refs, the repository's config, `info/attributes` and replace refs are not there. This
matters because egress-scan skips a file git calls binary, and a `-diff` attribute makes any
file binary: an attributes file, in the repository or under the agent's `HOME`, passed a leak.
A replace ref over the pushed commit did the same.

The commits scanned for each pushed ref are `<base>..<pushed sha>`. The base is the sha git
reports for that ref on the remote, on the hook's stdin, when the ref exists there and the
commit is in the local object store. For a new ref, or a remote sha that is not local, the base
is the tip of the remote's default branch. The hook asks the push URL for it with
`git ls-remote <url> HEAD`, and fetches it into the scratch repository when it is not local.
Local remote-tracking refs are never used, because `git update-ref refs/remotes/origin/x <sha>`
writes one. This costs one more connection per push. A new ref pushed to a remote that names no
default branch is refused.

Both calls run scrubbed: `env -i` with the baked `PATH`, `HOME` set to the passwd home,
`SSH_AUTH_SOCK` passed through, `GIT_TERMINAL_PROMPT=0`, and `GIT_DIR` on the scratch
repository. So they read the system and the owner's global git config and nothing the agent can
set: no repository or worktree config, no `GIT_CONFIG_*` or `git -c`, no `GIT_SSH_COMMAND`,
proxy or askpass variables. The push URL git hands the hook already has `insteadOf` and
`pushInsteadOf` applied. If `git ls-remote --get-url` of it still differs from it, a rule in
the system or global config would send the read to another repository, and the push is refused.
A credential held only in the repository's config or in `GH_TOKEN` no longer reaches these
calls; such a push is refused as naming no default branch.
A new branch cut from another unmerged branch is scanned back to the default branch, so it
rescans that other branch's commits.

### The allow list: only the remote default branch's `.egress-allow`

egress-scan reads `.egress-allow` from the root of the directory it runs in. The hook puts one
file there: the `.egress-allow` blob at the tip of the remote's default branch, the same tip as
above. No other copy counts. An entry in the worktree, in the index, on `HEAD`, on the remote
branch being pushed to, or added by the commits being pushed is not read.

The reason is that an allow entry is an audited exception, and an entry the pushed commits add
has been audited by no one. An agent whose push is refused could otherwise add the entry and
push again. So an entry takes two pushes: first a change to `.egress-allow` alone, merged
through review, then the text it allows. The CI `egress-scan` job is looser. It reads
`.egress-allow` from the PR head, so it accepts an entry the same PR adds.

A scan with findings ends with a line saying that only entries on the remote's default branch
count. A push whose tip holds `.egress-allow` as anything but a regular file, a symlink for
example, is refused. If the default branch itself holds a symlink there, no entry is read.
`private-term` findings are never allowable in any case.

### What the hook closes and what it leaves

Closed, each with a test in `src/__tests__/leak-pre-push.test.ts` against a local bare
repository:

- a variable that swaps or blinds the scanner: `PATH`, `HOME`, `XDG_CONFIG_HOME`, `CI`,
  `TITAN_EGRESS_TERMS`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`;
- a shell function or `SHELLOPTS` in the environment, where `sh` is bash;
- a shadow `cat` on the agent's `PATH` that empties the ref lines the scan reads;
- an allow entry that is untracked, staged, hidden by `git update-index --skip-worktree`, on an
  unpushed `HEAD`, behind a committed symlink, or added by the pushed commits;
- git attributes, in the repository or under the agent's `HOME`, and replace refs;
- a forged remote-tracking ref that hides commits from the scan range;
- a `url.<base>.insteadOf` rule, paired with a `pushInsteadOf` so the push still goes to the
  real remote, that sends the scan base lookup to another repository whose default branch holds
  the pushed commits. Tested from four sources: the repository's config, `GIT_CONFIG_COUNT`
  entries, `git -c`, and the owner's global config (refused by the `--get-url` check).

Not closed by the hook. A pre-push hook runs only when git is told to run it, so it cannot stop
a caller who turns hooks off:

- `git push --no-verify`, `git -c core.hooksPath=<dir> push`, and `GIT_CONFIG_COUNT=0 git push`
  or any other change to the `GIT_CONFIG_*` variables that carry the hooks path. Denying these
  spellings in an agent's Bash command is the PreToolUse guard's job (CC-270). The CI
  `egress-scan` job scans the pushed commits with the generic rules after the fact;
- `GIT_*` variables and git config that change what the push itself sends or where, such as
  `GIT_DIR`, `remote.<name>.receivepack`, `git push --receive-pack`, or `GIT_SSH_COMMAND` and
  `core.sshCommand` on the push's own connection. The scan base lookup no longer reads them,
  but the push does (UNVERIFIED: reasoned, not run);
- an ssh remote under the scrubbed lookup, which should find the agent through `SSH_AUTH_SOCK`
  and read `~/.ssh/config` from the passwd home (UNVERIFIED: no ssh remote was tested);
- a push that does not go through git, such as an upload over the GitHub API;
- a missing scanner, which fails open as described above;
- text in a PR title or body, which the hook never sees.

The trust limit is the OS account. An agent runs as the owner's user, so it can edit the hook
file, the term list or the installed scanner. The hook stops a careless agent and the variable
and repository-state tricks listed above; it does not sandbox one that sets out to get past it.

### The private term list

egress-scan reads its private terms from `$TITAN_EGRESS_TERMS`, else
`${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`. The hook always passes
`~/.config/titan-egress/private-terms` under the passwd home, as described above. The file holds
one term per line, mode 0600, and never lives in any repository. The hook sets `TITAN_EGRESS_REQUIRE_TERMS=1`, so while that file is
missing every agent push is refused with one line naming the file to create. The scanner's
environment has no `CI`, because egress-scan never reads the term list when `CI` is set.

The hook ignores an inherited `TITAN_EGRESS_TERMS`. It overwrites the variable with the baked
path for the scanner call, so pointing it at `/dev/null` or an empty file cannot switch the scan
off, and a missing default file still refuses the push. A profile's `env` cannot pass
`TITAN_EGRESS_TERMS` either: it is reserved, like `GIT_CONFIG_*`.

`MISSING_TERMS_REFUSES` in `src/leak-guard/hooks-dir.ts` is the switch. Set to `false`, the hook
stops requiring the list, and a push with no list goes ahead, scanned with the generic rules only,
after a `leak-scan: WARNING` line naming the file.

Two gaps remain until titan-platform TP-559 lands. An empty term list loads and passes, so
creating an empty file silences the refusal without enforcing anything. And any other entry point
that runs egress-scan with a `CI` value skips the terms without saying so.

The owner's escape hatch for an emergency is `git push` from their own shell, which carries no
`GIT_CONFIG_*` variables and so runs no guard hook.

The hook alone does not stop an agent that tries to skip it. `git push --no-verify` skips every
pre-push hook, and `git -c core.hooksPath=<dir> push` points git elsewhere, since command-line
config overrides the environment. The PreToolUse bypass guard in a later slice (S4) denies both.
