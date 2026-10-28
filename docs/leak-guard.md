# Leak guard

agent-chat is a public repository, and a branch is public the moment it is pushed. The leak
guard scans text before it leaves the machine and refuses when it finds private data. This page
covers slices 1, 2 and part of 4 of CC-265: the deny-list, the scanner, `agent-chat leak-scan`,
the pre-push hook on every spawned agent and the PreToolUse bypass guard. The burndown backstop
and a per-finding owner override are not built yet. The pre-push hook calls `titan-egress-scan` from
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

The baked search path is the broker's `PATH` followed by two dirs from agent-chat's own install
(CC-461): the `node_modules/.bin` holding the `@titan-design/egress-scan` that agent-chat depends
on, and the dir of the node running the broker. They come after the broker's own entries, so a
scanner the owner installed globally still wins, and the `.bin` dir is added only when its
`titan-egress-scan` links to that package's `dist/bin.js`. A broker started without the scanner
on its `PATH` therefore still scans.

If `node` or `titan-egress-scan` is missing from that search path, the hook prints one line
starting `leak-scan: guard NOT run, this push was not scanned` that names the missing tool. It
then lets the push go ahead, still running the repository's own hook. This is a fail-open, and
it is the same as before this hardening: a leaky push from a machine with no scanner installed
goes through with one warning line. Whether it should refuse instead is an open owner decision.
The fix is to put node on the broker's `PATH`, or run `npm i -g @titan-design/egress-scan`, then
restart the broker.

### What the scanner reads

The scanner runs in an empty scratch repository that borrows the pushing repository's object
store (`objects/info/alternates`). It sees commits and nothing else. It does not read the author and
committer idents or the ref names: a term in `GIT_AUTHOR_NAME`, and a branch named after a term, both
reached the remote. The worktree, the index,
the refs, the repository's config, `info/attributes` and replace refs are not there. This
matters because egress-scan skips a file git calls binary, and a `-diff` attribute makes any
file binary: an attributes file, in the repository or under the agent's `HOME`, passed a leak.
A replace ref over the pushed commit did the same.

The commits scanned for each pushed ref are `<base>..<pushed sha>`. The base is the sha git
reports for that ref on the remote, on the hook's stdin, when the ref exists there and the
commit is in the local object store. For a new ref, or a remote sha that is not local, the base
is the tip of the remote's default branch. The hook lists the push URL with
`git ls-remote <url>`, reads `HEAD` from that listing, and fetches the tip into the scratch repository
when it is not local.
Local remote-tracking refs are never used, because `git update-ref refs/remotes/origin/x <sha>`
writes one. This costs one more connection per push. The scanner also excludes every commit that listing
advertises, so commits already on the remote (a main merged into the branch) are not rescanned.
The scanner runs with `PATH` alone, so it cannot log in to a private remote; the hook therefore
hands it a local bare repository under the scratch directory, whose `packed-refs` holds the listed
tips and whose objects come from the same alternates, as its push URL. The scanner's own
`ls-remote` of that path touches no network. If the hook's listing fails, the list is empty and
only the remote sha of each ref is excluded: the full `<remote sha>..<pushed sha>` range. A merge
commit is still a new commit, and the scanner reads its diff against each parent. A new ref pushed to a remote that names no
default branch is refused.

Both calls run scrubbed: `env -i` with the baked `PATH`, `HOME` set to the passwd home,
`SSH_AUTH_SOCK` passed through, `GIT_TERMINAL_PROMPT=0`, and `GIT_DIR` on the scratch
repository. So they read the system and the owner's global git config, plus what the repository's
objects directory holds, and no repository or worktree config, `GIT_CONFIG_*` or `git -c`,
`GIT_SSH_COMMAND`, proxy or askpass variables. The push URL git hands the hook already has
`insteadOf` and `pushInsteadOf` applied. If `git ls-remote --get-url` of it still differs from it,
a rule in the system or global config would send the read to another repository, and the push is
refused. Both calls pass `--upload-pack=git-upload-pack`, so a global `remote.<url>.uploadpack`
cannot redirect them. If the scrubbed config sets `core.sshCommand`, the push is refused: the lookup
no longer sees the agent's `GIT_SSH_COMMAND`, so it could read through a different ssh than the push
uses. A failed lookup is refused as a failed lookup.
A credential held only in the repository's config or in `GH_TOKEN` no longer reaches these
calls; such a push fails the lookup and is refused.
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
  entries, `git -c`, and the owner's global config (refused by the `--get-url` check);
- a pushed object that is not a commit: a blob or tree sha sent to a tag ref, an annotated tag, or an
  existing tag moved to a blob. Their text (content, path names, a tag message) is outside what the
  scanner reads, so `git cat-file -t` in the scratch view must say `commit` or the push is refused,
  exit 2, naming the remote ref. A lightweight tag on a commit and a ref deletion still pass.

Not closed by the hook. A pre-push hook runs only when git is told to run it, so it cannot stop
a caller who turns hooks off:

- `git push --no-verify`, `git -c core.hooksPath=<dir> push`, and `GIT_CONFIG_COUNT=0 git push`
  or any other change to the `GIT_CONFIG_*` variables that carry the hooks path. Denying these
  spellings in an agent's Bash command is the PreToolUse guard's job (CC-270). The CI
  `egress-scan` job scans the pushed commits with the generic rules after the fact;
- `GIT_*` variables and git config that change what the push itself sends or where, such as
  `GIT_DIR`, `remote.<name>.receivepack`, `git push --receive-pack`, or `GIT_SSH_COMMAND` on the
  push's own connection. The scan base lookup does not read the agent's values, but the push does
  (UNVERIFIED: reasoned, not run);
- an ssh remote under the scrubbed lookup, which should find the agent through `SSH_AUTH_SOCK`
  and read `~/.ssh/config` from the passwd home (UNVERIFIED: no ssh remote was tested);
- owner-global and system git config, which the tip lookup trusts. Settings there such as
  `http.proxy`, `http.<url>.proxy` and `remote.<name>.proxy`, and `~/.ssh/config` (`Host`,
  `ProxyCommand`) for ssh remotes, can send the lookup somewhere other than where the push goes,
  so the scan base is read from a repository the push does not update. The scrub covers
  config the agent can write, and a writer of the owner's global config is outside the guard's
  model. UNVERIFIED: `http.proxy` was observed only on an http:// remote, and an https remote
  also needs TLS interception; `~/.ssh/config` was not run. Hardening: run the lookup with
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and an explicit credential helper,
  tracked as CC-355 (not done);
- a push that does not go through git, such as an upload over the GitHub API;
- a missing scanner, which fails open as described above;
- text in a PR title or body, which the hook never sees;
- author and committer idents and ref names, which the scanner does not read (observed).

The trust limit is the OS account. An agent runs as the owner's user, so it can edit the hook
file, the term list or the installed scanner. The hook stops a careless agent and the variable
and repository-state tricks listed above; it does not sandbox one that sets out to get past it.

### Binary files are scanned as text (CC-343)

From `@titan-design/egress-scan` 0.2.0 the scanner passes `--text` to git, so a file git calls
binary, one NUL byte is enough, is scanned line by line like any other. A commit whose patch text
is over 128 MiB is refused, with one line naming the commit and the limit. UTF-16 text is not
matched: the scanner reads bytes as UTF-8, so a term written as UTF-16 still passes.

The hook checks for this. A scanner whose `--help` lacks `scanned as text`, that is 0.1.x, skips
binary files, so the hook refuses the push and prints the install hint. A missing scanner or one
without `pre-push` still warns and lets the push go.

Upgrade the global scanner before the broker restart that loads this hook, or every agent push is
refused: `npm i -g @titan-design/egress-scan@0.2.0`.

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
config overrides the environment. The PreToolUse bypass guard below denies both.

## The PreToolUse bypass guard

Every spawned agent runs with a `--settings` file holding a PreToolUse hook,
`agent-chat leak-guard pretool`, on `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`.
A headless agent's file also holds its PermissionRequest hook. An interactive agent gets the
PreToolUse hook only, and its `--settings` flag is added when the launch plan is written.

**This guard is a speed bump, not a boundary.** It reads a command line with a small shell
splitter and denies the ordinary spellings of a bypass. An agent that wants to get past it can,
for example by writing a script file and running it. It exists so that an agent does not skip
the scan by habit or by following a stale instruction. The pre-push hook and, once built, the
burndown backstop are what catch a leak.

It denies a Bash command when any simple command in it, after `env`, `command`, `exec`, `nohup`,
`nice`, `timeout`, `caffeinate`, `coproc`, `sudo`, the other privilege wrappers below, zsh's `noglob`, `nocorrect` and `repeat <n>`,
`if`/`then` and other prefixes are stripped, is one of these. A wrapper is known by its base name, so
`/usr/bin/nice` is stripped like `nice`. The options of `nice`, `timeout`, `stdbuf`, `ionice`,
`caffeinate` and `exec` are read the way their getopt reads them (long-name prefixes, `--opt value`,
short clusters such as `-it 5` whose value letter takes the next word), so a value is never read as
the command. Under `sudo` the guard treats the directory and config as
unknown, because sudo resets HOME and `-D`, `-R` and `-i` move the cwd; a `sudo` long option it does
not know, an option word or option value the shell expands (an empty `$U` in `sudo -u $U` shifts the
command word, CC-1291), or a bare `-h` before another word (`--help` or `--host`,
by sudo version) denies. `sudo -s`, `-i`, `--shell` and `--login` run a shell, so the guard checks
`sh -c` on the words joined and escaped as sudo does, or the shell's stdin when no words follow;
an expansion or xargs input among those words denies (CC-1209).

`sudo-rs` and `sudo.ws`, the names sudo has where sudo-rs is the default, are read as `sudo`.
`doas`, `run0`, `systemd-run` (the binary `run0` links to), `pkexec`, `su`, `su-rs`, `runuser`,
`setpriv` and `machinectl shell` are stripped the same way, their options read from per-wrapper
tables (`src/leak-guard/privilege-wrappers.ts`). An option a table does not know, an option missing
its value, or an option word or value the shell expands denies. A word holding `$` behind
`systemd-run` denies, since systemd-run expands it from the unit's environment. On `systemd-run` and
`run0` a `-p`/`--property` unit property denies unless it is on an allow-list of resource and timing
properties (`MemoryMax`, `CPUQuota`, `Nice` and the like), since others such as `ExecStartPre` or
`StandardInputText` set what runs or feed it; `--path-property`, `--socket-property` and
`--timer-property` always deny. `runuser -u <user>` runs its words as the command, with no shell;
without `-u` it reads as `su`. `machinectl shell [host] <command>` runs the words after the machine
name; its other verbs run no command. `su -c '<line>'`, `doas -s`, `run0 -i` and `--via-shell`, and a
bare `su`, `run0` or `pkexec` run a shell, so the guard checks that shell's script or its stdin, with
the `$SHELL` rule below; xargs input to one denies. `sg <group> [-c] <command>` runs its one command
in a shell, so the guard checks it as a script; a second candidate command (util-linux and shadow
pick differently) or any word the shell expands denies. `newgrp`, the binary `sg` links to, is read
the same way; with no command it runs a shell on stdin, which the guard checks. `capsh` runs nothing unless `--` or `-+`
hands the words after it to bash or a `--shell=` shell, which the guard checks; a `--shell=` that is
not a shell, an option capsh does not list, or an expanded word denies (CC-1602). `gosu`, `su-exec`,
`chpst`, `setuidgid` and `s6-setuidgid` are not covered.

Behind any of these wrappers, a `git push` (any flags, through `sh -c`, `eval`, xargs, env or
`find -exec`) and any `gh` or `agent-chat gh-write`, reads included, deny outright. sudo's
`env_reset` and `secure_path` drop the `GIT_CONFIG_*` hooks path and the git and gh shim
directories, so the pre-push scan, the push-time shim and gh-write's scan never run, and gh reads the
target user's config. That the other wrappers drop them the same way through their own environment
resets is UNVERIFIED; plain `su`, `systemd-run --scope` and `setpriv` without `--reset-env` keep most
of the environment but still run as the target user. The guard denies under every one either way. A
stronger reason (`--no-verify`, a `GIT_CONFIG_*` assignment) is still reported first. A command
beside the wrapped one on the line is not affected (CC-1218).

For the same reason, behind any of these wrappers the guard denies what it cannot read instead of
leaving it to those run-time checks. A command word that is an expansion (`sudo $(echo git push)`,
``sudo `echo git` push``, `CMD='git push'; doas $CMD`, also inside `sudo sh -c` or after
`sudo env` or `sudo nice`) denies on a line that may reach git or gh, so `doas $EDITOR /etc/hosts`
stays allowed. A literal git with no subcommand word, as in `sudo git --version`, runs none and is
allowed (CC-1218).

util-linux's `setsid`, `flock <file>`, `taskset <mask>`, `chrt <priority>`, `script` and `unshare`
are stripped too, their options read from util-linux 2.41's tables (CC-1414). An option missing
from a table, an option word or option value the shell expands (a `flock -c` text included), or
any expanded word after `script` (whose getopt reads options anywhere), denies on a line that may
reach git or gh.
`taskset -p` and `chrt -p` read the same way: util-linux takes the pid from the last word, and
pid 0 (`0`, `00`, `+0`) runs the words after the mask or priority. An operand the shell expands
(`~/f.lock`, `"$HOME/f.lock"`, `$F`) is not read as the command: like an expanded option, it denies
on a line that may reach git or gh. A `chrt` priority that strtoimax would not read (`+0` and ` 0`
are priorities) is read as the command. util-linux 2.41's `chrt` skips one `--` after its priority, so the
command is read after it (2.39's runs a command named `--`); `taskset` and `flock` run a command
named `--`.
`flock <file> -c <text>` and `script -c <text>` are checked as `sh -c <text>`, also when the lock
file is a `~/` path. Every word the guard reads to find where the command or `-c` text starts goes
through one test: a word the shell may turn into an option, `--`, or none or several words denies on
a line that may reach git or gh. That covers an unquoted `$F`, which may split, a quoted `"$F"` or
`"$HOME/f.lock"`, which may start with `-`, and an expanded word where flock's `-c` would be
(`flock f "$X" TEXT`), the word after `--` included. One word that starts with a literal other than `-`, or with `~/`, passes.
`script` without
`-c`, and `unshare` with no command, as a shell reading stdin. Those run `$SHELL`, which the guard
derives as it derives git's config env: from the command's assignments (`env` included), earlier
exports, and the hook env. A `SHELL` outside the guard's shell list, or one it cannot tell (named
on the line in a way it cannot follow, or after `source`), denies on a line that may reach git or gh. Under `unshare` the directory is unknown, since `-R` and `-w` move it. BSD and
macOS `script [file [command ...]]`, which runs its trailing words, is not covered. `sudo -s` and `--shell` run `$SHELL` too and get the same rule; `sudo -i` runs the passwd-entry shell, so a `SHELL` on the line does not change it.

`prlimit`, GNU `time` (a bare `time` is read both ways and denies if either reading does: as GNU
time, which dash, a quote, a pipe or `command` give, and as the bash and zsh keyword, which skips
every option word, since a word such as `-o` after it is a command that may run the rest),
`numactl`, `nsenter`, `chroot <root>`, `setarch [<arch>]` and its `linux32`, `linux64`, `i386`,
`x86_64` and `uname26` names, `enosys`, `uclampset`, `coresched <function>` and `busybox setsid`
are read the same way, each from its own binary's getopt string (CC-1424). `nsenter`, `chroot`
and `setarch` with no command run a shell, read as one reading stdin. `coresched` permutes, so its
command is read only when it ends the line with no option among it, and a `chroot` command word
starting with `-` denies, since uutils' chroot may read it as an option. `scriptlive`, which types a
log file into what it runs, and `busybox` with an applet other than `setsid` and those below, deny on a line that may
reach git or gh.

`busybox` runs the applet its first word names, by basename, so `busybox /bin/sh` runs `sh`. Its
`sh`, `ash`, `env`, `timeout` and `xargs` applets are checked as the command they name, each of
which stops at its first operand and takes a subset of the GNU options: `busybox sh -c TEXT` and
`busybox env git push` read as `sh -c TEXT` and `env git push` do. `ash`, busybox's shell and
Alpine's `/bin/ash`, is a checked shell like `sh` (CC-1342).

| Denied                                                                                                                                                                                                                                                                                                                                    | Why                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `git push` with `--no-verify`, or its abbreviations `--no-veri` and `--no-verif`, anywhere before `--`                                                                                                                                                                                                                                    | skips the pre-push hook                                     |
| `git -c` or `--config-env` on `core.hooksPath` or any `alias.*` key                                                                                                                                                                                                                                                                       | command-line config beats the guard's environment           |
| `git -c` or `--config-env` on `include.path` or `includeIf.<cond>.path` whose file sets `core.hooksPath`                                                                                                                                                                                                                                  | an included file is command-line config too                 |
| `git -c` or `--config-env` with a key or variable name the guard cannot read, before a hook-running subcommand (below)                                                                                                                                                                                                                    | an unread value may be `include.path` or `core.hooksPath`   |
| a git word that may be an alias, on a line that writes git config (below)                                                                                                                                                                                                                                                                 | the alias lookup reads config before the line changes it    |
| a `GIT_CONFIG*` assignment, `export`, `export -n`, `unset`, `declare` or `env -u`                                                                                                                                                                                                                                                         | removes or overrides the guard's `core.hooksPath`           |
| `env -i` or `env -`                                                                                                                                                                                                                                                                                                                       | clears the environment, guard included                      |
| `git config` writing or unsetting `core.hooksPath`, or writing a value that holds `--no-verify`                                                                                                                                                                                                                                           | a hooks path or alias in shared repo config                 |
| any mention of the guard's hook directory or the private term list; an edit tool writing to either                                                                                                                                                                                                                                        | rewriting the hook or emptying the term list                |
| `gh pr` or `gh issue` `create`, `edit`, `comment`, `review` or `merge` whose title or body has a finding                                                                                                                                                                                                                                  | the text is public the moment it is posted                  |
| one of those commands, or `gh api`, with an argument or body file the guard cannot be sure of                                                                                                                                                                                                                                             | the guard would scan one text and gh post another           |
| `gh api` whose `-f`, `-F` or `--input` values have a finding                                                                                                                                                                                                                                                                              | the same text by another route                              |
| a command word that is an expansion, followed by the words of one of those gh commands                                                                                                                                                                                                                                                    | `$G pr create` may run gh unscanned                         |
| a command word that is an expansion, followed by a command that any row above denies                                                                                                                                                                                                                                                      | `$E gh pr create` runs gh when `E` is empty                 |
| a command word that is an expansion, then an expansion where git's subcommand sits, or a command word that may split (`${=X}`, unquoted `$X`), with a word anywhere after, even past a `--`, that is or may expand to `--no-verify` or a `core.hooksPath`, `alias.*`, `include.path` or `includeIf.*.path` key (`core.hooks$K`) (CC-1322) | `$X $Y --no-verify` is a push that skips the hook           |
| a command word that is an expansion run as a shell, whose `-c` string or fed text a row above denies, or whose fed text the guard cannot read                                                                                                                                                                                             | `b=bash; echo '<push>' \| $b` runs it                       |
| `eval` of text the guard cannot be sure of, on a command line that names `git` or `gh`; a `trap` action or `mapfile -C` callback it cannot read, on a line that may reach either                                                                                                                                                          | the text may be a push or a gh command                      |
| a command git runs for its subcommand that a row above denies, or that the guard cannot read (below)                                                                                                                                                                                                                                      | `git rebase -x` runs a shell command unseen                 |
| `git -c` or `--config-env` on an include, or with a key the guard cannot read, before a command git runs (below)                                                                                                                                                                                                                          | git passes it on to every git that command runs             |
| `git -c` on a key whose value git runs as a program, when the value is a line a row above denies (below)                                                                                                                                                                                                                                  | `core.pager="git push --no-verify"` runs on `git log`       |
| `git -c` or `--config-env` on such a key with a value the guard cannot read, or with a key it cannot read, on any git                                                                                                                                                                                                                     | the value may be a push with hooks off                      |
| a program-running env var (`GIT_PAGER`, `GIT_EDITOR`, `GIT_SSH_COMMAND`, `MANPAGER` and kin, below) on a line that runs git: a plain literal assignment whose value a row above denies, or any other use but a read                                                                                                                       | git runs the value as a pager, editor or ssh command        |
| an `ext::` transport in any git word or config value whose decoded shell command a row above denies (below)                                                                                                                                                                                                                               | `protocol.ext.allow` lets `ext::` run a shell command       |
| a gh alias whose body a row above denies, when `gh alias set` stores it or `gh <alias>` runs it; `gh alias import`, a body or argument the guard cannot read, or a line that writes gh config or moves its home (below)                                                                                                                   | `gh alias set x '!git push --no-verify'` runs git unseen    |
| `GIT_ALLOW_PROTOCOL` listing `ext` on any line; unreadable or unset on a line that runs git; `git config` on `protocol.allow` or `protocol.ext.allow` but `never`; an unread remote URL or config key (below)                                                                                                                             | a later git runs `ext::` as shell                           |
| a gh extension (`gh <word>` that is no gh command or alias, `gh extension exec`); `gh repo clone`, `gh repo fork --clone` or `gh gist clone` git flags after `--` that a row above denies as `git clone`, or that the guard cannot read (below)                                                                                           | `gh repo clone o/r -- -c core.pager=<push>` runs git unseen |
| a git or gh command run by `xargs` that a row above denies with the words xargs adds read as unreadable; a `git push` there unless a literal `--` comes before those words (below)                                                                                                                                                        | `echo --no-verify \| xargs git push` skips the hook         |
| `ssh`, `scp` or `sftp` with an `-o` keyword ending in `Command`, a `-F` file other than `/dev/null`, scp or sftp `-S` or `-D`, or an unread option word, anywhere, `GIT_SSH_COMMAND` and `core.sshCommand` included (below)                                                                                                               | `ssh -oProxyCommand=<push> h` runs a command unseen         |
| `BASH_ENV`, `ENV`, `ZDOTDIR`, `GIT_EXEC_PATH` or `GIT_TEMPLATE_DIR` used other than by a read or an unset, on a line that may reach git or gh (below)                                                                                                                                                                                     | `BASH_ENV=/tmp/rc bash -c "gh zz"` sources an unread file   |
| `PATH`, `LD_*`, `DYLD_*` or other command-lookup state set to a value the guard cannot read, a write to zsh's `path` or a command, function or alias table, or `hash` given an unread word, on a line that may reach git (below)                                                                                                          | `LD_PRELOAD="$X" git push` loads an unread library          |
| `git -c` or `--config-env` on `safe.directory` or `init.templateDir`, a `git config` write or section rename to either, `git init` or `clone --template=<dir>` (any prefix), or `git --exec-path=<dir>` (below)                                                                                                                           | `git init --template=/t r` copies an unread hook or alias   |

For a worker, any agent whose `AGENT_CHAT_ROLE` is not `coordinator` (CC-1094), the guard also
denies any mention of `.agent-chat/profiles`, `.agent-chat/config.json`, `.agent-chat/hooks.json`
or `.agent-chat/burndown.config.json`, and of the same names under a relocated `AGENT_CHAT_HOME`.
An edit tool writing to any of them is denied the same way. Rewriting a profile would let a worker
drop its own denies. The launch plan sets `AGENT_CHAT_ROLE` from the profile's role; the
`AGENT_CHAT_` prefix keeps a profile's `env` from setting it, and a plan without it counts as a
worker. This is a speed bump like the rest: `cd ~/.agent-chat && cat > profiles/x.json` names
neither fragment. Worker reads such as `cat ~/.agent-chat/profiles/x.json` are denied too; use
`agent_profiles` instead.

A `(` in argument position, after the command name (CC-728), is read two ways, and a line is denied
if either reading is. As a zsh glob group, its balanced span (nesting, quotes, `$'...'` and escapes
honoured) is one non-literal word, so the git option rules deny it before the subcommand and, after
it, deny an option-shaped alternative such as `(a|--no-verify)`, `(a|[-]-no-verify)` or a bracket
class such as `[-]-no-verify`. As a subshell, the span's own commands are parsed, and so are the words
after it as a command line of their own, with the same two readings again, so a word the splitter does
not know, like `coproc`, `repeat 1`, `for i` or `foreach`, cannot hide a git inside or behind the
group. The readings are bounded (64 forks a line); past that the line is treated as unsettled.
As a backstop, a span the splitter cannot settle (a group holding a quote, escape, blank, `$` or
operator, one with no close, or too many groups) denies the line when a command after it, on the
parsed words, is or may be `git` or `gh`; put such a command on a line of its own. Plain groups such
as `(ok)` and `*(.)`, `for ((i=0;i<3;i++))`, a `(` at command position, a case pattern, a `[[ ]]`
operand, `name()`, `x=(` and a comment are not unsettled. The splitter has no bash mode: bash reports
a syntax error for most of these lines and runs nothing.

A case pattern's `)` must not end a `$( )`, `<( )`, backticks or a subshell early (CC-1324), or a
command after the case reads as part of a string. Inside such a span the splitter reads only the
case grammar bash and zsh share: `case WORD in` as one command, patterns with `|` and an optional
`(`, the terminators `;;`, `;&` and `;;&`, and `esac`. Any other case form there makes the line
unreadable, so it is denied, whatever it runs:

- T1: zsh's `;|` terminator, in a case or not.
- T2: a reserved `case` whose subject is not followed by an unquoted `in` in the same command, as in
  zsh's `case w {`, `case w;in` and `case w;{`, and a newline before the `in`, which bash takes too.
- T3: any unquoted `{` or `}` while a case opened in the span is open, at any place in a word, so a
  `{ }` group or brace expansion in a case body. zsh reserves a `}` that ends a word (`echo a}`)
  and closes a case at it, so only `esac` closes one.
- T4: a `case` the splitter reads as an argument, as after zsh's `repeat 1` or in `() {`, whose
  subject is followed by `in` or a word starting with `{`, past comments, joined lines and separators.
- T5: a `(` in a pattern other than its optional leading one, as in zsh's glob groups `(x|(y)))` and
  `x|(y))`. After a pattern that began with `(`, zsh reads on past its `)` in forms such as `(x)y)`,
  `(x) |y)` and `(x) )`, so that `)` must be followed, with line joins removed, by a newline, `;` or
  the end, or by blanks and then one of those, a comment or a command word. Anything else, a
  redirection included, is unreadable (CC-1609).

A case at the top level, outside any such span, is read as before: there a pattern's `)` ends nothing.
These rules hold for a case inside backticks, `$(( ))` and `$[ ]`, and in `select`, `repeat` and zsh's
short `for`, `foreach`, `while` and `until` bodies (CC-1610).

Inside such a span, an argument-position `(` group that is not plain makes the line unreadable
(CC-1610). That covers a group with no close on its line, one holding any unquoted `#`, or one holding a
quote, escape, blank, `$`, backtick or operator. zsh parses the group or short loop's list itself. It
reads past a line (`for v (a` and a newline, then `)`), past a comment (`(a;# )`), and past a nested
case pattern's `)` (`(a $(case x in x) …;; esac) b)`). So the `)` the splitter would take for the
span's end may be the group's. Plain groups such as `*(.N)` are still read. One-line lists such as
`for v (a b)` are refused there too; that is an accepted cost.

A brace expansion after any git subcommand is read like such a glob group (CC-1427, CC-1434), since
the guard denies options of `fetch`, `pull`, `difftool` and `init` as well as `push`, as in
`git fetch --upload-pac{k..k}=<cmd>` or `git init --templat{e..e}=<dir>`: a comma list or a
sequence (`{x..y}`, `{x..y..step}`) that may yield an option, as in `--no-verif{y..y}`, `--no-verif{y,}` or `{main,--no-verify}`, is denied. So is a group that
may expand to nothing before a `-`, as in `{,}--no-verify`, and a zsh character sequence such as
`{+../}` whose range holds `-`. The splitter marks only an unquoted `{`, `,` or `}` as the group's
structure, so a quoted or escaped one is text, as the shell reads it: `{,x"}"}--no-verify` closes
after the quoted `}`. The `}` of an empty `{}` stays unmarked for find, xargs and parallel, so a `{`
before a quoted `}`, as in `{"}",}`, is read both ways and denies if either may. git's count `-<n>`, as in `-{1..3}`, stays allowed, and a brace that yields
no option, such as `HEAD:mai{n..n}`, is checked as the push it is.

zsh's `BRACE_CCL` expands any `{chars}` into its characters, so under `zsh -o braceccl`,
`--braceccl` or `setopt braceccl`, `{-}-no-verify` and `--no-verif{y}` are `--no-verify`. Rather
than read every brace grammar, the guard decides whether a word may become an option at its first
character (CC-1432). A `git push` argument led by an unquoted `{`, other than a lone `{}`, is
denied, and so is one led by `-` that holds an unquoted `{`, git's count such as `-{1..3}` aside.
`feat/{a,b}-x` and gh's `{owner}/{repo}` stay allowed, while a refspec led by a group, such as
`{a,b}-x`, is denied; write it out.

Off `push`, where braces in paths are common, only the run of groups that leads a word can make
it start with `-`; the text after the run is copied after every alternative. A word led by `{`
denies when an alternative in that run starts with `-`, as in `{a,-}-upload-pack=x`, or when a
group with no `,` holds a `-`, which braceccl reads as a class, as in `{-}-upload-pack=x`. braceccl
does not nest, so such a group is read over its whole text, inner braces included: `{+-{b}}` holds
the range `+-{`, which takes in `-`. A group that never closes denies on any `-`. So `git add {src,test}/foo-bar.ts`, `git rm {a,b}-old.txt`
and `git show {HEAD,main}:a-b.txt` stay allowed. A word led by `-` denies when a `{` is in its
option name, before any `=`. A brace after a long option's `=` only copies the option, so
`git log --grep={fix,feat}` and `git diff --color={always,never}` stay allowed, while
`git fetch --{upload-pack=x,y}` is denied. A short option word with a brace, such as
`git log -S{foo}`, is denied.

A glob may match a file named `--no-verify`, so the guard does not read `?` or `*` as written in a
`git push` argument either (TP-4235). An unquoted glob or brace word before a literal `--` that may
match `--no-verify` or its abbreviations is denied, whatever the directory holds: `--no-verif?`,
`--no-verif*`, `--*-verify`, `-*` and a bare `*`. A command word tied to git whose brace or zsh
group may expand to `push` or `--no-verify`, as in `{git,push,--no-verify}`, is denied too. Both
hold at the top level, under `sh -c` and in the scripts git hands a shell, such as
`git rebase -x 'git push --no-verif*'`. A quoted glob, as in `"--no-verif?"`, and a glob that cannot
match the whole flag, such as `feat/*`, `main:rel-*` or `--no-verif"y"?`, stay allowed. git reads a
`--` after `-o`, `--push-option`, `--repo`, `--receive-pack` or `--exec` as that option's value and
keeps reading options, so that `--` ends nothing: `git push -o -- --no-verif?` and
`git push -o -- --no-verify` are denied. A word the guard cannot read, or a glob that may form such
an option (`-?`), is read as taking the next word too, while `git push -o x -- --no-verif?` stays allowed.
zsh's `EXTENDED_GLOB` operators count as glob marks in these words too, since the same line may run
`setopt extendedglob` or `zsh -o extendedglob -c`: `--no-veri#fy` and `--no-verif~x` are denied, and
so is `^x`, which matches every file but `x`. The splitter cannot tell a quoted `#`, `^` or `~` from
an unquoted one, so either counts; a word they cannot turn into the flag, such as `fix#12`,
`main~1` or `HEAD^:main`, stays allowed.

Two inputs deny before any of this reading (CC-1427): a raw NUL anywhere in the line, which the
splitter uses as its own mark while zsh ends the word there, so `--no-veri<NUL>x` runs as
`--no-veri`; and the private-use characters U+E000 to U+E002 in a git argument that holds a brace
expansion, since the brace reader uses them to mark a group's structure.

bash 5.3 runs a funsub, `${ cmd;}` (`${` followed by a blank, tab or newline) or `${|cmd;}`, as
commands in the current shell, so `echo ${ git push --no-verify;}` pushes (CC-1327). The splitter
reads a funsub's body as commands, quoted or unquoted, in an assignment, inside `$(...)` and in a
`bash -c` or `zsh -c` script, and checks them like the commands of `$(...)`. It closes the body
where bash does, at a `}` in command position, counting nested `{ ... }` groups. Because the commands
run in the current shell, a `cd` or export inside one makes the shell's directory and environment
unsure after it. A funsub with no close, or one holding a bare `}` argument such as
`${ echo }; ...; }`, where zsh would close and bash does not, denies the line as unreadable.
`echo ${ date;}` and `echo "${|REPLY=x;}"` stay allowed.

The splitter ends any other unquoted or double-quoted `${...}` at its first `}` (CC-718). So in
`echo ${X:-'${Y}'}; g''h pr create ...` it opens a quote that it never closes, and that quote hides the
command after it however it is spelt. zsh's `(e)` flag runs the text it expands, which can define a
function that posts. Any line is denied when such an expansion holds a quote, a backslash, a nested
`$` (as in `${X:-$HOME}` or `${X:-$(cmd)}`) or a zsh flag group. It is also denied when the
expansion holds a nested `{` and zsh, which counts nested braces, finds the close past a blank, a
quote or an operator, as in `${X:-{} #}`, or finds no close at all. `${X:-python{3,}}` keeps one
word under either close and is not affected. A line that names `gh` (which
includes `agent-chat gh-write`) is also denied for any other `${...}` that is not `${NAME}` or
`${1}`: one with an operator such as `:-`, `#`, `%`, `/`, `^` or `,`, or with a leading `#` or `!`.
`$x`, `${HOME}` and `${10}` stay allowed everywhere. Inside single quotes, as in `-b '${X:-y}'`, the
expansion is plain text and allowed. To get past the rule, compute the value in an earlier Bash call,
or write it out.

A git alias that was already in config is expanded before the table is applied (TP-595). For
`git <word>`, where `<word>` is not a git builtin, the guard runs `git config --get alias.<word>`
in the directory the command runs in, after `cd` and `-C`, with a 1 s timeout. The lookup gets
the command's own `-c` and `--config-env` options, `--git-dir` and `--work-tree`, and the
variables that choose config files (`GIT_DIR`, `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_*` and
others) as the command sets them, by prefix assignment, `env`, or an earlier `export`, bare
assignment or `unset`. When the command line changes one of those variables in a way the guard
cannot follow, such as `read`, a value from `$(...)`, an `export` behind `&&`, or an `export` of
a name built at run time, a lookup is denied. So is one where the guard cannot tell the directory
(after `source`, `set -a`, `trap`, `pushd` or a `cd` it cannot follow), a `-C` value, or the
subcommand word itself; a builtin such as `git push` is still allowed there. A plain value is
re-checked as `git <value> <rest>`, so an alias that sets `-c core.hooksPath` is denied too. A
`!` value is re-checked as a shell command, run from the top of the work tree, with its
arguments put in for `$1` to `$9`, `$@` and `$*` and appended as git appends them. More than 4
nested aliases is a deny. A failed lookup allows the call, as a plain push is allowed.

A prefix assignment is `NAME=value`, `NAME+=value`, `NAME[idx]=value` or `NAME[idx]+=value`: the
shell reads the word after it as the command, so the guard skips all four forms wherever it looks
for the command word, behind `env`, `command`, `nice` and the like, and in the `gh api` host and
`git` config reads. An append or a subscripted assignment has a value the guard cannot know, so
a config variable set that way counts as unreadable. A word that opens a subscript and never
closes it (`A[a b]=1 git push`) is denied, since the guard cannot tell where the command starts.

Every command that is or may be git reaches this check at one place, after the wrappers above
are stripped and inside every `sh -c` string, `eval`, `env -S`, `$(...)` and `!` alias body:

- a literal `git` command word, including `/usr/bin/git` and quoted forms such as `"git"`;
- a command word the guard cannot resolve, such as `$x pnv` or `${X:-git} pnv`, whose next
  words are looked up as if the word were git;
- the words a plain alias expands to.

A lookup the guard cannot make, because it cannot tell the directory, the subcommand or the
config env, is a deny for a literal `git`. For a command word it cannot resolve, it is a deny
when the line ties that word to git (TP-613): the word names `git` (`${X:-git}`), holds a command
substitution (`$(echo tig|rev)`), or reads a variable that the line mentions outside a `$`
reference (`x=...`, `read x`, `for x in`) or that the hook's own env holds as a value naming
`git`. A word that reads a variable the shell sets without the line naming it is always tied:
`$1` to `$9`, `${N}`, `$*`, `$@`, `$_`, `$REPLY`, bash's `$MAPFILE`, and zsh's `$argv` and
`$reply`, as in `set -- git; source /dev/null; $1 pnv` or `read <<< git; pushd .; $REPLY pnv`. So
is a word that hides the name it reads: any `${` not followed by a name, such as `${!y}`, `${#x}`
or a zsh flag (`${(P)y}`, `${=x}`, `${~x}`, `${^x}`), and zsh's bare `$=x`, `$~x` and `$^x`. None
of them is a routine command word. That includes `"$1"` after `source`, which a script wrapper
may run as its command; the guard accepts that over-deny, since `set -- git` can feed it. A
default such as `${PYTHON:-python3}` reads `PYTHON` without assigning it, so it is treated like
`$PYTHON`; `${PYTHON:=python3}` assigns and ties. The guard tests for `git` after removing quotes
and backslashes, so a default or replacement word that becomes `git` ties: `${x:-g"i"t}`,
`${x:-g\it}`, `${x/#/g"i"t}` and `${x/a/g"i"t}`. A word ties, too, when a glob, a brace
expansion, zsh alternation, an ANSI-C string or an unset variable spliced into it may turn a
path segment into `git` (TP-721): `/usr/bin/gi?`, `gi[t]`, `gi[]t]`, `gi[!]x]`,
`${x:-/usr/bin/g?t}`, `g{i,}t`, `g{h..j}t`, `g(i|x)t`, `${x:-$'g\x69t'}`, `${x:-gi}t` and
`${x:-g${z}it}`. The guard expands brace alternatives, ranges and `(a|b)` groups, decodes the
ANSI-C string, drops each `$NAME` and `${NAME}` as if unset, reads a `${x:-...}` default as joined
to the text around it, and matches each segment as a glob against `git`. The splitter keeps
`g(i|x)t` and `*.ts(.)` as one word rather than a subshell only when the group is plain: no
quote, backslash, blank, `$`, backtick, `;`, `&`, `<`, `>` or nested paren inside, and no `{`
before it. Any other group keeps the subshell reading, so a quoted paren cannot hide a command,
as in `echo x(a|'(') ; git push --no-verify ; echo ')'`. A `(...)` group may also be glob qualifiers, which zsh drops, so the guard reads every group as
its alternatives or as nothing, wherever it sits: `g(i|x)t(N)` and `${x:-/usr/bin/g(i)t(.)}`
tie. A word over 1024 characters, or one that expands
past 256 words or 4096 steps, ties without being checked, so it fails closed and fast. A word that
cannot become `git` stays allowed: `./scripts/*.sh`, `~/bin/*-tool`, `${PYTHON:-python{3,}}`. A
bare `*` can, if the directory holds a file named `git`, so it ties. A top-level `$'\x67it'` needs none of this: the splitter decodes it to a
literal `git`. So `x=$(echo tig|rev); source /dev/null; $x pnv` is denied, and so is the same line with
`pushd .` or `cd "$D"` in place of `source`. A command word from the environment the line does
not touch is allowed, whatever else the line runs: `source .venv/bin/activate && $PYTHON -m
pytest && git status`, `source x; $PAGER README; git log`, and `[ -n "$T" ] && git -C "$T" status`
(an unquoted `[` is a glob character, so the guard reads it as an expansion). Whether the line
names `git` elsewhere does not matter: it says nothing about what the expansion holds, and denying
on it blocked routine lines.

Such an untied word still has its subcommand looked up where the guard can look: the directory
the line is known to be in, or else the hook's own, with the hook's env (CC-1315). An alias found
there is checked like any other, so `env -C /x $X p`, `sudo $X p`, `cd "$D" && $X p` and
`GIT_DIR=$G $X p` deny what `$X p` denies. A git option value the guard cannot read, as in
`$X -C "$D" p`, `$X --git-dir=$G p` or `$X -c "$C" p`, is itself a hidden word, so the hidden-suffix
scan checks it as a command word and these deny too. This is a best guess: an alias that only the unknown
directory's repo config defines, or that only root's config defines under `sudo`, stays unseen.

The accepted gap is a command word set where the guard cannot see, such as a variable that a
sourced file or the Bash tool's shell set, after a `source`, `pushd` or `cd` the guard cannot
follow: `source ./env.sh; $x pnv` runs an alias unchecked when `env.sh` sets `x=git`. Denying it
would deny `$PYTHON -m pytest` and `$PAGER README` too, since the command string cannot tell
them apart, and a sourced file can run `git push --no-verify` itself anyway. A word that git
would not take as an alias name, one that starts with anything but a letter or holds anything
but letters, digits and `-`, is never looked up. `echo pnv | xargs git` is denied: the
subcommand comes from stdin, so the guard reads it as a word it cannot resolve (below).

The guard reads every expanded command word as a shell (CC-1411, CC-1428): its `-c` string and
the text it is fed are checked as a script, and a feed it cannot read denies on a line that may
reach git or gh. The word may be any shell, so its options are read as an unknown shell's and
every word may be its script: zsh, for one, takes `-O` as a plain flag where bash takes an
operand. So `b=bash; $b -c '<push>'`, `X=bash; nice $X -c -- '<push>'`, `b=zsh; $b -c -O '<push>'
x`, `${SHELL:-bash} -c '<push>'`, `b=bash; $b$@ -c '<push>'` and `echo '<push>' | $(echo bash)`
deny, and so does `$X '<push>'`, since `$X` may be `eval`. `X=bash; $X -c 'echo hi'` and
`x=git; $x status` stay allowed. Nothing in the word's text exempts it; only where the word came
from does. The words xargs places for its input are left to the xargs rules, the name of a
`name()` definition defines and runs nothing, and the path a `<(…)` leaves runs nothing, so
`diff <(git show a) <(git show b)` stays allowed. Each is a field the parser or the xargs reader
sets, so a missing one can only deny more. One false deny is accepted: `git diff | $PAGER` denies, since `$PAGER`
may be a shell fed by the pipe, and quoting it does not help. Write the pager out instead.

A config file that the command itself includes with `-c` or `--config-env` on `include.path` or
`includeIf.<cond>.path` is read the same way (TP-602). The guard runs `git <its options> config
--show-scope --includes --get-regexp '^core\.hookspath$'` where the command runs, after `-C`,
with the same 1 s timeout and without the agent's `GIT_CONFIG_*` variables, and denies when a
command-scope value comes back. git follows nested includes up to its own depth cap of 10. Unlike
the alias lookup, the include check fails closed. It denies when:

- the read times out, as a FIFO or a very large include does, or git fails, as it does on a
  circular include, a relative command-line include path or a file that is not config;
- an absolute or `~/` include file does not exist when the hook runs, since git skips a missing
  include and the file may be written before git reads it;
- the git command is not the only simple command on the command line the agent sent. Any `;`,
  `&&`, `||`, `|`, `&`, newline, `$(...)` or backticks, heredoc or here-string, or
  redirect other than a descriptor copy (`2>&1`, `2>&-`) is a deny, and so is an include inside
  `sh -c`, `eval` or a `!` alias. Any other command on the line could write the include file, or a
  file it includes, before git reads it, and no list of writing commands is complete: `python3 -c`,
  `node -e`, `curl -o`, `tar -x` and `unzip -o` all can. The cost is that ordinary lines are denied
  too: `cd <dir> && git -c include.path=<f> push`, `git -c include.path=<f> push 2>&1 | tail -3`
  and `git -c include.path=<f> push > log.txt`. Run the git command on its own, and use `-C` for
  the directory;
- the subcommand is a `!` alias. git passes the include to every git the alias body runs, and the
  body may write the file first, so the body is never read;
- a word before the subcommand mentions `include` and the guard cannot tell the directory, an
  option or a `--config-env` variable.

An include of a file that sets only an alias is left to the alias lookup above. A nested include
file written by another process between the hook and git is not caught.

A line that writes git config and runs a git word that may be an alias is denied (TP-607), since
the lookup reads config before the line changes it: `git config alias.x '!git push --no-ve""rify'
&& git x` would run an alias the guard never saw. The line writes config when it names a git
config file anywhere (`.git/config`, `.git/worktrees/<n>/config`, `.gitconfig`, `git/config`,
`.git/config.worktree`), or runs `config` on an `alias.*`, `include.*` or `includeIf.*` key, joined to
the alias by `&&`, `;`, `||`, a newline or inside `sh -c`. The rule reads the whole line, so it
also denies a read such as `git config --get alias.x; git x` or `cat .git/config; git x`, and an
alias used before the write. A builtin such as `git config user.name x && git push` still passes.
Split the write and the alias into two Bash calls.

Every `git <word>` that is not a builtin costs one `git config` spawn, and a `!` alias costs a
second one for the work-tree top. The guard does not skip network verbs, and each git command
in a `!` body is looked up again.

The splitter looks inside `$(...)`, backticks, `sh -c`/`bash -c` strings, `eval`, `env -S` and a
heredoc fed to a shell. It reads a backtick body as the shell does, skipping each backslash pair to
find the closing backtick and dropping the backslash before `$`, a backtick and `\`, so a nested
`` \`...\` `` substitution is seen (CC-1350). `agent-chat gh-write -- <gh args>` is checked like `gh`. A gh called by
path, such as `/opt/homebrew/bin/gh` or a `$GH` that expands to one, is denied outright: it skips the
agent's gh shim, and gh-write is the only write path (CC-456). `git push -n` is
`--dry-run`, which pushes nothing, so it is allowed. `git commit --no-verify` is allowed too:
it skips only the repository's own commit hooks, and the push is still scanned.

`env` splits an `-S` or `--split-string` value by its own rules, which differ from the shell's: a
backslash escapes, and it splits on more blanks than space and tab. So a split value that holds a
backslash or any whitespace other than space and tab is denied, as is one with an expansion. The
guard finds `-S` alone, as `--split-string` or `--split-string=`, and at the end of a short-option
cluster such as `-vS` (any `-[a-zA-Z]*S`), where the rest of the word or the next word is the value.
env splits only on blanks and quotes, so a `;`, `&`, `|`, `<`, `>`, `(` or `)` in the value is part
of a word, not a command break: `env -S 'find . -exec true ; -exec git push --no-verify ;'` is read
as one find with two clauses, and its second clause denies (CC-1307).

The PR pre-check runs egress-scan's rules on each line of the title, the body, a `--body-file`
or a heredoc passed as `--body-file -`. `gh pr merge` is checked like `create`: its `--subject`,
`--body` and `--body-file`. It reads the private term list from the default path only, never from
`TITAN_EGRESS_TERMS`, like the pre-push hook. A deny names `title line 1 private-term #3` or
`body line 4 home-path` and never the matched text. It also denies when it cannot check: a body
piped from another command, or a missing or unreadable term list while `MISSING_TERMS_REFUSES` is
set. An empty term list file counts as a list: the guard then checks the generic rules only and
refuses nothing for a missing list.

### Words xargs adds (CC-1117)

`xargs [options] git|gh <words>` runs that command with more words the guard cannot read: the
ones it reads from stdin or `-a file`, appended after `<words>`, or, in replace mode (`-I R`,
`-i[R]`, `--replace[=R]`, BSD `-J R`), put in place of each copy of the replace string. The guard
strips `xargs` and its options like a wrapper and checks the command as if those words were an
unquoted `"$@"`, so the rules above for a word the guard cannot read apply:

- `git config` and `git remote add` or `set-url` deny, whatever the key:
  `echo always | xargs git config protocol.ext.allow`, `echo core.hooksPath /x | xargs git config`,
  `xargs git remote add o < urls`. So does `xargs git config --get`, a known false deny.
- `git` or `gh` with no subcommand denies, since stdin names it and it may be an alias:
  `echo config protocol.allow always | xargs git`, `echo pv | xargs gh`.
- `git push` denies with its own reason, since stdin may hold `--no-verify`, unless a literal `--`
  comes before the words xargs adds, with only value-less push flags before it:
  `xargs git push origin --` and `xargs -I{} git push origin -- {}` pass, while `xargs git push`,
  `xargs -I{} git push {}` and `xargs git push -o --` (where `--` may be the `-o` value) deny.
- A git alias keeps the marks of the words around it, so `xargs git cfg` and `xargs git p` deny
  when `cfg = config` and `p = push`, and a `!` alias that takes the words denies.

GNU xargs drops a replace string on a later `-n`, `-L` or `-l` and appends instead; the guard does
not track the order, so a batch option beside `-I` counts as appending too. An xargs option or
replace string the guard cannot read (an expansion such as `"$X"`, which may be `-I--`) counts as
filling every word and appending. An unknown long option denies. An xargs whose command word, or a
wrapper option such as `env -u` or `nice -n`, comes from its input denies (`xargs nice`,
`xargs -I% %`, `xargs -I% env -u% git push origin --`). In a `sh -c` script under xargs, only
two spellings of the words xargs adds are read: the replace string, swapped in place, so
`xargs -I{} sh -c 'git push origin {} --no-verify'` denies, and `"$@"`, so
`xargs sh -c 'git push origin "$@"' _` denies as a fed push. A script that reads them through
`$0` to `$9` or `$*` is not checked (CC-1201; see "Not covered" below). Reads such as `xargs git log`, `ls | xargs git add`, `xargs git status` and
`xargs gh pr view` stay allowed.

### gh-write scans when it runs (CC-501 S1)

`agent-chat gh-write -- <gh args>` runs the same check on its real argument list before gh starts,
so a post is scanned even when the PreToolUse hook failed open or was never in the path. It reuses
the guard's `ghKind`, `prSources`, `apiSources`, `isMerge` and `findingsIn`, so it reads the same
text: the title (`--title`, `-t`, `--subject`), the body (`--body`, `-b`), a body file
(`--body-file`, `-F` on `pr` and `issue`), and on `gh api` each `-f`/`--raw-field`, `-F`/`--field`,
`-F key=@file` and `--input`. A body file is read as a regular file. `--body-file -`, `--input -`
and `-F key=@-` read stdin once, so a quoted heredoc works:

```sh
agent-chat gh-write -- pr comment 12 --body-file - <<'EOF'
...
EOF
```

gh never reads the original path or stdin. Each file source is replaced by a 0600 copy of the
scanned text in a fresh `mkdtemp` directory. The directory is removed after the last retry, and also
when SIGTERM, SIGINT, SIGHUP or SIGQUIT ends gh-write. The swapped arguments are then scanned again with only
those copies readable, so a file changed after the scan, or a flag spelling the swap missed, cannot
reach gh unscanned.

gh parses flags anywhere, so `pr --body x comment 1` is `pr comment`, and it drops empty words,
so `pr '' comment` is too. gh-write therefore requires the group and verb first: every word up to
the verb must be one of gh's own groups, a known `pr` or `issue` verb, or an `-R`/`--repo` pair.
Any other flag there, an empty or blank word, a config alias such as `co`, or an extension
refuses. `pr create` and `issue create` refuse `--fill` (any spelling, and `-f`),
`--template`/`-T` and `--recover`, since gh would then post text read from commits, a template or a
recovery file that gh-write never sees.

It refuses with exit 1, without starting gh, on a finding (the guard's message: locations and rule
ids, never the matched text), on a body file it cannot read as a regular file, on stdin asked for
twice, on an unreadable term list, and on a missing term list unless the call is a plain merge. A
plain merge is `gh api` with exactly one endpoint word, `.../pulls/<n>/merge`, and no flag other than
`-X`/`--method`, `-H`/`--header`, `-q`/`--jq` and `--input`. This is stricter than the hook, which
also exempts a merge with `-f` fields.

Any other command (`pr close`, `release create`, `workflow run` and the like) that carries a text
flag in any spelling refuses, since gh-write does not read its text: `--body`, `-b`, `--body-file`,
`-F`, `--field`, `-f`, `--raw-field`, `--input`, `--title`, `-t`, `--subject`, `--notes`,
`--notes-file`, `--comment`, `-c`, `--message`, `-m`, and their `=` forms or short clusters. Reads
without those flags, such as `pr view`, `pr checks`, `pr list` and `api` GETs, run as before.
`pr view -c` is refused too; run reads with plain gh.
It reads the list from the passwd home's `~/.config/titan-egress/private-terms`, like the pre-push
hook. It does not read `HOME`, `XDG_CONFIG_HOME` or `TITAN_EGRESS_TERMS`. No variable or flag turns
the scan off. With the hook in place, a post is scanned twice.

### The gh shim refuses writes not from gh-write (CC-1644)

The `gh` shim on a spawned agent's PATH runs a command only when it is a known read, or carries
the ticket gh-write mints after its scan passes. Anything else exits 1 with stderr
`gh-shim: refused (write)` and a pointer to `agent-chat gh-write -- <args>`, and never starts the
real gh. The shim reads gh's argv after the shell expanded it, so a hidden head (`f() { "$@"; }; f gh …`,
`set -- gh …; "$@"`, `b=gh; $b …`) is refused like a plain write.

The known reads, each matched at an exact position with no flag before it:

- one of gh's own groups followed by `view`, `list`, `status`, `checks`, `diff` or `watch`;
- `search …`, `auth status`, `auth token`, `auth git-credential` (git's credential helper);
- `run download`, `release download`;
- `gh api` that the guard's strict GET classifier accepts: one REST endpoint, no URL, no `graphql`,
  only `--paginate`, `--slurp`, `--silent`, `-i`, `--verbose`, `--jq`, `--template`, `-H`,
  `--hostname`, `--cache` and `--preview`, so no method, field or input flag;
- `version`, `--version`, `help …`, and a `--help` or `-h` as the last of at most three words.

Everything else needs a ticket, including `gh -R o/r pr view`, `gh pr ls`, `gh api -X GET … -f …`
and `gh api graphql` reads. Send those through gh-write, which scans `-f`/`-F` fields:
`agent-chat gh-write -- api graphql -f query=…`.

The ticket is an HMAC, keyed by a per-launch key that run-agent writes under the protected hooks
root, over the agent id, a 60 s expiry, a nonce and the exact argv gh-write hands gh. That argv names
gh-write's 0600 copy paths, so a ticket cannot carry other text or another command. The shim script
bakes the key root on its exec line, so `AGENT_CHAT_GH_KEY_ROOT` set in the environment is ignored.
The shim takes the ticket out of the environment before the real gh starts, so neither gh nor what
it runs sees it. `AGENT_CHAT_GH_SHIM_OFF=1` turns off the REST answers, never this check. A refusal
appends one line to `leak-guard.log` naming the group and verb, or the api method and route
template, then `caller=<AGENT_CHAT_NAME>` and, where `/proc` has it, `parent=` and the basenames
of the calling process's first two argv words; free-text words log as `?`. With its build gone,
the shim script runs a smaller read list as a POSIX `case` and refuses every `gh api` call and
every write.

**Staged rollout.** The gate enforces: `GATE_MODE` in `src/gh-shim/write-gate.ts` is
`'enforce'`, so it refuses as described above. It shipped in `'log'` mode first, where a call it
would refuse still ran and the line read `gh-shim: would-refuse (write)`; a 48-hour census of those
lines named the callers that had to move to gh-write before the switch. The mode is a source
constant and no environment variable or file changes it. The build-gone fallback refuses in both
modes.

Limit: the key is readable by the agent's uid. An agent that reads it by a spelling the
`protectedPaths` substring check misses, or that imports agent-chat's own mint function under
`node -e`, can forge a ticket. This closes writes that skip the scan; it does not stop an agent set
on forging one. gh run by absolute path, or after a PATH reset, skips the shim; that residual is
the `ghByPath` rule's.

### A command git runs for its subcommand (TP-634)

Some git subcommands run a command line they are given. The guard checks that command like a
top-level Bash line, so `git rebase -x "git push --no-verify" HEAD~1` is denied as a skipped hook.
It reads the command from:

- `git rebase -x <cmd>`, `--exec <cmd>`, `--exec=<cmd>`, a short cluster such as `-ix <cmd>`, and
  any prefix of `--exec`, since git takes an unambiguous prefix;
- `git submodule [--quiet] foreach [--recursive] <cmd>` and `git bisect run <cmd>`. One word is
  read as a shell string; several are quoted and joined, as git runs them;
- `git difftool -x` or `--extcmd`, `git filter-branch --setup` and every `--*-filter`, and
  `git grep -O<pager>` or `--open-files-in-pager=<pager>`;
- the program options git runs through a shell: `--upload-pack` on `fetch`, `pull`, `clone` (also
  `-u`) and `ls-remote` (also `-u`), `--receive-pack` and `--exec` on `push`, `--exec` on
  `archive`, and `--to-cmd`, `--cc-cmd`, `--header-cmd` and `--sendmail-cmd` on `send-email`.

A git alias that expands to one of these is checked the same way. The command runs in another
directory, and for `submodule foreach` in each submodule with variables git sets. Any `$`
expansion or backquote in the command is a deny, `$sha1` and the other variables foreach sets
included: their values come from `.gitmodules`, commit data or the script itself, which the guard
cannot see. git passes its `-c` and `--config-env`
options on to every git the command runs, and the command may write an include file before git
reads it. So an `include.path` or `includeIf.<cond>.path` on the outer git is a deny, whatever the
file holds, and so is a `-c` or `--config-env` word the guard cannot read. A command word the guard
cannot read, such as `-x "$(cat s)"`, is a deny for a literal `git` or an expansion tied to git.
`git rebase -i`, `git submodule update` and `git bisect start`, `good` and `bad` run no command and
are not affected.

In a shell git starts (`submodule foreach`, `rebase -x`, `bisect run`, `!` aliases, pagers and
editors), git puts its exec-path first on PATH. The launcher points that exec-path at a mirror of
git-core whose `git` and dashed builtins are the push shim. So any `git` such a shell finds by name
is the shim, whatever script, alias, startup file, argv0 or arithmetic expansion led to it. The
shim restores GIT_EXEC_PATH on every run and refuses `--exec-path=<dir>`. The guard's static rules
for that shell are main's: `$` or backquote text, startup variables, and a visible
`push --no-verify`. Not closed, the same as at top level: a git run by path (`/usr/bin/git`,
`hash -p /usr/bin/git p`, `exec -a git-push /usr/bin/git`) or after a PATH reset. Closing that
needs enforcement that `--no-verify` cannot skip.

The mirror (TP-4249) is `<home>/git-bin/core`, a link to a `core-<key>` dir beside the shim. At
each spawn the shim writer reads the real `git --exec-path` and `--list-cmds=builtins` with
GIT_EXEC_PATH unset, so a nested launch never mirrors a mirror. In the mirror, `git` and
`git-<name>` for every builtin link to the shim, and every other entry, such as `git-sh-setup`,
`git-remote-https` and `mergetools`, links to the real one. The key covers `git --version`, the
core path, the builtin list and the core listing, so an upgrade gets a new dir on the next spawn.
The shim maps a `git-<name>` it is run as to `git <name>`. Its own exec-path, for the
`git-<word>` lookup, stays the real core. A git a shim-run git starts for itself
(`pack-objects`, `upload-pack`, `receive-pack`) also passes through the shim, which costs about
3 ms a call on Linux. A launch with no mirror, because git or its core could not be read, sets no
GIT_EXEC_PATH. Linux only so far: on macOS (Apple's xcrun `git`, Homebrew's `libexec`) the
mirror is UNVERIFIED. `src/__tests__/leak-git-mirror.test.ts` runs each row against real git, once
with no shim, where it lands a ref, and once through the mirror, where it is refused.

Config values that name a program are read in their own section below (TP-636). git's own hooks,
and an option whose name is an expansion, as in `git rebase "$OPT" "<cmd>"` with `OPT` set on the
line, are not read.

### A config value git runs as a program (TP-636)

Some config keys hold a program or shell command that git runs: `core.pager`, every
`pager.<cmd>`, `core.editor`, `core.sshCommand`, `credential.helper`, `tar.<format>.command`,
`hook.<name>.command` and many more in `git help config`. The guard fails closed (TP-636 fix round
9): it keeps a list of keys git never runs, and treats every other key as one whose value git may
run. Whole sections are inert only when none of their keys runs anything, such as `user`, `color`,
`log`, `branch`, `push`, `fetch`, `http` and `safe`; elsewhere single keys are, such as
`protocol.version`, `core.quotePath`, `init.defaultBranch`, `help.autocorrect`, `remote.<name>.url` and `.fetch`, and
`url.<base>.insteadOf`. `include.path` and `core.hooksPath` are read by their own checks. A key the
list lacks, such as one git adds later, is checked rather than allowed; matching is
case-insensitive on section and key, as in git.

Every config word one git invocation receives is read from one list: git's own `-c` and
`--config-env` before the subcommand, and the config words of `git clone`, which git applies to
the new repository before it fetches or checks out, so a program they set runs in the same call.
clone's words are read by git's parse-options rules, with the same reader as the TP-634 script
options: `-c <v>`, a short cluster ending in `c` (`-qc <v>`, `-qc<v>`), and any prefix of
`--config` (`--conf <v>`, `--conf=<v>`). The program-key check, the unreadable-config check and
the `ext::` check below all read that list. A word after `clone` that may hide a config option but
cannot be read exactly denies as unreadable config: one the shell may split, such as an unquoted
`$OPTS`, or an option whose name the shell expands, such as `-q"$F"`.

A literal value for one of these keys is checked like a top-level Bash line, so
`git -c core.pager="git -c core.hooksPath=/dev/null push" log` is denied as a hooks path override
and `git -c core.pager="git push --no-verify" log` and
`git clone -c core.sshCommand="git push --no-verify" ssh://h/r x` as a skipped hook. A
`credential.helper` or `submodule.<name>.update` value that starts with `!` is checked without the
`!`. git passes its `-c` options on to the git the program runs, through `GIT_CONFIG_PARAMETERS`,
so an `include.path` on the same git is a deny, as it is for a command git runs for its
subcommand. A safe value stays allowed: `less`, `cat`, `"less -R"`, `vim`, `store`,
`"ssh -i key"`, `true`, an empty value, and a plain word such as `main` or `false` for a key that
does not run it. git runs the value through a shell, so the TP-634 rule applies: any `$` expansion
or backquote in it is a deny, as in `X=--no-verify git -c core.pager='git push $X' log`. An `ext::`
payload is not a shell string (git-remote-ext splits it itself), so a `$` there stays literal.

A value the guard cannot read for a key not on the inert list is a deny on every git subcommand, since any
of them may start a pager or an editor: `-c core.pager="$P"`, `-c core.editor=$(cat e)`, and every
`--config-env` on such a key, since its value always comes from a variable. A `-c` or
`--config-env` word whose key the guard cannot read, such as `-c "$(cat k)"`, `-c "$X"`, a
backtick substitution or a glob or brace word, may name one of these keys, so it is a deny on every
git subcommand too, not only before one that runs a hook. So `git -c "$(cat k)" -c "$(cat k2)" log`
is denied: the two files may set `core.pager` to a push and `core.hooksPath` for it. This replaces
the TP-630 allowance for `git -c "$X" log`.

A `git config` write to one of these keys persists the value for a later git, whose config the
guard does not read, so the write is checked the same way (TP-4240). The written value is checked
like a `-c` value: `git config core.pager '$X'`, ``git config core.editor '`x`'`` and
`git config alias.p '!$X'` deny for the expansion, and a value the guard cannot read, as in
`git config core.sshCommand "$S"`, denies as `configProgramWrite`. A section rename can turn a
key the write check skipped into one git runs, so a rename out of an inert section, or out of one
holding an inert key, into any section not inert as a whole denies too: `git config rename-section
user core`, `rename-section credential alias` (`credential.username` becomes `alias.username`) and
`rename-section merge pager` (`merge.log` becomes `pager.log`). `git config user.name "$N"`,
`git config core.pager less` and `git config alias.st 'status -s'` stay allowed.

An `ext::` transport runs a shell command, enabled by `protocol.ext.allow` or
`protocol.allow=always`. A `-c`, `--config-env` or clone config word that sets either to anything
but `never`, or to a value the guard cannot read, denies after the payloads below are checked,
since git may then run an `ext::` URL from the repository's config that the line does not show:
`git -c protocol.ext.allow=always fetch origin` denies. git runs `ext::` only as a whole URL, so the guard checks exactly that span
of each word that holds `ext::`, case-insensitive: an argument that starts with it, the value of a
`--name=` option such as `archive --remote=ext::…`, and the value of each config word in the list
above, as in `-c remote.<x>.url=ext::…` or `-c remote.<x>.pushurl=ext::…`.
`ext::` anywhere else in a word is a span the guard cannot pin down, and denies. So does an `ext::`
base in a `url.<base>.insteadOf` or `.pushInsteadOf` key: git joins the base to the rest of each
URL it matches, so the end of its command is not known from the line. A commit message that
mentions `ext::` mid-text is an accepted false deny. The guard also treats the command of
`git remote-ext <name> <cmd>` as run. A
`remote.<name>.vcs` helper is handed that remote's URL with no `ext::` prefix, and `vcs=ext` runs it
as an ext command, so for any helper but `http`, `https`, `ftp` and `ftps` the remote's `-c`
`url` and `pushurl` values are checked as ext payloads. When that URL is not on the line (it comes
from the repository's config or `git clone`'s argument), is not literal, or may be rewritten by an
`insteadOf` key, the line denies as config the guard cannot read. git-remote-ext decodes the payload the way the guard now does (TP-636 fix round 2): arguments split
on spaces, `% ` an embedded space, `%%` a literal percent, `%s`/`%S`/`%G`/`%V` substitutions it
cannot know. The decoded argv is checked as a top-level Bash line, so
`git fetch "ext::sh -c git% push% --no-verify"` is denied: the `% ` join rebuilds
`git push --no-verify` as one argument to `sh -c`. The round-1 example `ext::sh -c 'git push …'`
was wrong, because git splits that on its spaces into separate arguments and never runs the push. A
value the guard cannot read (`ext::$C`) or cannot decode (a trailing or unknown `%` escape) denies.

What switches the transport on, or hides an `ext::` URL for a later git, is closed too (TP-2371).
`GIT_ALLOW_PROTOCOL`, a colon list git honours over `protocol.*.allow`, follows the program env
rule below on a line that may reach git: a plain literal assignment (prefix, `export` or `env`)
whose list names `ext`, in any case, denies, and any other use but a read denies, as in
`GIT_ALLOW_PROTOCOL="$P" git fetch`. Unsetting it there (`unset`, `env -u`, `env --unset`) also
denies, since that lifts the list agent-chat pins. `GIT_ALLOW_PROTOCOL=https:ssh git fetch` stays
allowed. A literal list naming `ext` denies wherever it appears, on a script, make or npm line too
(`GIT_ALLOW_PROTOCOL=ext make`, CC-1137 d), since nothing legitimate lists it. An unset, an unread
value or a built name (`export $N=ext; make`) on a line that cannot reach git stays allowed and is
left to the CC-1095 pin, which pins `ext` off for every git the shim runs;
`leak-git-shim-protocol.test.ts` shows a script's and a make rule's git refusing `ext::` under each.
A `git config` write, legacy or `git config set`, of `protocol.allow` or
`protocol.ext.allow` to anything but `never` denies; `--get`, `get`, `--unset` and a bare key read
stay allowed. `git remote add` or `set-url` with a word the guard cannot read, and a `git config`
write of `remote.<name>.url`, `.pushurl`, `.vcs` or `url.<base>.insteadOf` or `.pushInsteadOf` with
a value it cannot read, or of any key it cannot read, denies: the value may be an `ext::` URL a
later `git fetch` runs. So of the chain `git remote set-url x "$U"` then
`GIT_ALLOW_PROTOCOL=ext git fetch x`, each half denies on its own. A literal URL, as in
`git remote set-url origin https://github.com/o/r`, is allowed and read as before. A section rename
(`--rename-section` or `rename-section`) can move an innocent `foo.allow always` or `foo.url "$U"`
into place, so a rename whose target is under `protocol` denies as a protocol write, and one whose
target is under `remote`, `url` or `submodule`, or that the guard cannot read, denies as a URL
write. `git remote` with a verb the guard cannot read (`git remote "$V" x "$U"`) denies, and
`git submodule add` or `set-url` and `submodule.<name>.url` writes follow the remote rules. A
direct edit of `.git/config` or `.gitmodules` is not read here; the shim's `ext` pin
(CC-1095) is the backstop.

git's parse-options accepts any unique prefix of a long option (`--ren` for `--rename-section`,
`--fil` for `--file`), its `--no-` form, a value attached by `=`, and clustered short options
(`-zf file`). The guard reads the options of `git config`, `git remote` and `git submodule` the
same way, from each command's `-h` list on git 2.53, so it knows which word is the key, URL or
verb. An option it cannot match to exactly one it knows, because it is ambiguous (`--re`), unknown
or not literal (`--$O`), denies: spell each option in full. Where git stops reading options
differs by form, and the guard copies it. Legacy `git config`, whose first word names no
subcommand, stops at its first positional word: in `git config protocol.ext.allow always --get`
the `--get` is a value pattern, and git writes the key, so the guard reads that call as a write. A
leading `--` does not stop it, as in `git config -- --rename-section foo protocol`; the guard reads
past any `--` there, which only over-denies. `git config <subcommand>` (only as the first word:
`--file f set k v` is legacy), and the `git remote` and `git submodule` verbs, read options anywhere
up to `--`, so in `git config set -- "$K" --get` the `--get` is the value and the unread key denies.
Each option ends in its final state, the last spelling winning as in git, so
`git remote set-url --delete --no-delete x "$U"` stores the URL and denies. The builtins that store
a remote or submodule URL (`remote`, `submodule` and the internal `submodule--helper`) are read
from one table of verbs: a verb that stores a URL, or one outside the table, with a word the guard
cannot read denies, and only `remote set-url --delete` and the verbs listed as storing none are
exempt. `git clone` stores its repository as `remote.origin.url`, so a clone whose repository
argument (its first positional, read with clone's own options) the guard cannot read denies too,
as in `git clone "$URL"`, `git clone -b main "$(cat u)" d` or `U=https://github.com/o/r; git clone
"$U"` (TP-2444, reversing the TP-636 allowance). An unread directory argument, a literal URL, `-h`,
an unknown literal flag and `gh repo clone "$R"` stay allowed; the CC-1095 pin stays as a backstop.
These rules read one shell word as one argument, so for `git config` and the URL-storing
builtins a word after the subcommand that the shell may expand to none or several denies as an
unreadable write: an unquoted `$X` or `$(...)`, `"$@"`, `"${A[@]}"`, a glob or a brace, as in
`git config {protocol.ext.allow,always}` or `git config $X`. `-h` and `--help` write nothing and
stay allowed. On the env side, one predicate decides where a variable name is read, at each
command head along the wrapper chain, and fails closed on any expansion there (TP-2371): every
`env` word before the command, `--` included, with an expansion before its first `=` (`env $A`,
`env G$X=ext`, `env -- $A`), a `-u` or `-S` value or an option the guard cannot read; any operand
of `read`, `getopts`, `mapfile`, `readarray` and `unset` that holds an expansion; the `printf -v`
name, or an expanded operand before its format; and a name in the `declare`, `typeset`, `export`,
`local` and `readonly` family. `declare`, `typeset` and `local` pass only the attribute letters
`aAfFgilprtux`, so any `-n` (alone or in a cluster such as `-gn`) or other option fails closed,
since a nameref may point at any variable; so does any `${!X=}` or `${!X:=}`, which assigns the
variable `X` names (TP-2499). These rules also read a command's redirect targets, here-strings
and unquoted heredoc bodies on any descriptor, where a program var's `${NAME:=x}` denies too. The
lexer drops none of that text: it keeps a redirect-only command that holds any, whose assignments
bash keeps, as a `)` command wherever it stands, at the end of the line and before a heredoc body
included. That `)` command keeps its own write targets too: zsh runs a redirect-only command as
NULLCMD, which is `cat`, so `< f >> x` writes `x` where it stands and never through the command
after it (TP-4250). Such a name may be any program var or
`GIT_ALLOW_PROTOCOL`, so on a line that may reach git it denies as `programEnv`, after the line's
other checks so a more specific reason wins. Two rules carry this into the scripts a line runs:

1. A hidden name in any script the line runs counts when the outer line may reach git. That
   covers `eval`, `trap` and `mapfile -C` below, the text fed to `source /dev/stdin` or `.`, a
   `sh -c` string, parallel's script, git's `-x` and alias scripts. A child shell cannot pass a
   variable back, so `bash -c 'declare -n R=$A; R=x'; git fetch o` is a deny the guard accepts.
2. The scripts a builtin hands the current shell are read as the shells read them, and checked
   as nested scripts. Each is the whole text the shell evaluates, with the words the shell adds
   read as unread words, so no caller sees a callback without them. One the guard cannot read denies as `hiddenScript`: for `eval` on a line
   that names git or gh, for `trap` and `mapfile` on a line that may reach git or gh.

A `{NAME}>file` redirect writes the descriptor it opens to `NAME`, and zsh does so before an
external command starts, so `gh {GH_PAGER}>/dev/null pr view 1` runs a pager named by a number.
An unquoted `{NAME}` word after the command word and before a redirect operator leaves the
argument list, as the `3` of `3>` does, and becomes a prefix assignment `NAME=$$` with a value the
guard cannot read. Every rule that reads assignment words then sees the write, with no rule of its
own (CC-1630). Three spellings the shells read differently make the line unreadable: a `{NAME}`
word in command position, which zsh runs as a brace group, a `{NAME[sub]}` word, which bash
assigns and zsh globs, and `{NAME}&>`, where bash keeps the word as an argument. A
program var denies as `programEnv`, a search path as `searchPathEnv`, a shell startup variable as
`shellStartupEnv`, a `GIT_CONFIG_*` name as `gitConfigEnv`, and gh's `HOME`, `XDG_CONFIG_HOME` or
`GH_CONFIG_DIR` as `ghConfigHome`.
`GIT_DIR` is no program var, so `exec {GIT_DIR}>/dev/null; git status` is allowed, as
`GIT_DIR=x; git status` is.

A double-quoted trap action that expands nothing, such as `trap "rm -f tmp" EXIT`, is read as
written and allowed. One that expands a variable (`trap "rm -f $tmp" EXIT`) stays a `hiddenScript`
deny on a line that may reach git. The shell splices the value into the action when the trap is
set, so the value becomes script text, and the guard does not know the value the command will see.
Single quotes (`trap 'rm -f "$tmp"' EXIT`) keep the expansion inside the script the guard reads.

| builtin                | script                                                                                                             | not a script                                         | unreadable                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------- |
| `eval`                 | its operands joined, past one `--` (zsh's `-` too)                                                                 |                                                      | an option or expansion as the first word |
| `trap`                 | its action, the first operand past one `--`                                                                        | `-p`, `-l`, zsh's `-P`; an action `-`; a lone signal | an expanded action or another option     |
| `mapfile`, `readarray` | the `-C` callback followed by the index and line bash adds, read as unread words; bash runs it every quantum lines | no `-C`                                              | an expanded `-C` value                   |

Not read by these rules, each a follow-up: assignments in arithmetic, `let`, `(( ))` and
`declare -i` (TP-2507); zsh `print -v`, `set -A` and `vared` (TP-4224); `PS4` and `${x@P}`
prompt expansion under `set -x` (TP-4227); zsh's `-` precommand modifier as a wrapper (TP-4225);
ksh's `nameref` alias and zsh's `typeset -U` (TP-4226); a command word that is only an expansion
counting as git (TP-4231; the `declare -n` and `${!A:=}` rows are TP-4234); and the contents of a file that `source` or `.` reads,
unread by design. Words that `xargs` adds are read as unreadable (CC-1117, above); words that
`find -exec` adds are not read here.
The guard skips
git's own value-taking options before the subcommand from one list, which includes
`--attr-source` and `--shallow-file`, so their value is never read as the subcommand.

### An environment variable git runs as a program (TP-636)

The same keys have environment-variable twins, from the ENVIRONMENT section of `git help git` and
the shell fallbacks git honours: `GIT_PAGER` and `PAGER`; `GIT_EDITOR`, `EDITOR`, `VISUAL` and
`GIT_SEQUENCE_EDITOR`; `GIT_SSH` and `GIT_SSH_COMMAND`; `GIT_ASKPASS` and `SSH_ASKPASS`;
`GIT_EXTERNAL_DIFF`; and `GIT_PROXY_COMMAND`. Beside them are the programs of the tools git
starts: `MANPAGER` for the man that `git help` runs, and `BROWSER` for `git web--browse`. Four
more hold options or a preprocessor spec rather than a command line, yet can still make man or
less run one: `LESS` (`+!cmd`), `LESSOPEN` and `LESSCLOSE` (`|cmd %s`), and `MANOPT` (`-P cmd`).
Both lists live in `git-programs.ts`.

This is one conservative line rule, not a list of spellings, though a name built at run time
(`export ${n}_EDITOR=…`) is not seen; that is the general gap listed under what the guard does not
cover. On a line that runs git anywhere,
each word is read for these names. A plain literal `NAME=value` to a name in the first list has
its value checked as a top-level Bash line, but only where the shell reads the word as an assignment
exactly once: a prefix assignment, an assignment right after a literal `env`, or an argument of
`export`, `declare`, `typeset`, `local` or `readonly` written as the command word itself. git runs
that value through a shell, so by the TP-634 rule any `$` expansion or backquote in it denies:
`X=--no-verify GIT_PAGER='git push $X' git log`. Accepted false denies follow from this rule:
`GIT_PAGER='less -R $L' git log`, like `git rebase -x 'npm test -- $T' main` and
`git submodule foreach 'git checkout $sha1'`. Letting the outer shell expand the value does not
help, since the guard cannot read that value either; write it out literally
(`GIT_PAGER='less -R -S'`). Any other
use of any of these names denies with its own reason: the shell has too many ways to assign one to
list them all, among them `NAME+=…`, a zsh subscript such as `GIT_PAGER[1,-1]=…`, a brace-expanded
name (`export {GIT_EDITOR,Y}=…`), `read NAME`, `printf -v NAME`, `for NAME in`, a nameref, a bare
`export NAME`, an assignment to `LESS` or `MANOPT` of any value, an expanded or unreadable value,
and any word under `eval`, `command`, `builtin`, `xargs` or `env -S`, which may read it a second
time: `eval export 'GIT_EDITOR=git\ push\ --no-verify'` is one word to a literal check and three to
the shell. A read stays allowed: `$NAME`, and `${NAME…}` with an operator that only reads,
such as `${PAGER-less}`. `${NAME=…}`, `${NAME:=…}` and zsh's `${NAME::=…}` assign, so they deny
anywhere on the line. Each word is read by the command that receives it, on the guard's unwrap of
that command (TP-636 fix round 10). git, `gh` and `agent-chat gh-write` take their arguments as
data: no word they receive assigns a shell variable. So their arguments count only for an
assigning expansion the shell expands, not one inside single quotes. A commit message, PR title or
comment body that mentions `GIT_PAGER`, `EDITOR` or `'${PAGER:=less}'` stays allowed;
`git commit -m "${GIT_EDITOR:=x}"` denies. The may-reach-git test only decides whether the rule
runs on a line, never which words count. `unset NAME` and `env -u NAME`, which only remove a
name, are allowed too.

"Runs git anywhere" is the guard's own may-reach-git test (CC-478), the one the hidden-command
budget uses, not a search for the word `git`: a command word that may expand to git counts, such as
`${G}t` after `G=gi`, `g{i,}t` or `$'g\x69t'`, and so does any `$(…)` substitution or a variable
the line or the hook ties to git or gh. It includes a nested `sh -c`/`bash -c`/`eval` that runs
git, and a prefix env on such a shell (`GIT_EDITOR=… sh -c 'git commit'`) counts as reaching git. So
`G=gi; GIT_PAGER='git push --no-verify' ${G}t log` is denied, as are
`GIT_SSH_COMMAND='git push --no-verify' git fetch`, `MANPAGER='git push --no-verify' git help log`
and `declare -x GIT_EDITOR='git push --no-verify'; git commit`. A false deny on a line that both
uses one of these names and may reach git is accepted: `grep GIT_PAGER f && git diff`,
`export -n GIT_EDITOR; git commit`, and `LESS=-R git log` all deny. A safe literal value stays
allowed: `GIT_PAGER=less`, `PAGER=cat`, `EDITOR=vim`, `GIT_SSH_COMMAND="ssh -i key"` and an empty
value. The git scan blanks a program-env assignment's value only where the shell reads that word
as an assignment once, so `GIT_EDITOR='git push' ls`, which runs no git, stays allowed. Both the
name uses and the git scan also read the command the guard's own unwrap says runs: its
assignments and words, including those `env -S` splits out of one word, behind any wrapper. So
`env -S "GIT_PAGER=less git log"` and `nice env -S "GIT_EDITOR=x git commit"` deny.

A variable whose name the shell builds (`read $A`, `export $A=`, `printf -v "$A"`, `declare -n R=$A`
then `R=`, `${!A:=…}`, `unset $A`, `mapfile "$A"`, `getopts … "$A"`) denies as `programEnv` wherever
the guard parses it: the outer line, and eval, trap, `mapfile -C`, `sh -c` and fed-script text. It
denies whether or not the line shows git, because the name may be any variable (a git program env, BASH_ENV,
LD_PRELOAD) and its own operand may run code through an array subscript. No command is proven inert
after it (TP-4231).

Unchanged, and not findings against this rule:

- eval or source of text the guard cannot read, with no visible hidden name (`eval "$A=ext"; $G …`,
  `eval "$(cat f)"`, `. /dev/stdin <<< "$S"`). This is redesign-1 follow-up 1.
- SEARCH_UNREAD (`PATH=$X make`, `hash -p "$X" make`).
- Arithmetic or a subscript reading an env value with no hidden name on the line (`test -v "$C"`,
  `echo $((x))`). This is CC-1249's `arithSubscriptNames`.
- Files and programs run by path.
- Lines that show git, where main's rules are unchanged.

Accepted over-denies. Each needs a name the shell builds, on the same call:

- `export $A=ext; echo hi` and any other command after one
- the #1187 pins `declare -n R=$A; R=x; ls` and `trap 'declare -n R=$A; R=x' DEBUG; ls`
- `env -C /x $X q` and `status`
- `bash -c 'read $A'; $G x`
- a lone `read $A <<< ext`

`GIT_CONFIG_PARAMETERS`, and `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` and
`GIT_CONFIG_VALUE_<n>`, set inline before git can set the same config keys. They need no rule of
their own: the existing `GIT_CONFIG*` row already denies any assignment, `export`, `unset` or
`env -u` of those variables, whatever the key.

Not covered, gap 1: a prefix env on a command the guard cannot follow into, such as `X=… make`,
`X=… npm run build` or `X=… sh script.sh`, where the script runs git. The guard never reads the
script, the same script-file gap as below. Also not covered: a program key written to repository or
global config with `git config` in one call and used by a later git in another, and text read from
a file at run time by `bash -c "$(cat f)"` or `eval "$(cat f)"`. The guard reads a `sh -c` string
as written, and `eval` of text it cannot read is denied only when the line names `git` or `gh`. A
program env var whose value is already in the agent's environment, set by a shell startup file or
an earlier tool call rather than on this command line, is not read, the same gap as any such
variable.

### Inputs that change what git, gh or ssh run (TP-2376)

Some inputs make a program run code the guard never reads, without naming that code on the line.

**ssh options.** `ssh`, `scp` and `sftp` are read the way OpenSSH's getopt reads them
(`ssh-options.ts`), wherever they run: at top level, by path, behind a wrapper, in a nested
`sh -c`, as the value of `GIT_SSH_COMMAND`, or as a `git -c core.sshCommand=` value. The guard
denies with its `sshProgram` reason an `-o` whose keyword ends in `Command` (ProxyCommand,
LocalCommand, KnownHostsCommand, PermitLocalCommand, RemoteCommand) in any case, glued, spaced,
quoted or in a cluster such as `-vo LocalCommand=x`; an `-o` naming a local library or program
(PKCS11Provider, SecurityKeyProvider, XAuthLocation) and ssh's `-I`; a `-F` config file other
than `/dev/null` or `none`, since a config file can set any of these; scp and sftp `-S` and `-D`,
and sftp `-b`; and an option word the guard cannot read. ssh re-reads options once after the host,
so `ssh h -oProxyCommand=x` denies, but words after the remote command's first word do not:
`ssh h sort -o ProxyCommand` is allowed. `ssh -J`, `ssh -F /dev/null` and plain `-o` settings
such as `BatchMode=yes` stay allowed; use `-J` for a jump host. `GIT_SSH=<path>` runs a program
file and stays the script-file gap.

**Shell startup, exec path and template variables.** `BASH_ENV` (bash), `ENV` (sh and ksh in
POSIX mode) and `ZDOTDIR` (zsh) make a shell source a file before it runs its command;
`GIT_EXEC_PATH` makes git run its helpers from a directory; `GIT_TEMPLATE_DIR` makes `git init`
and `git clone` copy hooks and config from one. The shell class fails closed on any variable bash, zsh, sh or ksh
turns straight into code, matched by pattern in `SHELL_CODE_ENV` (`trust-inputs.ts`): bash's
exported functions `BASH_FUNC_<name>%%` and `BASH_FUNC_<name>()`, `SHELLOPTS` and `BASHOPTS`
(`SHELLOPTS=xtrace` expands `PS4`), every prompt (`PS0` to `PS4`, `PROMPT_COMMAND`, zsh's
`PROMPT*`, `RPROMPT*`, `RPS*` and `SPROMPT`), and `FPATH`, `MODULE_PATH` and
`BASH_LOADABLES_PATH`. They join the program env rule above with the same
line test and the same reading of each word, but each denies with its own reason
(`shellStartupEnv`, `gitExecPath`, `templateDir`), and a plain literal value denies too, since the
value names a file, not a command line to check. So `BASH_ENV=/tmp/rc bash -c "gh zz"`,
`export BASH_ENV=/tmp/rc; git push`, `ZDOTDIR=/tmp/z zsh -c 'git status'`,
`env BASH_ENV=/x git push`, `: ${BASH_ENV:=/x}; git push`, `GIT_EXEC_PATH=/tmp/x git push` and
`export GIT_TEMPLATE_DIR=/t; git init r` deny, as do
`env 'BASH_FUNC_git%%=() { command git push --no-verify; }' bash -c 'git status'` and
`SHELLOPTS=xtrace PS4='$(git push --no-verify)' bash -c 'git status'`. A read (`echo "$BASH_ENV"`), `unset BASH_ENV`, a
line that never reaches git or gh (`BASH_ENV=/tmp/rc make`) and a commit message naming the
variable stay allowed. Known false deny: a bare `ENV` word on a line that reaches git, as in
`echo ENV; git status`, denies the way `LESS` does. The agents' pre-push hook runs under
`/bin/sh -p`, which ignores `BASH_ENV` and `ENV`; the rule is about a chained repo hook and about a
`bash -c` or `zsh -c` that would hide git or gh from the guard.

**Command lookup (CC-1236).** Every piece of shell state that picks which file `git` runs is one
table, `COMMAND_LOOKUP` in `trust-inputs.ts`, and the tests loop over it, so a new entry gets deny
rows without listing them. `PATH` picks which `git` and which helpers run; every `LD_*` and `DYLD_*`
name, matched as a family, and `GCONV_PATH` pick the code the loader puts into git. A
literal value names files the way any command line does, so it keeps its verdict:
`PATH=/usr/bin:/bin git push`, `PATH+=:/opt/bin git push`, `PATH=~/bin:$PATH git push` and
`export PATH=$HOME/bin:$PATH` stay allowed, as the value expands only the variable's own value,
`$HOME` or a bare `~`. `$HOME` and `~` count only while no line around them names `HOME` other than
by a plain read, so `HOME=$X PATH=$HOME/bin git push` and `read HOME; LD_PRELOAD=~/l.so git push`
deny. Any other tilde prefix (`~+`, `~-`, `~1`, `~user`) is unread, since it is the current, previous
or a stacked directory. Any other use on a line that may reach git denies with the `searchPathEnv`
reason: a value with any other expansion (`LD_PRELOAD="$X" git push`, `PATH=$(mktemp -d) git push`,
`PATH=$PWD/bin:$PATH git status`), `read PATH`, `: ${PATH:=/x}`, and an `env -S` or `xargs` word.
The deny ranks after the per-command checks, so `PATH="$X" git push --no-verify` keeps the
`noVerify` reason. Known false denies: a bare `PATH` word on a line that reaches git
(`echo PATH; git status`, `sudo --preserve-env=PATH git status`), the way `ENV` does, and a literal
`HOME` write before a `$HOME` or `~` entry (`HOME=/h LD_PRELOAD=$HOME/l.so git push`). Known gap: a
relative literal entry after a `cd` the guard cannot read (`cd "$X"; PATH=.:$PATH git push`)
resolves against that directory and stays allowed.

The rest of the table denies any write on a line that may reach git, whatever its value: zsh's
`path`, tied to `PATH`; the command hash tables `commands` (zsh) and `BASH_CMDS` (bash); and the
function and alias tables `functions`, `aliases` (zsh) and `BASH_ALIASES` (bash), since a function
or alias named git runs before any file. That covers `path=($X $path)`, `commands[git]=$X`,
`BASH_CMDS[git]=/bin/echo`, `typeset path=(...)`, `read -A path`, `for path in ...` and
`${path:=...}`. A lowercase name is zsh's and a common word, so it counts only where a word names
it as a variable: `src/path.ts` and `git log -- path` do not count, and a bare operand does
(`cd path && git status` and `cd functions && git status` are known false denies). The builtins that
write the hash table, `COMMAND_LOOKUP_BUILTINS` (`hash -p <file> git` in bash, `hash git=<file>` in
zsh), deny when given any word the guard cannot read; a literal `hash -p /usr/bin/git git` names a
file as a literal `PATH` does and stays allowed. Known gap: the `alias` builtin itself.

**git options and config writes.** `safe.directory` makes git trust the config and hooks of a
repository another user owns, and git reads it only from protected config: system, global and the
command line. `init.templateDir`, like `GIT_TEMPLATE_DIR`, makes `git init` (and its old name
`git init-db`) and `git clone` copy a directory's hooks and `config` into the new repository, so a
template can set `core.hooksPath` or a `!` alias. These three builtins (`REPO_CREATORS` in
`trust-inputs.ts`) are the only ones on git 2.53 that take `--template`. `git submodule add` and
`update` clone through `git clone`, which reads a template only from config and env, both denied
here. `git clone --config init.templateDir=<dir>` writes the key into the new repository after it
is created, so it copies nothing and stays allowed. The guard denies with its `safeDirectory` or `templateDir` reason a git leading `-c` or
`--config-env` on either key (any case), and a `git config` call (`trust-inputs.ts`, legacy or
`set` grammar, after any `-C` or other leading option) that writes either key or renames a section
into `safe` or `init`. `git init`, `git init-db` and `git clone` deny `templateDir` for `--template=<dir>` or
`--template <dir>` under any unique prefix (`--templ`), wherever the option sits before `--`.
`git --exec-path=<dir>` denies `gitExecPath`. Reads and unsets
(`git config --get-all safe.directory`, `git config --global --unset safe.directory /x`), an
empty `--template=`, `--no-template` and a bare `git --exec-path`, which only prints, stay allowed.
An option the guard cannot match, such as the ambiguous `git clone --t=/t`, is left to git, which
refuses it. Known gap: an unread word such as `"$DIR"` in `git clone https://github.com/o/r "$DIR"`
may hold `--template=<dir>` from the agent's environment; like any value set before this line, the
guard does not read it.

### A gh alias (TP-2371)

A gh alias runs what it expands to: a shell alias (`gh alias set --shell`, or an expansion that
starts with `!`) through `sh -c <body> -- <args>`, which appends nothing, and a plain alias as
another gh command, with each `$N` replaced in the text and any argument left over appended. The
guard checks a body twice, for `gh` and for `agent-chat gh-write -- <gh args>` alike:

- when `gh alias set` stores it, as a command line of its own with `$1` and the directory
  unresolved, so `gh alias set --shell x 'GIT_PAGER="$1" git log'` is denied by the program-env
  rule, and a plain body is checked as `gh <body>`. Its flags are read the way gh's flag parser
  reads them, anywhere before `--`: `-s`, `--shell`, `-s=true`, `--shell=1`, `-ss`, and `-sh`
  (help, which stores nothing). A flag the guard does not know denies;
- when `gh <word>` runs it, with the body read from gh's `config.yml` (`GH_CONFIG_DIR`, else
  `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`) and the arguments filled in. A top-level word that
  is not a gh command may be an alias, and so may `gh <command> <word>` when the word is not one
  of that command's real subcommands or their aliases: gh registers a `<command> <word>` alias
  under every command but `a11y`, `accessibility`, `api`, `browse`, `completion`, `credits`,
  `licenses`, `status` and `version`, and runs a real subcommand before an alias of the same
  name (probed on gh 2.102; the subcommand table is in `src/leak-guard/gh-runs.ts`). Up to four
  aliases deep are followed.

gh matches a key on its canonical command path, not its spelling, and the guard does the same.
It splits the key into words, resolves command aliases (`cs` to `codespace`, `ext` and
`extensions` to `extension`, and `at`, `rs`, `skills`, `agent`, `agents`, `a11y`), and walks
real subcommands. The key registers only when exactly one word is left after the deepest command
that takes an alias. So key `cs one` runs on `gh codespace one`, and key `codespace two` runs on
`gh cs two`. Key `repo deploy-key four` runs on `gh repo deploy-key four`, since `repo autolink`,
`repo deploy-key`, `repo gitignore` and `repo license` take an alias. `codespace ports` and every
leaf command do not. Keys such as `pr mine extra` and `pr view seven` never run. The invocation
is walked the same way, past gh's flags, and every key that names its path is checked.

A key whose shlex words hold whitespace (`'pr x'` quoted, or `pr\ x` escaped) is one word with
a space in it, and gh 2.102 runs it in place of real commands such as `gh pr view 1`,
`gh issue list` and `gh api user`. The guard does not model that takeover. Such a key makes
`config.yml` read as unreadable, so every gh command with a command word denies until the key is
removed, and `gh alias set` with such a name denies. A name holding any whitespace other than an ASCII
space or tab (NBSP, VT, FF, U+2003, U+3000), a control character or a format character such as a
zero-width space counts the same, since gh's shlex may split it differently than the guard. So does any `#`: gh's shlex reads it as a
comment, so key `zz #c` runs as alias `zz` and `pr mine #c` as `pr mine`.

gh finds the command word past its flags the way cobra's `stripFlags` does, and the guard does
the same: `--` ends the search, a `--flag` or `-f` without `=` swallows the next word unless it
is `--help` or `--version`, and any other flag is skipped. So `gh -R o/r rx` runs alias `rx`, and
gh hands the alias every word but its own name, flags included (`$1` is `-R`). `co`, `help`,
`__complete` and `__completeNoDesc` are not builtins to gh: a config alias of that name runs
(probed on gh 2.102), so they are looked up like any other word.

gh keeps the first of two equal YAML keys, and so does the guard. A `config.yml` the guard cannot
parse, or whose `aliases` is not a map of strings, denies every gh call that may run an alias,
since gh may still read an alias from it; a missing file reads as no alias.

It denies `gh alias import` and `gh alias set <name> -`, which read aliases from a file or stdin;
a definition or an argument the guard cannot resolve; and a top-level word that may be an alias on
a line that names gh config: `gh alias set`, `gh config set`, a `config.yml` or `hosts.yml`
path, or the config directory itself by path (`~/.config/gh`, `$XDG_CONFIG_HOME/gh`,
`$GH_CONFIG_DIR` or the hook's own config directory), so `mv`, `cp -r`, `ln -sfn` or `tar -C`
into it denies. A directory reached another way (`cd ~/.config && mv x gh`) is not seen; the
alias it adds is still read and checked by a later call.

The guard fills a shell alias's positionals (`$1`, `$@`, `$*`) with each argument as one
single-quoted word, which matches `sh -c` only for a plain word: unquoted, the shell splits and
globs an argument, and inside double quotes it keeps the quotes literally. A positional with a
modifier (`${1:-x}`, `${@:1}`, `${1#x}`, `${#1}`, `${!1}`) is not filled at all. So a shell
alias denies when it reads a modified positional, when any argument is not a plain word
(letters, digits and `_./:=@%+-`), or when a quoted `"$@"` gets other than one argument.
`gh co 12` through `gh pr checkout "$1"` stays allowed, while `gh y git push --no-verify` through
`"$@"` and `gh y 'push --no-verify'` through `git $1` deny. `gh alias set --shell` with a quoted
or modified positional denies, since its arguments are not known yet. The scan skips single
quotes and `$'...'` strings. A git `!` alias follows the same rule.

It also denies when gh may read a config other than the hook's, judged from the same tracked
environment git aliases use. That covers a line where the guard lost track of the environment
(after `. file`, `source file` or `eval`), an earlier `export` or `unset` of `GH_CONFIG_DIR`,
`XDG_CONFIG_HOME` or `HOME` that differs from the hook's value, a prefix assignment, or any
other use of those names. The same holds for a `gh <command> <word>` that may be an alias, so
`GH_CONFIG_DIR=/tmp/x gh pr mine` denies while `GH_CONFIG_DIR=/tmp/x gh repo view` does not.

A write straight into `config.yml` in an earlier call (`printf ... >> ~/.config/gh/config.yml`)
is not denied: the alias it adds is read and checked when `gh <alias>` runs.

### A gh extension and the git clone gh runs (TP-2371)

A top-level gh word that is neither a gh command nor a config alias runs an extension
(`gh-<word>` from `gh extension list`), a program the guard cannot read, so `gh <word>` denies,
and so do `gh extension exec <name>` (or `ext`/`extensions`) and `gh extension <word>` with a word
the guard cannot resolve. A config alias of the same name is checked as an alias instead.
`gh help <word>` runs extension `<word>` with every other word as its arguments when `<word>` is
not a gh command (probed on gh 2.102: `gh help myext extra words` ran `gh-myext extra words
--help`), so it denies too, as does `gh help` with a word the guard cannot resolve; `gh help pr`
stays allowed. `__complete` and `__completeNoDesc` are gh's own when no alias shadows them (they
did not run the extension), and `gh extension list` and `gh extension install` stay allowed:
installing runs nothing. The guard's list of gh
commands (`GH_BUILTINS` in `src/leak-guard/gh-runs.ts`) is checked against `gh help` in the tests
on a machine with gh, so a new gh release that adds a command shows up as a failing test before
it becomes a false deny.

`gh repo clone <repo> [<dir>] [-- <gitflags>]`, `gh repo fork <repo> --clone [-- <gitflags>]`
and `gh gist clone <gist> [<dir>] [-- <gitflags>]` run `git clone <gitflags> <url> [<dir>]`
(one table, `GH_CLONES` in `src/leak-guard/gh-runs.ts`): gh hands git every word after the
repository or gist, and a
leading one that is not a flag becomes the directory. The guard builds that argv and checks it as a
`git clone` written out, so `gh repo clone o/r -- -c core.pager='git push --no-verify'`, a
`--config`, `-u`/`--upload-pack` or `ext::` word, and `gh repo fork o/r --clone -- -c
core.sshCommand=<denied>` and `gh gist clone abc -- --upload-pack=<denied>` deny, while `gh repo clone o/r` and `gh repo clone o/r -- --depth 1`
stay allowed. gh strips the first literal `--` wherever it sits, and so does the guard. A word
after `--` that the guard cannot resolve (`-- "$OPTS"`) denies, since git may read it as an
option; one before `--` is gh's (the repository, a directory, or a flag gh rejects), but it may be
`--` itself, so every word after it is checked as a git flag, and a later unresolved word that
may sit past that `--` denies. With a `repo` or `gist` subcommand the guard cannot resolve
(`gh repo "$S" ...`), the words are read as `clone`'s.

### Files a later shell sources are owner-only (TP-4232)

`gh auth setup-git`, `login` and `refresh` write the gh path they find from `GH_PATH` or `PATH`
into git config as the credential helper. A file a later shell sources can set that path, or the
gh config, in a shell the guard never reads, and whether a `NAME=value` line there is inert
depends on who reads `NAME` later (`BASH_ENV`, `PROMPT_COMMAND`, `GIT_SSH_COMMAND` and so on). So
the guard never judges what is written; it keeps the Edit tools off these files
(`src/leak-guard/env-files.ts`).

This PR denies the Edit, Write, MultiEdit and NotebookEdit tools on a file a later shell sources:
the shell startup files, `CLAUDE_ENV_FILE`, Claude Code's `session-env` and `shell-snapshots`, and
the hook's `BASH_ENV`/`ENV` values when they are absolute paths. The target is matched by its
resolved real path. It also adds the `changesGhHome` mention rule and the renamed-gh rule. It does
**not** judge Bash lines that write these files: whether a line writes a file is not decidable from
its text (naming through variables, globs, symlinks or `cd`; write operators and programs the parser
doesn't model). The runtime integrity check in TP-4256 enforces that. A Bash-line bypass of a
sourced file is a finding against TP-4256, not a FIX_FIRST here. Neither covers files sourced in turn
(TP-4251).

The target counts both as given and by its real path: the real path of its nearest existing parent
plus the rest, following a dangling symlink, so a symlink to `~/.zshenv` or to an absent
`~/.zlogin` denies, and so does a `~/.zshenv` that is itself a symlink into a dotfiles checkout. A
hook value is compared exactly, so `ENV=dev` leaves `src/dev/x.ts` alone. The file a dotfiles
symlink points at, edited under its own name, is TP-4256's. The renamed-gh rule leaves a `HOME=`
prefix in front of a renamed gh copy, and hash/`commands[]` rebinding (TP-2706).

### Agent hook settings (TP-4256 A5)

An agent's hooks depend on the launch files in `<agents dir>/<id>/`: `settings.json`, `mcp.json`,
`plan.json` and `relaunch`. Rewriting any of them can start the agent, or its next launch, without
the guard.

**Boundary.**

- Pretool on the Edit route is a convenience. It refuses every Edit, Write, MultiEdit and
  NotebookEdit call whose target lies under the agents dir, by one rule: the native real path of the
  target (for a file not made yet, the native real path of its nearest existing parent plus the
  rest; case-folded on darwin and win32) starts with the real agents dir plus a separator. There is
  no list of file names, and coordinators are refused too.
- A Bash write is never refused up front: the guard does not match command text against path
  spellings (CC-1643).
- The guarantee is the broker's watch (`src/broker/settings-watch.ts`) over every launch file the
  ledger admitted (see "The launch ledger" below). It keeps the sha256 of each file a launch wrote,
  re-hashes them on every `integrity_check`, every relaunch ask and a 60 s timer, and the first
  changed, deleted or unreadable file quarantines the agent and files one owner notice. It
  detects; it does not restore or stop a running agent. What it prevents is the agent's next tool
  call, and every later launch of the agent or of anything descended from it.
- The watch reads only bounded regular files: it lstats first, and anything but the same regular
  file (same dev and inode), such as a FIFO, a device, a symlink or a replacement file, latches
  `state` without being opened. The read is non-blocking and no-follow, and it stops at the
  baseline size plus 4 KiB.

**What the watch cannot catch.**

- A file edited and restored between two sweeps (the A3 follow-up: mtime, ctime and inode, or
  `fs.watch`).
- Anything within its latency of up to 60 s. A hookless agent sends no `integrity_check`; what
  stops it is `run-agent`, which refuses to relaunch it. Whether Claude Code re-reads a
  `--settings` file mid-session is UNVERIFIED.
- A change made while the broker is down, or after a restart and before the agent is admitted
  again: the ledger and the watch are memory only.
- Files outside the agents dir that decide whether the hook runs: the agent-chat `dist/` or plugin
  install the hook command points at, the node binary, and carried user settings. Those need their
  own task.

The Edit-route rule also leaves two known gaps. A hard link outside the agents dir to a launch file
has a real path outside it; making it needs Bash, and the watch sees the change. And the case-fold applies only on darwin and win32, so a case-insensitive Linux mount (ext4 casefold,
vfat) holding the agents dir is not folded for a leaf not made yet.

**Reviewer scope.** In scope: whether the one prefix rule refuses every Edit-family write whose
canonical real path is under the canonical agents dir (symlinks, a missing leaf, case on a
case-insensitive volume), and whether the watch latches on any byte or state change of any
registered file and fails closed on an unknown nonce, an unreadable file or a missing baseline.
Out of scope: Bash-route prevention (CC-1643), edit-then-restore (A3 follow-up), persistence
across restarts (owner), and hook binary or `dist/` integrity (a new task). A finding that is
another spelling of a path under the agents dir is a defect in the rule's canonicalisation: fix it
there, and add no new rule or name.

### The launch ledger (TP-4256 A3)

Option R1 of TP-4232: each broker polices the launches it wrote, and nothing else. A launch's
settings carry `leak-guard pretool --integrity <nonce>` and `posttool --integrity <nonce>`. Both hook
verbs read the startup files and the session's snapshot, `session-env` and `CLAUDE_ENV_FILE`, then
ask the broker that minted the nonce. Every failure denies: an unreachable broker, a past deadline, a
worker crash and an unknown nonce. Posttool reports a change as `decision: block`, so the model sees
it on the call that made it.

**One choke point** (`src/broker/integrity-ledger.ts`):

- `admit` is the only way to get a nonce. It sweeps the agent's old launch files, enrols the agent
  under its parent, clears only on `humanProof`, mints the nonce, lets the launcher write the files
  with it, and replaces the agent's watched files. `writeLaunchFiles` needs either an admission or
  the `OFF_BROKER` constant, so a new launch site that skips the ledger does not compile.
- A quarantine belongs to the agent, never to a nonce. A resume, mode switch, wake or relaunch
  gets a fresh nonce for the same agent, so it stays quarantined. A child or a teleport successor
  has its parent recorded, written once.
- `verdict` is the only read. It walks from the agent through each parent up to the human root,
  and denies if any of them is quarantined after the asking agent was last cleared. An agent the
  ledger does not know, or a chain that does not reach the human, denies with `no baseline`. A child
  spawned before its parent latched is denied too, because the walk happens at verdict time.
- Only the human's own `agent-chat agent resume` clears a quarantine. A wake, a seat, an agent's
  request, a mode switch and a teleport never do.
- `run-agent` asks the same `verdict` before it reads `plan.json`, after a sweep, so a `plan.json`
  rewritten without `--settings` is refused before it can start a hookless agent. A broker it cannot
  reach, or an agent the ledger does not know, refuses with exit 77.

**Boundaries.**

- **Off-broker launches.** `remote-launch.ts`, `host-launcher.ts` and `caller-teleport.ts` write
  files for another host's broker, so they pass `OFF_BROKER` and carry no `--integrity`. The local
  broker answers their `run-agent` ask with `offBroker` only when the real path of the agent dir is
  outside its own real agents dir. That is a path check, not a text match.
- **Hand-started sessions.** A Claude session the human started outside agent-chat is adopted at
  `register` and never admitted, since agent-chat wrote no launch files for it. Its children are
  rooted at the human. Once the ledger admits it (an `agent resume` of it), its own chain counts. A
  same-uid process that starts `claude` without agent-chat is out of scope.
- **Unrelated agents and a shared startup file.** Agent A tampers with `~/.zshrc`, and agent X is
  spawned before A's next check. X's baseline then holds the tampered bytes. This is not a lineage
  path. Machine-wide, write-once baselines per real path would close it, at the cost of a wider
  false-quarantine blast radius. That is a follow-up and an owner decision.
- **A broker restart** forgets every principal. A running agent is re-admitted on its first
  contact (TP-4341) through `readmit`. The supervisor checks its launch files against what a broker
  writes. Intact files enrol it under its recorded lineage, with the nonce its hook still sends.
  Anything else latches a quarantine. Until then, its `--integrity` calls deny with `no baseline`.
  A quarantine latched before the restart survives it. Each latch writes a durable
  `integrity_quarantine` notice as `agent-chat`. `readmit` latches again when such a notice for
  the agent is newer than its last human resume, which the human's own `agent_resumed` row marks
  with `integrity_cleared: human`. Other resumes do not clear. A change made while no broker
  watched is lost. The re-admit checks the shape of the guard, not every byte of `settings.json`
  and `mcp.json`, so an extra key added then passes. It cannot catch a startup file that changed
  before the restart. An unarmed guard is a one-time migration. The first broker start with
  `INTEGRITY_MODE` `shadow` or `enforce` writes one `integrity_wired_since` notice to the event
  store, and later starts never move it. An unarmed launch is re-admitted, with no nonce, only while all four
  launch files have mtime and ctime before that mark. One changed at or after it had its nonce
  stripped, and latches `unarmed since wiring`. ctime is the half `touch -d` cannot set back. For
  the order to follow, see the restart notes in `docs/agent-teams.md` §4.5.
- **The rollout mode** (TP-4347) is the compile-time `INTEGRITY_MODE` in
  `src/broker/integrity-wired.ts`, never config. `off` writes launches unarmed and admits nothing.
  `shadow` arms launches and runs the ledger in full, but refuses nothing: each refusal `enforce`
  would make (spawn, resume, teleport, mode switch, relaunch, hook verdict) is one
  `integrity_would_deny` notice as `agent-chat`, at most one per agent, call site and reason per
  broker start. A shadow latch files no owner notice, and the hook and `run-agent` allow even
  when the broker cannot be reached. `enforce` refuses.

### Config the guard cannot read (TP-630)

A `-c` or `--config-env` word that the shell expands in a way the guard cannot tell (`$(cat k)`,
a backtick substitution, an unset `$K`, `--config-env=include.path=$E`) may hold `include.path`
or `core.hooksPath`. The guard denies it when the subcommand runs a client hook: `am`, `bisect`,
`checkout`, `cherry-pick`, `clone`, `commit`, `fetch`, `gc`, `hook`, `maintenance`, `merge`,
`pull`, `push`, `rebase`, `receive-pack`, `revert`, `stash`, `switch` and `worktree`. It also
denies when the subcommand is not a git builtin, so it may be an alias, or when it cannot be told.
A word the shell expands into other words counts as unreadable too: a glob character (`?`, `*`,
`[`), a brace form (`{a,b}`, `{a..b}`) or a `$'...'` escape the guard does not decode, such as
`git -c {core.hooksPath=/dev/null,-p} push` or `git -c core.hooks?ath=x push`. The same characters
inside single or double quotes are literal and stay allowed, as in `git -c 'core.pager=less *' log`.
This covers the separated (`-c <value>`, `--config-env <value>`) and attached (`-c<value>`,
`--config-env=<value>`) forms.

A non-literal word on any other builtin, as in `git -c "$X" log`, was allowed here, since those
commands run no hook. TP-636 above denies it, because the word may set a pager that runs a push.
A literal key with a non-literal value, as in `git -c user.name="$(whoami)" push`, is allowed,
since the key alone decides what the setting does, unless the key runs a program (TP-636).
`git -c user.name=x push` and `git -c core.pager=less log` stay allowed.

An unquoted expansion in the value of `-C`, `--git-dir`, `--work-tree`, `--namespace` or
`--super-prefix` counts as an unreadable config word too, since the shell may split it into
`-c core.hooksPath=...` words. So `for r in a b; do git -C ~/projects/$r worktree list; done`
is denied, although `worktree list` runs no hook: `worktree` runs `post-checkout` for `add`, and
the guard gates by subcommand. It also does not track the value a line gives a variable, so
`r=x` or a `for` list of literal words leaves `$r` unknown. This is intended (checked
2026-10-02, CC-479). Quote the expansion, as in `git -C ~/projects/"$r" worktree list` or
`git -C "$HOME/projects/$r"`: a quoted expansion stays one word and is allowed.

The deny does not depend on the subcommand. The split words may hold `-c core.hooksPath=...`
and the subcommand after them, so the visible one cannot be trusted: with
`r='x -c core.hooksPath=/dev/null push origin'`, `git -C $r log` is denied although `log` runs no
hook, and so is `git -C ~/projects/$r rev-parse` (CC-484).

Before the subcommand, and in the value of `-c`, `--config-env`, `-C`, `--git-dir` and
`--work-tree`, the guard allows only a literal word or one double-quoted word whose expansions are
plain `$NAME` or `${NAME}`. It treats `$@`, `$*`, `${a[@]}`, zsh `${=v}` and `$=v`, brace lists,
globs and any unquoted expansion as possibly splitting. So `git -C $PWD status` and `d=/tmp/x; git
-C $d status` are denied too: quote the value, as in `git -C "$PWD" status`.

### A `gh api` read with a quoted expansion is allowed

`gh api "repos/o/r/commits/$SHA/check-runs" --jq .check_runs` is allowed although the guard cannot
resolve `SHA`, because nothing in it can be a write. The call must hold exactly one endpoint, quoted
so the shell keeps it one word, and anchored: its literal prefix must be `repos/`, `orgs/` or `users/`
(with or without a leading `/`) plus the first segment and a `/`, such as `repos/HJewkes/`, with no
expansion before that point. So `"repos/$OWNER_REPO/commits"` is denied, because the literal stops
before the owner segment, and so is an endpoint that holds `://`, starts with a scheme, `//` or a
host, or names `graphql`, which gh POSTs. A header value that starts with `-` is denied.

Every flag must be on the allowlist: `--paginate`, `--slurp`, `--silent`, `-i`, `--include`,
`--verbose`, and `-H`, `--header`, `--hostname`, `--cache` and `-p`, `--preview` with a literal value
(a header that names a method or override is denied). Only the value of `--jq`, `-q`, `--template`
or `-t` may be an expansion. Any `-X`, `--method`, `-f`, `-F`, `--field`, `--raw-field` or `--input`,
in any spelling, any other flag, or a second positional word, keeps the deny. An unquoted expansion
gets its own message: quote the endpoint, or post a write with `agent-chat gh-write`.

The environment decides where gh sends the call, and the guard cannot read it, so the line must
hold nothing else: only `gh api` calls and assignments whose values are literal, joined by `;` or a
newline. A pipe, a redirect, `&&`, a subshell, `$(...)` or another command, such as `declare`,
`typeset`, `read`, `export`, `env`, `set`, `eval` or `source`, is denied, as is an assignment from an
expansion. `GH_HOST=github.com gh api "repos/o/r/commits/$SHA/check-runs"` is allowed. Such a call
may go only to `github.com`: a literal `--hostname` or `GH_HOST` for another host, and any
`HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` setting, is denied. The deny says to put the value in
literally, or to run the call alone on its line.

A gh config can name a socket that gh sends every request through: `http_unix_socket`. A probe
on 2026-10-11 and again on 2026-10-12 (gh 2.102.0, Linux, scratch dirs, `GH_TOKEN=invalid`) put
`http_unix_socket: <scratch>/nope.sock` in a config under `GH_CONFIG_DIR`, under
`XDG_CONFIG_HOME/gh` and under `HOME/.config/gh`. Each one rerouted `gh api /zen` to
`dial unix <scratch>/nope.sock: connect: no such file or directory`. macOS is UNVERIFIED. So any gh
`api`, `pr` or `issue` text call that sets `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` or `HOME` is denied (CC-733).
This applies to a prefix assignment and to an `env` operand. On a line with an unread `gh api` read, it
also applies to a standalone assignment. The one exception is a literal `NAME=value` whose value is the
hook's own value for that variable. An append, a subscript or an expansion is always denied. `env -u`
of these names is allowed: gh then falls back to its next default, not to a directory the command picks.

### The guard never reads one file while the shell posts another

For a `gh pr` or `gh issue` `create`, `new`, `edit`, `comment`, `review` or `merge`, and for every
`gh api` call, the guard works out each argument the way the shell will. When it cannot be sure of
one, it denies the command as text it could not read. It reads a body file only when the file is a
regular file, so a FIFO, a device or a directory is a deny.

An argument is sure when it is literal, or when each expansion in it is one of these:

- `$NAME` or `${NAME}`, taken from the hook's own environment. The name must have a value that is
  one word: not empty, no blanks, no glob characters. `--body-file "$TMPDIR/pr.md"` is read and
  scanned.
- a leading `~`, which follows `HOME` under the same rules.
- `"$(cat file)"`, ``"`cat file`"`` or `"$(cat <<'EOF' ... EOF)"` in double quotes: one `cat`
  with no options. The file's content takes the place of the substitution and is scanned as part
  of the title, body or field.

A name is unknown when the command line mentions it anywhere outside `$NAME` and `${NAME}`. That
covers `NAME=`, `export`, `read`, `for`, `printf -v`, `unset` and `${NAME:=x}` without a list of
the commands that assign. Quotes and backslashes are dropped before the name is looked for, so
`TMP""DIR=x` counts as a mention of `TMPDIR`. `PWD`, `OLDPWD`, `SHLVL`, `_` and `IFS` are never expanded, because the
shell sets them itself. `$NAME:h` and `$NAME[1]` are a zsh modifier and subscript, and are unknown.

Everything else is unknown: `$(...)` and backticks that are not the `cat` form above, an unquoted
substitution, `${VAR:-x}`, `~user`, a glob, a brace expansion, `<(...)`, zsh's `=command`,
`name(qualifier)` and `<1-9>`, and an ANSI-C escape the splitter does not decode. It decodes
the named escapes (`\n`, `\t`, `\e` and the rest), `\xHH`, octal `\NNN`, `\uHHHH` and
`\UHHHHHHHH` (TP-721); `\cX` and a NUL stay unknown. gh's own `{owner}`, `{repo}` and `{branch}` are not brace expansions and pass as written.
A `gh` whose group or verb is an expansion (`gh pr $V`) is unknown even when the value is known,
because the guard picks the flags to read from the literal subcommand.

**Exception for `gh-write` (CC-678).** A bare `agent-chat gh-write` does not get this deny for an
argument the guard cannot resolve: `gh-write` scans the text itself before gh starts. The mode
applies only when all of these hold, and a plain `gh` post never gets it:

- the command word is exactly `agent-chat`: not `/tmp/agent-chat`, `./agent-chat`, `command
agent-chat`, `env agent-chat`, a prefix assignment, `env -S`, or an expansion (`$E agent-chat`);
- `realpath` of the first `agent-chat` on the hook's `PATH` is the hook's own entry script, and
  every `PATH` entry before it is absolute;
- the hook knows the environment at that command, `PATH` is not mentioned anywhere on the line,
  and the command is at the top level, not inside a function, group or subshell;
- every command before it, including one inside `$(...)` and one inside an enclosing `sh -c`,
  `bash -c` or `dash -c` that has no flag or variable on it, is `cat`, `printf` without `-v`,
  `echo` or `tee`, with no variable on it and words the guard can resolve. Anything else keeps
  the deny: `cd`, `git`, an assignment, a function definition, `hash`, `builtin`, `autoload`,
  `alias`, `export`, `declare`, `read`, `eval`, `source`, zsh or ksh as a shell (`zsh -c` reads
  `.zshenv`), a shell with a startup flag or variable, or any other program;
- the gh-write has at most one body source: one of `-F`, `--body-file`, `--input` or `body=@file`,
  or stdin, never two;
- the earlier commands write at most one file, which is a literal `.md` or `.txt` path with no
  symlink in any component, no `.git` directory above it, and that is neither the install, a file
  in the `PATH` directory that holds it, nor a hard link to it. A `>` or `>>` or `tee` to any other
  file, a target that is not a literal, a `&>` or `>&file`, or a redirect on the `agent-chat`
  command to anything but `/dev/null` keeps the deny. Redirects to `/dev/null` and descriptor
  copies such as `2>&1` stay allowed. A path under a symlinked directory, such as `/tmp` on macOS,
  keeps the deny; write the body under the working directory.

A reviewer's working directory under `$TMPDIR` reaches the hook through `/var/folders`, a symlink on
macOS, so even a relative body path there keeps the deny: write the file in one Bash call and post it in the next.

In that mode the guard still scans the text it can read, and still denies a finding, a missing
term list and an unreadable term list, even beside text it cannot read.

### A body file written on the line that posts it (CC-371)

A Bash line that writes a PR or issue body file and then posts it is denied. The guard cannot
scan a body that does not exist yet when it checks the line. The body file is the
`--body-file`, `--body-file=` or `-F` file of `gh pr` or `gh issue`, or the `-F key=@file` or
`--input` file of `gh api`. The line is denied when an earlier command, or a redirect on the
`gh` command itself:

- redirects to the file (`>`, `>>`, `>|`, `<>`) or lists it for `tee`;
- names it as an argument, or as the value after an `=` (`cp`, `mv`, `install`, `ln`, `sed -i`,
  `dd of=`, `curl -o`, `--output=`);
- holds its path as text in a word or a heredoc, as `sh -c 'echo hi > b.md'` and
  `python3 -c "open('b.md', 'w')"` do.

`cat > b.md <<'EOF' ... EOF; gh pr create --body-file b.md` is an example. A redirect target the
guard cannot resolve counts as a possible match. A write inside `$(...)` is seen. Pass the text
as a quoted heredoc instead, which the guard reads as it stands and gh-write scans again when it
runs (CC-887), or write the file in one Bash call and post it in the next:

```sh
agent-chat gh-write -- pr create -R o/r -t 'Title' --body-file - <<'EOF'
...
EOF
```

A body file that exists before the line and is not named by it, or one written on another line,
is read and scanned as before.

With `gh-write` in the mode above, this line is allowed instead: the post goes through
`gh-write`, which reads the body file after the line has written it and refuses on a finding
before gh starts. Plain `gh` and every other spelling of `agent-chat` keep the deny.

The check is by name, so the remaining gaps are a writer that builds the path at run time
(`python3 -c "open('b' + '.md', 'w')"`), a script that already sits on disk, and a body file that
is a symlink or hard link to a file the line wrote under another name.

### Text on stdin

`--body-file -`, `--input -` and `-F field=@-` read stdin. The guard scans that text only when it
has exactly one source that it has read: one heredoc or one here-string on descriptor 0 of the
`gh` command itself. Every other case is a deny:

- a pipe into the command, alone or with a heredoc. zsh feeds gh the pipe and then the heredoc;
  bash feeds it the heredoc only.
- a heredoc or here-string on another descriptor, such as `3<<'EOF'`, which leaves stdin as it was.
- any input redirect with a descriptor of two or more digits, such as `12< file`. bash reads
  descriptor 12; zsh reads the word `12` and a redirect of stdin.
- two heredocs or here-strings on one command. zsh posts both and bash the last.
- any redirect of descriptor 0, with or without a heredoc: `< file`, `<&3`, `0<&3`, `0<> file` and
  `0>&3`. bash takes `0>&3` for a copy of descriptor 3 onto stdin, so after `3< file 0>&3` gh reads
  the file and not the heredoc. zsh refuses that copy and runs nothing.
- a heredoc with an unquoted delimiter whose body holds a `$`, a backtick or a backslash. The
  shell expands the first two, and a backslash joins two lines or escapes a character. Quote the
  delimiter: `<<'EOF'`.
- a here-string the shell expands.
- inside `$(...)` or backticks, a heredoc with a line that ends in a backslash, even under a
  quoted delimiter. bash 3.2, which is `/bin/bash` on macOS, joins that line to the next. This
  covers `--body "$(cat <<'EOF' ... EOF)"`.
- a backtick substitution that holds a backslash. The shell rewrites `\\`, `\$` and a backslash
  before a newline inside backticks before it parses them. Use `$(...)`.

With `gh-write` in the mode described under "The guard never reads one file while the shell posts
another", stdin the guard cannot attribute is allowed: `gh-write` reads stdin once, scans it and
hands gh a copy. A source the guard did read is still scanned and still denied on a finding.

The two heredoc denies that a backslash causes say so: the message names the backslash and asks
for a body file. Every other deny in this list uses the general "could not be read" message.

`src/__tests__/leak-pretool-shells.test.ts` runs these through the guard and then through zsh and
bash with a fake `gh` that records what it is given. It asserts that no shell posts the term
when the guard allows the command.

A relative body file is read from the directory the shell will be in. The guard follows only a
plain `cd <dir>`: at the top level, one argument that is sure, no option, joined by `;`, a newline
or `&&`. A `cd` after `&&` is trusted only until that `&&` list ends, since it may not have run.
After any other command that may move the shell, the directory is unknown and a relative body
file is a deny: a `cd` in parentheses, in a pipeline, in the background, after `||`, inside `if`
or a loop, with no argument, with an option, with `..` after a name, or a relative `cd` while
`CDPATH` is set or mentioned; `pushd`, `popd`, `chdir`; and `env -C`. After `eval`, `source`, `.`,
a function definition, `alias`, `trap`, `setopt`, `shopt`, `emulate`, a `set` beyond `-euxo
pipefail`, or a command whose name is itself an unknown expansion, the directory and every
variable are unknown.

The cost is that ordinary dynamic arguments are denied too: `gh pr comment "$PR" --body x` with
`PR` set on the same command line, `--body "$(git log -1)"` and `-f sha="$(git rev-parse HEAD)"`.
Write the value into the command, or the text into a file at a literal path.

### A command word that is an expansion

When the guard cannot resolve the command word, as in `$E gh pr create ...` or `$(true) gh ...`,
it checks the words after it twice: as the arguments of git or gh, and as a command of their own,
because the expansion may be empty or may be a wrapper. For that second check it trusts neither
the directory nor any variable. A literal title or body and a body file at a literal absolute
path are scanned; a relative body file or a `$VAR` in an argument is a deny.

Two cases of this check are denied outright, so the check stays fast (CC-347):

- more than 64 command starts after expanded command words across one command line, nested
  shells included, on a line that may reach git or gh. A command start is a later word that may
  begin a command: an expansion, a wrapper, an assignment, a shell keyword, or `git`, `gh` and
  the other names the guard reads. A line may reach git or gh when it names either one anywhere,
  holds a command substitution or any `$'...'` string, a word that may expand to `git` or `gh`
  (as above, `g?` included), an expansion that hides its name or reads `$1`, `$@` and the like, a
  variable that the line mentions outside a `$` reference, or a word that names either one once
  the hook's env values are put in, so `"$A$B"` with `A=g` and `B=h` counts, or reads a variable
  whose hook env value would count, through any operator, as `${TOOL%x}` with `TOOL=gh` (CC-478). Since
  the arguments of a hidden git past the budget go unchecked, a line that names `push`,
  `--no-verify` or `--no-veri`, a word that may expand to one of them (`p?sh`), `hooksPath`,
  `include`, `alias` or `GIT_CONFIG` counts as reaching git too.
  A line past the budget that may reach neither, such as 40 joined
  `"$PY" "$SCRIPT" --out "$DIR"` commands, is allowed, and its starts past the budget go
  unchecked. An unchecked start can reach git only through a variable set where the guard cannot
  see, the accepted gap above;
- an `env -S` split behind another expansion, such as `$E env -S '$W -n 5 gh ...'`.

### Known false deny: eval beside git or gh

`eval` of text the guard cannot resolve is denied whenever the command line names `git` or `gh`
anywhere. That denies harmless lines: `eval "$(ssh-agent -s)"; git push` and
`eval "$(direnv export bash)"; gh pr view 12`. The rule is not narrowed, because the unread text
can itself be `git push --no-verify` or a gh write, and the guard cannot tell a name that only
appears in the next command from one that builds the text. Leave the `eval` out of a command
line that runs git or gh when the command does not need it.

One command is exempt from the missing-list refusal: the merge call,
`gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge`. The exemption holds only when the call's one
endpoint is exactly that path. A field, a header or a `--jq` value that holds the path does not
count. With no term list its fields are scanned with the generic rules only, and a finding still
denies it. A merge pushes nothing, so no pre-push refusal stands behind it, and refusing it would
stop every coordinator from merging. An unreadable term list still refuses the merge. `gh pr merge`
with a `--body` or `--subject` is not exempt; `gh pr merge` with neither posts no text and is
allowed.

The hook entry has a 15 second timeout. The guard never waits on a file, so a run that long is
already broken.

Claude Code fails open on a broken hook. Observed on Claude Code 2.1.285 in print mode, with a
`touch` command and three PreToolUse hooks on `Bash`: a hook that printed a deny stopped the
command; a hook that exited 1 with no output let it run; a hook still running at its timeout (2
seconds in the probe) let it run. So if the guard's entry is missing, or the guard crashes outside
its own error handling, or it passes the 15 seconds, the tool call goes ahead unchecked and the
agent sees no message. The guard's own handling covers a call it cannot parse, below. Interactive
mode and other versions are unverified.

A tool call the guard cannot parse is denied only when it mentions `git`, `gh` or `GIT_CONFIG`,
so a bug in the guard cannot block every command an agent runs.

Not covered, by design or by cost:

- a script file (`bash push.sh`, `make push`, an npm script), whose commands the guard never
  sees; its git still runs under the shim's `ext` pin (CC-1095);
- any other program that runs the command it is given and is not in the wrapper list above:
  `find -exec gh ...`, `parallel git ...`, `watch gh ...`. The guard
  reads the program's name, not gh's, and checks nothing;
- command text held in a variable and run by a shell: `C='gh pr create ...'; sh -c "$C"`. The
  guard reads a `sh -c` string as written and does not expand it. `eval "$C"` is denied only
  when the command line names `git` or `gh`, so text set in an earlier tool call gets through;
- a `sh -c` script that reads its arguments through `$0` to `$9` or `$*`, with or without xargs
  (CC-1201): `xargs sh -c 'git push origin $0'`, `xargs sh -c 'git push origin "$1"' _` and
  `sh -c 'git push origin $0' --no-verify` all pass. So do `xargs -I{} sh -c '{}'`, whose whole
  script is the replace word, and a bare `xargs sh -c`, whose script comes from stdin;
- a command word that is an expansion, when the group or verb after it is one too (`$G pr $V`);
- a `$(...)`, backtick or funsub in the body of a heredoc with an unquoted delimiter, as in
  `cat <<X`, a `$(git push --no-verify)` line and `X`. The shell runs it; the splitter reads the
  body as text (CC-1328);
- text in a place the guard does not scan: the query string of a `gh api` path
  (`'repos/o/r/issues/1/comments?body=<text>'`), and flag values other than the title, body and
  fields, such as `--head`, `--label` and `--milestone`;
- zsh with `BRACE_CCL` set in a startup file, which expands `{owner}` into single characters;
- a command word that zsh's `EXTENDED_GLOB` operators turn into git (`gi#t`, `^x`, `x~y`); a
  `git push` argument they may turn into `--no-verify` is denied (TP-4235). The
  option is off by default, and the splitter reads `#` as a literal character, so `gi#t` resolves
  to itself. Reading `#` as a glob would make every unquoted `fix#12` argument unreadable;
- a different `git` on a literal `PATH` (an unread one denies, CC-1236), `GIT_EXEC_PATH`, or `--exec-path`;
- pushing without git at all, for example over the GitHub API with `curl`;
- git called under a name the text guard cannot follow (CC-1641) is covered by the shim, not the
  text reading: a renamed sh copy, python, perl, awk or a `KSH` symlink running `g=gi; ${g}t push
--no-verify` still reaches the shim, which refuses `--no-verify`. Pinned as F1-F9 in
  `leak-shim-skip-rows.test.ts`;
- git reached without passing the shim, so `--no-verify` lands (open, CC-1645). Pinned as
  landing today in `leak-shim-skip-rows.test.ts`, describe "shim-skipping (CC-1645, flips in S3)":
  - D1-D11: an absolute `/usr/bin/git` inside `csh`, `sh -c "$(cat s)"` or `sh -c '…'`, `env -i`,
    a reset `PATH`, `command -p`, a `sudo` shell's secure path, the TP-4245 `eval` of `$G $P1 $P2`,
    `/usr/lib/git-core/git-push` and `/usr/lib/git-core/git`, a copy of `/usr/bin/git`, and a
    python subprocess given the absolute path;
  - T1-T7: a git or gh alias or config key that runs a shell command (`~/.aliases` sourced by
    `zsh -i`, a copied gh with a `!` alias, `p = !$X`, `diff.external`, `core.editor`), a
    `printf -v` subscript, python and perl with a reset env or `PATH`, and zsh's `| {sh}`.
    The planned fix is a run-time sandbox that binds the shim over every git binary (CC-1645 S2 and
    S3); the pinned assertions flip to refused then.
- text fed to a shell as its script (CC-1393, CC-1408), in two parts.

  Covered: a shell the guard knows (`bash`, `sh`, `zsh`, `dash`, `ksh`, `ash`; `SHELLS` in
  `src/leak-guard/pretool.ts`), or `source`/`.` of a stdin path, that reads its script from any
  stdin source in scope, on a line that may reach git or gh (as for command starts above). The
  guard reads the fed text as a script, or denies it (pipedScript) when it cannot read it:
  - `echo P | bash`, `sh`, `sh -s`, `zsh -f`, `|&`, and `sudo -n bash`; `printf` text as well;
  - `cat` and `tee` passed through in between: `echo P | cat | sh`, `echo P | tee /dev/null | bash`;
  - a quoted heredoc piped in (`cat <<'EOF' | bash`) and a here-string (`bash <<< 'P'`);
  - a `{ }` or `( )` group fed by the pipe: `echo P | { true; bash; }`, `echo P | (true; bash)`,
    a shell nested in subshell parentheses (`echo P | ( ( bash ) )`, `( ( bash <<< "P" ) )`),
    and a subshell on the feeding side, `(echo P; echo hi) | bash`;
  - a `-c` string that reads the feed: `echo P | bash -c 'cat | bash'`. A shell in a `-c` string
    reads the outer shell's own feed, too (`bash -c bash <<EOF` with an expansion in the body);
  - a heredoc the shell expands (`F=--no-verify; bash <<EOF`) and a `< file` redirect
    (`cat < push.sh | bash`, `bash < file`, `<file bash`), which the guard cannot read as written,
    so it denies even when the text is harmless; quoting the delimiter (`<<'EOF'`) avoids it for
    a heredoc;
  - an `exec` redirect anywhere on the line (`exec < file`, `exec 0<<<TEXT`, `exec <<E`,
    `exec 0<&3`), with any options or words after `exec`, also behind `time [-p]`, `noglob`,
    `nocorrect`, `command [--]`, `builtin`, an expanded command word or `eval` text holding `exec`;
  - a redirect on a group, subshell, loop, `if`, `case` or function definition
    (`{ bash; } <<E`, `( bash ) < file`, `while read -r l; do bash; done <<E`), and a call of a
    function the line defines, fed by a redirect or a pipe (`f() { bash; }; echo P | f`,
    `function f { bash; }; f < file`). The guard keeps no group bounds, so every command on the
    line that inherits its stdin is taken to read these;
  - `source` and `.` of `/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0` or an expanded path, and a
    shell whose script file is one of those paths (`bash /dev/stdin < file`);
  - `eval` of text the guard cannot read while stdin may carry text it cannot read
    (`while read -r l; do eval "$l"; done < file`);
  - every later shell on the line may read that text, so nested heredocs check it again at each
    level; past 64 such checks across the line, a line that may reach git or gh denies and any
    other line skips the rest.

  The cost is a few harmless lines denied (pipedScript) on a line that may reach git or gh: a
  shell given an expanded script path with such a feed
  (`while read -r f; do bash -n "$f"; done < list`), a shell reading stdin anywhere on a line
  that also feeds a group an unreadable redirect, and a heredoc whose body expands a variable
  the line itself assigns, fed to a shell (`N=3; bash <<EOF`, `echo $N`, `EOF`), since the
  guard does not substitute assigned values. Quoting the delimiter (`<<'EOF'`) avoids the last.

  A shell behind `setsid`, `flock`, `taskset`, `chrt`, `script -c` or `unshare` reads the feed
  as above (CC-1414): `echo P | setsid bash`, `echo P | flock f bash`, `echo P | script -qc bash f`.

  A shell in a process substitution reads what the command before it writes (CC-1416):
  `echo P > >(bash)`, `printf P > >(zsh)`, `echo P | tee >(sh) > /dev/null`, also inside a
  `$( )`. The guard keeps no bounds for a process substitution, so on a line that holds one,
  every command in parentheses or a substitution reads text the guard cannot read. That denies
  harmless text too (`echo hi > >(bash)`, and a subshell `( bash )` beside a process
  substitution), since a process substitution makes every line count as one that may reach git.
  `diff <(git show a:f) <(git show b:f)` and a process substitution running no shell stay
  allowed.

  A shell in a command substitution reads the stdin of the command it sits in (CC-1412):
  `echo P | $(bash)`, the backtick form, `echo P | $( (bash) )`, `echo P | $( $(bash) )` and
  `echo P | x=$(bash)`; real bash and dash run the push, while zsh runs a pipeline's last stage
  in the shell itself. When that command has a pipe, heredoc, here-string or redirect of its own,
  the substitution reads text the guard cannot read. This fails closed for a heredoc and a
  redirect too (`$(bash) <<< TEXT`), though shells open those only after the substitution ran.
  `x=$( (bash) ); git status` reads the line's own stdin and stays allowed.

  Not covered: a shell the feed reaches indirectly. Each is still allowed, and CC-1411 tracks
  them, with a CC-1408 follow-up for the shells outside the list:
  - a command word filled by `read`, which bash word-splits and runs as a command rather than
    as a shell (`read -r l <<< TEXT; $l`). A command word the guard cannot resolve that is fed
    text, such as `echo P | $b`, `echo P | ${SHELL:-bash}`, `echo P | $(echo bash)` or
    `while read -r l; do $l; done < file`, is read as a shell and denies (CC-1411, above);
  - a wrapper the guard does not know, such as `echo P | busybox setsid bash`;
  - a shell outside the guard's list (follow-up to CC-1408): `echo P | rbash`,
    `echo P | mksh`, `echo P | fish`;
  - a pipe from a command whose output the guard cannot read (`curl … | bash`), on a line that
    cannot reach git or gh.
  - more generally: any shell the feed reaches through a command word, wrapper or shell name the
    guard does not resolve is not covered, whether or not it is listed above.

- text written to a file and then run (`printf … > f; bash f`), CC-1399; and encoded text the
  guard cannot decode, such as printf escapes, `base64 -d` or `xxd -r` piped to a shell;
- a git alias whose lookup fails or takes over 1 s, that shadows an external `git-<name>`
  command on `PATH`, or that only a directory the guard cannot tell defines, behind a command word
  the line does not tie to git (`source ./env.sh; $x pnv` where the hook's directory has no `pnv`,
  TP-613, CC-1315);
- an untied command word whose subcommand is an expansion too, as in `env -C /x $X $Y`;
- a `!` alias body that reads its arguments other than as `$1` to `$9`, `$@` or `$*`;
- shell syntax the splitter misreads, such as `&>` or `case` patterns;
- a variable whose value in the Bash tool's shell differs from the hook's although the command
  line never mentions its name, for example one set in a shell startup file, or one assigned
  under a name built at run time (`typeset "${n}DIR=x"`);
- a function or alias named `gh`, which changes what a checked command runs;
- a gh alias whose body runs a script file, the script-file gap above; a gh extension that gh
  runs in place of a config alias of the same name, and a `gh <group> <word>` alias set on the same line by a write the guard does not read, or read from
  a config the line points gh at;
- gh commands other than those above that post text, such as `gh release create --notes`,
  `gh gist create` and `gh pr close --comment`;
- a file that changes between the guard's read and gh's.

## The no-rewrite push policy (CC-1633)

Every profile launches its agent with git pointed at a second guard dir, `<home>/git-hooks/no-rewrite`,
instead of `<home>/git-hooks`. Every profile in the repo's `profiles/` and every builtin sets
`"pushPolicy": "no-rewrite"` (CC-1649), and a profile that omits the field gets the same dir
(CC-1650), so a profile file in `~/.agent-chat/profiles/`, coordinators and seats included, fails
closed. A push that creates a new tag passes the policy, so coordinators still publish release
tags. Only `"pushPolicy": "scan-only"` keeps the shared dir, where the leak scan alone decides.
In-repo uses of `scan-only`, each with its reason:

| Profile | Reason |
| ------- | ------ |
| none    |        |

Its git shim dir is `<home>/git-hooks/git-bin`. Both sit under the
guard's hooks root, so the PreToolUse hook's protected path covers them. Remote launch selects
the same dir after `isPushPolicy` checks the carried field. No variable carries the policy: the
broker bakes it into that dir's `pre-push` at each spawn, so nothing in the agent's environment
switches it off.

**Only the pre-push hook decides.** git hands it the ref updates it is about to make, after `-c`
and `--config-env` options, config includes, `HOME` and `XDG_CONFIG_HOME`, `push.default`,
refspec patterns, aliases and the dashed `git-push` name have all been resolved. The hook refuses
the whole push when any update:

- deletes a ref (an all-zero local sha), which includes a plain `--prune` deletion (observed on
  git 2.53);
- updates `refs/heads/main` or `refs/heads/master`;
- names a remote ref outside `refs/heads/` and `refs/tags/`;
- is not a fast-forward of the remote's tip, or its tip is not in the repository to check.

It reads ancestry in a view of the repository's objects alone, with no replace refs, grafts or
commit-graph, so the agent's repository state cannot fake a fast-forward. git leaves a mirror's
deletions off the hook's input (observed on git 2.53). So the hook also reads
`remote.<name>.mirror` with git's own env, which carries the push's `-c` options, includes and
`HOME`, and refuses a mirror remote or a read that fails. A typed `--mirror` sets no config, but
it pushes the local `refs/remotes/*` refs every clone holds, and the namespace check refuses those.

The no-rewrite dir's git shim refuses a push whose resolved `core.hooksPath` is not that dir,
the same equality check as for the shared dir; as there, a push whose every destination is a
local path is let through. The PreToolUse hook has no push-policy rule of its own. It keeps its
hook-integrity rules (`--no-verify`, `core.hooksPath`, `GIT_CONFIG_*`, aliases, and refusing what
it cannot resolve), and it reads a dashed builtin such as `$(git --exec-path)/git-push` as
`git push`.

**Review boundary.** The policy is as strong as "the guard's hooks dir runs, and it is the
no-rewrite dir". These routes defeat that, defeat the leak scan too, and are out of scope here:

- GIT_CONFIG_* hook-path integrity: rewriting `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` or
  `GIT_CONFIG_VALUE_0` with `read`, `for`, `printf -v`, `getopts`, `mapfile` or `let` (on main
  for the leak scan as well), and `exec -c git push`, which clears the env;
- the `--no-verify` spellings CC-1284 to CC-1287 track;
- `git send-pack` and `git http-push`, which run no pre-push hook, and `gh api` ref writes
  (CC-1636);
- a `--mirror` push after the agent has deleted every non-branch, non-tag local ref, since git
  hides mirror deletions from the hook.

The only layer no agent input reaches is the server. One GitHub ruleset on `~ALL` branches, with
"restrict deletions" and "block force pushes" and an empty bypass list, closes every row above.
That is an owner ruleset write. The profile `disallowedTools` push rules remain a literal-text
backstop.

### Incident: a broker restarted from an agent session (CC-1653)

On 2026-10-26 the broker was restarted by `scripts/restart-window.sh` run from an agent session.
The new broker inherited that session's PATH, which began with the shared shim dir `git-bin` and
a gh shim dir. Each spawn then wrote the no-rewrite shim `git-hooks/git-bin/git` with the first
`git` on the broker's PATH as its real git, which was the shared shim. On every push the shared
shim saw `core.hooksPath` set to `git-hooks/no-rewrite`, not its own guard `git-hooks`, and
refused with `git-shim: push refused (hooks-path)`. No agent spawned after the restart could push.

Three layers now close it:

- `findRealGit` skips any `git` whose first 512 bytes carry the `# Written by agent-chat`
  header, so no shim, wherever it sits, is baked as another's real git.
- Every broker start (`agent-chat broker`, which the detached start and each auto-start run)
  drops each PATH entry holding an agent-chat `git` or `gh` shim, from the inherited PATH, the
  override and the recorded login PATH. It also drops `AGENT_CHAT_GIT_SHIM_DIR`, a
  `GIT_EXEC_PATH` at a shim's mirror and the `core.hooksPath` `GIT_CONFIG_*` pair. Each launch
  puts its own shims and env back.
- `restart-window.sh` refuses when `AGENT_CHAT_NAME` is set or an agent-chat shim is on PATH.
  Run it from the owner's terminal, or with the user manager's clean env:
  `systemd-run --user --wait --pipe <checkout>/scripts/restart-window.sh`.

The shim file is shared by every no-rewrite agent, so the next spawn after a clean restart
rewrites it for all of them, including agents already running.

## Owner override and its trust limit

The owner's override today is a `git push` from their own shell. That shell carries no
`GIT_CONFIG_*` variables, runs no guard hook and has no PreToolUse hook. There is no way yet to
let one flagged line through for an agent. The plan's `agent-chat leak-allow` verb, with a
fingerprint the pre-push scan skips, is on hold: egress-scan's findings carry no fingerprint,
its only allow file is `.egress-allow` inside the repository, which an agent can write, and it
never allows a `private-term` finding.

The trust boundary is the OS account, not this guard. Any process running as the owner can edit
the hook directory, the term list or a settings file, as it could forge any other local frame.
The guard denies the ordinary routes to those files for agents. The pushed history and PR text
remain the record of anything that got through.

## Fail-open of the PreToolUse hook (CC-371)

The hook allows a call it cannot decide only when it crashes on input that does not mention git
or gh. A crash on a call that mentions git or gh is a deny, not a fail-open. That holds for a
crash in the worker thread that runs the decision, such as a worker that does not start, as well
as for one inside the decision. The owner accepts that fail-open, and it writes exactly one line
to `leak-guard.log` in the agent-chat home:

```
<ISO time> leak-guard pretool fail-open: crash (<error class>)
```

The line never holds the command. A log that cannot be written does not change the allow.

### The deadline fails closed (CC-1407)

A check that runs past the hook's 12 s deadline is a deny, whatever the call, and writes no log
line. The reason tells the agent to split the command into smaller Bash calls. Until CC-1407 the
hook allowed such a call, so a line padded with a large backtick or `$(...)` body could outrun
the check and carry `git push --no-verify` into a real shell.

The decision runs in a worker thread, so the deadline timer on the main thread fires even while
the worker is inside a long synchronous parse. The hook then stops the worker. The deadline sits
under the 15 s that the hook settings give Claude Code, which would kill the hook without a word.
A 500 KB padded line is denied in about 12.4 s, node start-up included.

## The push-time git shim (TP-596)

The PreToolUse guard reads the Bash command line, so it never sees a push that a script file,
`make` or an npm script runs. The pre-push hook cannot refuse a push that skips it. So every
spawned agent also runs a `git` shim, which checks each push when it happens.

At each spawn, `launch-files.ts` writes `git-bin/git` in the agent-chat home, beside the guard's
`git-hooks`. The plan names that directory in `AGENT_CHAT_GIT_SHIM_DIR`. The `AGENT_CHAT_` prefix
is reserved, so a profile's `env` cannot set or move it. `run-agent` puts the directory first
on the launched process's PATH, after the plan's own PATH is applied, so a profile PATH cannot
push it down. It comes ahead of the gh shim's directory: the two hold different names, and the
push guard should sit ahead of every other shim. Only a plan that sets the guard's hooks path
carries the variable. The owner's shell and the owner's own Claude sessions never see it.

The shim is a `sh -p` script with the real git's absolute path baked in. That path is the first
`git` on the broker's PATH whose realpath is not the shim and whose first 512 bytes do not carry
the `# Written by agent-chat` header, so the shim never calls itself or another agent-chat shim.
The path is not resolved further, so a package-manager upgrade does not strand it. The shim
skips git's global options (`-C`, `-c`, `--git-dir` and the rest) to find the subcommand. The
word `push` is matched by name. Another word that is not a git builtin is looked up as
`alias.<word>`, through the real git with the same global options. The alias is split the way
git splits it, so quotes group words and a backslash escapes the next character, and expanded.
The shim fails closed. A push it cannot rule out is refused, never passed to git. A push is
refused with exit 2 and a line `git-shim: push refused (<rule>)` when:

| Rule          | When                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `no-verify`   | an argument after `push`, including one an alias supplies, starts with `--no-veri`                                                       |
| `hooks-path`  | `core.hooksPath`, as the real git resolves it with the same options, is not the guard, and a destination is not local (below)            |
| `shell-alias` | the word is a listed `!` alias, and its text or the arguments after it mention `push` other than as `stash push`, quotes aside           |
| `unresolved`  | the alias read fails for a reason other than "no such key", or the alias has an open quote                                               |
| `alias-depth` | aliases chain more than 10 deep                                                                                                          |
| `autocorrect` | the word is no builtin, alias or `git-<word>` command, and `help.autocorrect` is not unset, `0`, `false`, `off`, `no`, `show` or `never` |

A `!` alias whose name is not on the shell alias allowlist is refused before it runs, push or
not, with exit 2 and a line `git-shim: refused (shell-alias)` (CC-613). Inside a `!` alias git
puts its exec-path first on PATH. That is the shim's mirror (TP-4249), so the body's own `git` by
name is the shim, but a body can still run git by path and build
`push` in more ways than any check can see (`echo hsup | rev | xargs -I% git %`, a `tr` or
`base64 | sh` pipeline, a variable from the environment). So only named aliases run. The allowlist is `gitShellAliases` in `~/.agent-chat/config.json`,
an array of alias names, and the edit is the owner's. Without it the list is empty and every
`!` alias is refused for agents. A value that is not an array lists nothing, and an entry that
is not an alias name is dropped; both log `config_invalid`. The list is baked into the shim at
spawn, so a change applies to an agent's next spawn or resume, not to one already running. Names
match exactly and in lowercase: `git HI` finds `alias.hi`, but the shim refuses it. In a chain
the name checked is the `!` alias the chain reaches, not the word typed. A listed alias keeps
the rule in the table and the argument checks below. The list holds names, not alias text, so
a listed alias whose text is changed runs the new text.

A listed name runs only the text that the agent's own config files give it: the system
config, the global config under the `HOME` and `XDG_CONFIG_HOME` the shim was written with,
and the repository's config. The shim refuses it with `git-shim: refused (shell-alias)` when
git reports any value of `alias.<name>` from the command line. That covers `-c`,
`--config-env`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`, in any case of the key. The
shim also refuses it when the text differs from a second read that drops `-c` and
`--config-env`, unsets `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM`, and puts back the `HOME` and
`XDG_CONFIG_HOME` baked at spawn. That covers a `-c include.path` that pulls in another file
and a per-call swap of the global or system config file. A `-c` of an unrelated key, such as
`-c user.name=x`, does not stop a listed alias (CC-613 d). Every config read the shim makes
runs with `GIT_CONFIG` unset, because `git config` then reads only that file while git ignores
it when it runs an alias or a push. The shim puts `GIT_CONFIG` back for the git it finally
runs, so the agent's own `GIT_CONFIG=<file> git config` still reads that file.

The repository is not pinned. `-C`, `--git-dir`, `GIT_DIR` and `GIT_COMMON_DIR` choose a
repository the way `cd` does, and its config counts as a config file. Like an edit to
`.git/config`, a repository the agent writes can still give a listed name new text; only
baking each listed alias's text at spawn would close that.

git appends the arguments to a listed `!` alias's shell command, which can read them in more ways than
any list covers (`$1`, `"$@"`, `for a;`, `$0` under a nested `sh -c`, `shift`, `getopts`). So
`shell-alias` also refuses a `!` alias whenever its arguments mention `push` in any case, `stash
push` included, after removing quotes and blanks, so `pu sh` split across two arguments counts
(CC-479). It refuses, too, when the arguments hold a backslash, which the body may decode
(`printf "$1"` over `\x70ush`), or a glob character `?`, `*` or `[`, which the body may expand
into `push` (`p?sh` beside a file named `push`). The accepted cost is a false refusal such as `git st push` for `st = !git
stash`; run the command the alias stands for instead.

Every text filter in the shim (`tr`, `sed`) runs under `LC_ALL=C`, so a byte that is not valid
UTF-8, such as `0xff`, is read as a byte and cannot make a filter fail and blank a check
(CC-612). A filter that still fails never lets a check pass. In the alias checks it refuses
with `unresolved`. In the destination check it leaves the push not known to be local, so the
push keeps the hooks-path rule and a refusal says `hooks-path`, not `unresolved`.

The builtin list is read from the real git at each spawn. If that read fails, the shim reads it
on each call instead, and `push` is still matched by name.

The `autocorrect` rule exists because git corrects a mistyped word, such as `pusj`, into the
command it resembles, and with `help.autocorrect` on it runs that command without the shim
seeing it. The shim reads the value through the real git with the same options. It passes only
the values git documents as not running the correction, so an unknown or new spelling refuses.
The rule refuses rather than adding `-c help.autocorrect=never` to the command. An override's
effect depends on how `-c`, `--config-env` and the `GIT_CONFIG_*` variables rank against each
other, and a ranking it gets wrong would fail open. A read of the value git will use cannot.
When autocorrect is on, a mistyped word is refused even when its correction is not a push.

The hooks-path rule is what covers `GIT_CONFIG_COUNT=0`, `-c core.hooksPath=...`,
and `GIT_CONFIG_PARAMETERS`. agent-chat's own injected hooks path
is exactly the guard directory, so it passes.

A push whose every destination is a local repository skips the hooks-path rule (CC-442), so
test fixtures that strip the injected hooks path can push to a temp-dir remote. The shim
resolves destinations the way git does: the repository word, `--repo`, or the branch's push
remote, `remote.pushDefault`, the branch's remote and then `origin`; a remote's `pushurl`
values, else its `url` values, else the word itself; and every `insteadOf` and
`pushInsteadOf` rewrite of each. Each must be a `file://` URL or a path, meaning a slash
comes before any colon, which is git's own `url_is_local_not_ssh` test. A `<transport>::`
helper, any other URL and `host:path` fail it. So do `remote.<name>.vcs` or `.receivepack`,
a legacy `remotes/` or `branches/` file, `--receive-pack`, `--exec`, submodule pushes, an
option the shim does not know, and any value it cannot read; those pushes keep the rule.
`--no-verify` stays refused for every destination. A path on a network or sync mount counts as
local, and the destination repository's own hooks run on the push.

Every other command, and a push that passes,
`exec`s the real git with the arguments unchanged, so its exit code, stdout and stderr are git's.
A builtin costs one `sh` start. An alias costs one `git config` read, a push one more, and a word
that is no alias up to two more for `help.autocorrect`.

Before any of that, the shim pins `ext` off (CC-1095) for every git it runs, a `!` alias body
included. git reads `GIT_ALLOW_PROTOCOL` over `protocol.*.allow` in every config scope, so the shim
no longer exports it for a caller who did not set it (CC-1336): that widened a caller's own `-c
protocol.allow=never`, a global deny, or a clone template's or submodule's. It unsets the variable
when it is unset or exactly `file:git:http:https:ssh`, the list `agentEnv` and the launch plan
still write. Any other value is the caller's and is cut down to that list; an empty one stays
empty, which git reads as no transport. Then the shim appends `protocol.ext.allow=never` as the
last `GIT_CONFIG_COUNT` pair, unless it already is the last one. A count that is not a number, or
a key or value unset below it, refuses with exit 2 and `git-shim: refused (config-count)`.

That pair is command scope, which git ranks over every config file and include, and a protocol's
own key beats `protocol.allow`. So a repository or global `protocol.ext.allow=always` or
`protocol.allow=always` with an `ext::` remote, or `-c remote.<name>.vcs=ext`, fails with
`transport 'ext' not allowed`, in a submodule child too. git resolves every other protocol from
the config it reads at fetch time, so the shim reads none of it. Only `-c`, `--config-env` and
`GIT_CONFIG_PARAMETERS` rank after the pair, so before it execs, the shim reads
`protocol.ext.allow` under the caller's `-c` and `--config-env` options and refuses with exit 2
and `git-shim: refused (ext-transport)` unless the last value is `never`, when a command-line
`include.path` or `includeIf.*.path` is set (git evaluates its condition here, not in a repo the
command creates), or when a read fails. That costs two `git config` starts a call. The shim also
refuses `git remote-ext`, and an alias that expands to it, the same way, because that helper runs
its argument as a shell command without the transport check.

With no list exported, git's defaults apply, which changed two cases (CC-1607):

- a `file://` or local-path submodule clone follows `protocol.file.allow=user`, which a submodule
  child denies (CVE-2022-39253); a fixture that needs one passes `-c protocol.file.allow=always`;
- a remote helper such as `persistent-https::` or `gcrypt::` follows `user`: it runs when the
  agent names it, which could run the helper anyway, and is denied in a submodule.

`pinGitProtocols` in `src/git.ts` still exports the list in every env agent-chat builds
(`agentEnv`, the launch plan, `gitChildEnv`, the burndown tick, worktree setup), so git run
outside the shim with that env is still widened until CC-1587. A real git that a shim-run git
starts (a hook, `rebase -x`) inherits no list, so its own `-c protocol.ext.allow=always` runs
`ext::`. That argv could set `GIT_ALLOW_PROTOCOL=ext` before with the same effect; CC-1095 covers
`ext::` from config or a URL, and that stays denied in every file scope.

Not covered:

- an absolute git path (`/usr/bin/git push`), or `env -i`, which drops the shim from PATH;
- `GIT_EXEC_PATH` set for a git run by path; a shim-run git restores the mirror, and the shim
  refuses `--exec-path=<dir>` for any dir but the mirror with `git-shim: refused (exec-path)`;
- `git send-pack`, which pushes refs without running the pre-push hook (observed through the shim
  with a local bare remote);
- a `git` that the agent puts ahead of the shim on its own PATH (the PreToolUse guard reads that
  command line);
- a git run by path inside a shell git starts for its hooks, `!` aliases and `rebase --exec`.
  By name it finds the mirror's shim (above), so `echo hsup | rev | xargs -I% git %` or
  `!git $P --no-verify origin main; true` run as `P=push git g` reach the shim. An unlisted `!`
  alias never runs, so only a listed one is in this class, through `/usr/bin/git` or a PATH
  reset in its body;
- a listed `!` alias whose text an agent replaces, since the allowlist holds names and not alias
  text. Editing `.git/config` directly is one source; `git -c alias.<name>=...` and the
  `GIT_CONFIG_*` variables, set inside a script the PreToolUse guard does not read, are others;
- an executable `git-<word>` on PATH or in git's exec-path: `git <word>` runs it unchecked, with
  the mirror first on PATH as for a `!` alias, so only a git it runs by path skips the shim;
- pushing without git.

The shim is live for an agent only after a broker restart picks up the
build. `src/__tests__/leak-git-shim.test.ts` runs every rule against real git and a bare remote;
`src/__tests__/leak-git-shim-protocol.test.ts` runs the protocol pin and the `remote-ext` refusal.
