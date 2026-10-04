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

If `node` or `titan-egress-scan` is missing from the broker's `PATH`, the hook prints one line
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
is the tip of the remote's default branch. The hook asks the push URL for it with
`git ls-remote <url> HEAD`, and fetches it into the scratch repository when it is not local.
Local remote-tracking refs are never used, because `git update-ref refs/remotes/origin/x <sha>`
writes one. This costs one more connection per push. A new ref pushed to a remote that names no
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
`nice`, `timeout`, `caffeinate`, `coproc`, zsh's `noglob`, `nocorrect` and `repeat <n>`, `if`/`then`
and other prefixes are stripped, is one of these. A wrapper is known by its base name, so
`/usr/bin/nice` is stripped like `nice`.

| Denied                                                                                                                 | Why                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `git push` with `--no-verify`, or its abbreviations `--no-veri` and `--no-verif`, anywhere before `--`                 | skips the pre-push hook                                   |
| `git -c` or `--config-env` on `core.hooksPath` or any `alias.*` key                                                    | command-line config beats the guard's environment         |
| `git -c` or `--config-env` on `include.path` or `includeIf.<cond>.path` whose file sets `core.hooksPath`               | an included file is command-line config too               |
| `git -c` or `--config-env` with a key or variable name the guard cannot read, before a hook-running subcommand (below) | an unread value may be `include.path` or `core.hooksPath` |
| a git word that may be an alias, on a line that writes git config (below)                                              | the alias lookup reads config before the line changes it  |
| a `GIT_CONFIG*` assignment, `export`, `export -n`, `unset`, `declare` or `env -u`                                      | removes or overrides the guard's `core.hooksPath`         |
| `env -i` or `env -`                                                                                                    | clears the environment, guard included                    |
| `git config` writing or unsetting `core.hooksPath`, or writing a value that holds `--no-verify`                        | a hooks path or alias in shared repo config               |
| any mention of the guard's hook directory or the private term list; an edit tool writing to either                     | rewriting the hook or emptying the term list              |
| `gh pr` or `gh issue` `create`, `edit`, `comment`, `review` or `merge` whose title or body has a finding               | the text is public the moment it is posted                |
| one of those commands, or `gh api`, with an argument or body file the guard cannot be sure of                          | the guard would scan one text and gh post another         |
| `gh api` whose `-f`, `-F` or `--input` values have a finding                                                           | the same text by another route                            |
| a command word that is an expansion, followed by the words of one of those gh commands                                 | `$G pr create` may run gh unscanned                       |
| a command word that is an expansion, followed by a command that any row above denies                                   | `$E gh pr create` runs gh when `E` is empty               |
| `eval` of text the guard cannot be sure of, on a command line that names `git` or `gh`                                 | the text may be a push or a gh command                    |
| a command git runs for its subcommand that a row above denies, or that the guard cannot read (below)                   | `git rebase -x` runs a shell command unseen               |
| `git -c` or `--config-env` on an include, or with a key the guard cannot read, before a command git runs (below)       | git passes it on to every git that command runs           |

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

The accepted gap is a command word set where the guard cannot see, such as a variable that a
sourced file or the Bash tool's shell set, after a `source`, `pushd` or `cd` the guard cannot
follow: `source ./env.sh; $x pnv` runs an alias unchecked when `env.sh` sets `x=git`. Denying it
would deny `$PYTHON -m pytest` and `$PAGER README` too, since the command string cannot tell
them apart, and a sourced file can run `git push --no-verify` itself anyway. A word that git
would not take as an alias name, one that starts with anything but a letter or holds anything
but letters, digits and `-`, is never looked up. `echo pnv | xargs git` still runs an alias
unchecked, because the subcommand comes from stdin.

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
heredoc fed to a shell. `agent-chat gh-write -- <gh args>` is checked like `gh`. A gh called by
path, such as `/opt/homebrew/bin/gh` or a `$GH` that expands to one, is denied outright: it skips the
agent's gh shim, and gh-write is the only write path (CC-456). `git push -n` is
`--dry-run`, which pushes nothing, so it is allowed. `git commit --no-verify` is allowed too:
it skips only the repository's own commit hooks, and the push is still scanned.

The PR pre-check runs egress-scan's rules on each line of the title, the body, a `--body-file`
or a heredoc passed as `--body-file -`. `gh pr merge` is checked like `create`: its `--subject`,
`--body` and `--body-file`. It reads the private term list from the default path only, never from
`TITAN_EGRESS_TERMS`, like the pre-push hook. A deny names `title line 1 private-term #3` or
`body line 4 home-path` and never the matched text. It also denies when it cannot check: a body
piped from another command, or a missing or unreadable term list while `MISSING_TERMS_REFUSES` is
set. An empty term list file counts as a list: the guard then checks the generic rules only and
refuses nothing for a missing list.

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
directory, and for `submodule foreach` in each submodule with variables git sets, so the guard
trusts neither the directory nor any variable inside it. git passes its `-c` and `--config-env`
options on to every git the command runs, and the command may write an include file before git
reads it. So an `include.path` or `includeIf.<cond>.path` on the outer git is a deny, whatever the
file holds, and so is a `-c` or `--config-env` word the guard cannot read. A command word the guard
cannot read, such as `-x "$(cat s)"`, is a deny for a literal `git` or an expansion tied to git.
`git rebase -i`, `git submodule update` and `git bisect start`, `good` and `bad` run no command and
are not affected.

Config values that name a program, such as `core.pager`, `core.sshCommand`, `sequence.editor` and
`diff.external`, are not read here (TP-636). Nor are git's own hooks, or an option whose name is an
expansion, as in `git rebase "$OPT" "<cmd>"` with `OPT` set on the line.

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

A non-literal word on any other builtin, as in `git -c "$X" log`, is allowed: the guard exists to
protect the pre-push scan, and those commands run no hook. A literal key with a non-literal value,
as in `git -c user.name="$(whoami)" push`, is allowed too, since the key alone decides what the
setting does. `git -c user.name=x push` and `git -c core.pager=less log` stay allowed.

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
guard cannot resolve counts as a possible match. A write inside `$(...)` is seen. Write the file
in one Bash call and post it in the next. A body file that exists before the line and is not
named by it, or one written on another line, is read and scanned as before.

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

- a script file (`bash push.sh`, `make push`, an npm script) or `xargs`, whose commands the guard
  never sees;
- any other program that runs the command it is given and is not in the wrapper list above:
  `find -exec gh ...`, `sudo gh ...`, `watch gh ...`, `script -q /dev/null gh ...`. The guard
  reads the program's name, not gh's, and checks nothing;
- command text held in a variable and run by a shell: `C='gh pr create ...'; sh -c "$C"`. The
  guard reads a `sh -c` string as written and does not expand it. `eval "$C"` is denied only
  when the command line names `git` or `gh`, so text set in an earlier tool call gets through;
- a command word that is an expansion, when the group or verb after it is one too (`$G pr $V`);
- text in a place the guard does not scan: the query string of a `gh api` path
  (`'repos/o/r/issues/1/comments?body=<text>'`), and flag values other than the title, body and
  fields, such as `--head`, `--label` and `--milestone`;
- zsh with `BRACE_CCL` set in a startup file, which expands `{owner}` into single characters;
- a command word that zsh's `EXTENDED_GLOB` operators turn into git (`gi#t`, `^x`, `x~y`). The
  option is off by default, and the splitter reads `#` as a literal character, so `gi#t` resolves
  to itself. Reading `#` as a glob would make every unquoted `fix#12` argument unreadable;
- a different `git` on `PATH`, `GIT_EXEC_PATH`, or `--exec-path`;
- pushing without git at all, for example over the GitHub API with `curl`;
- a git alias whose lookup fails or takes over 1 s, that shadows an external `git-<name>`
  command on `PATH`, or whose directory the guard cannot tell behind a command word the line does
  not tie to git (`source ./env.sh; $x pnv`, TP-613);
- a `!` alias body that reads its arguments other than as `$1` to `$9`, `$@` or `$*`;
- shell syntax the splitter misreads, such as `&>` or `case` patterns;
- a variable whose value in the Bash tool's shell differs from the hook's although the command
  line never mentions its name, for example one set in a shell startup file, or one assigned
  under a name built at run time (`typeset "${n}DIR=x"`);
- a function or alias named `gh`, and a gh alias (`gh alias set`), which change what a checked
  command runs;
- gh commands other than those above that post text, such as `gh release create --notes`,
  `gh gist create` and `gh pr close --comment`;
- a file that changes between the guard's read and gh's.

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

The hook allows a call it cannot decide when it crashes on input that does not mention git or
gh, or when it runs past its 12 s deadline. A crash on a call that mentions git or gh is a deny,
not a fail-open. That holds for a crash in the worker thread that runs the decision, such as a
worker that does not start, as well as for one inside the decision. The deadline sits under the 15 s that Claude Code gives the hook, which would
kill it without a word. The owner accepts both fail-opens, and each writes exactly one line to
`leak-guard.log` in the agent-chat home:

```
<ISO time> leak-guard pretool fail-open: crash (<error class>)
<ISO time> leak-guard pretool fail-open: timeout after <elapsed>ms
```

The line never holds the command. A log that cannot be written does not change the allow.

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
`git` on the broker's PATH whose realpath is not the shim, so the shim never calls itself.
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
| `shell-alias` | the word is a `!` alias, and its text or the arguments after it mention `push` other than as `stash push`, quotes aside                  |
| `unresolved`  | the alias read fails for a reason other than "no such key", or the alias has an open quote                                               |
| `alias-depth` | aliases chain more than 10 deep                                                                                                          |
| `autocorrect` | the word is no builtin, alias or `git-<word>` command, and `help.autocorrect` is not unset, `0`, `false`, `off`, `no`, `show` or `never` |

git appends the arguments to a `!` alias's shell command, which can read them in more ways than
any list covers (`$1`, `"$@"`, `for a;`, `$0` under a nested `sh -c`, `shift`, `getopts`). So
`shell-alias` also refuses a `!` alias whenever its arguments mention `push` in any case, `stash
push` included, after removing quotes and blanks, so `pu sh` split across two arguments counts
(CC-479). It refuses, too, when the arguments hold a backslash, which the body may decode
(`printf "$1"` over `\x70ush`), or a glob character `?`, `*` or `[`, which the body may expand
into `push` (`p?sh` beside a file named `push`). The accepted cost is a false refusal such as `git st push` for `st = !git
stash`; run the command the alias stands for instead.

Every text filter in the shim (`tr`, `sed`) runs under `LC_ALL=C`, so a byte that is not valid UTF-8, such as `0xff`, is read as a byte and cannot make a filter fail and blank a check (CC-612). A filter that still fails refuses with `unresolved`.

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

Not covered:

- an absolute git path (`/usr/bin/git push`), or `env -i`, which drops the shim from PATH;
- `GIT_EXEC_PATH` or `--exec-path`;
- a `git` that the agent puts ahead of the shim on its own PATH (the PreToolUse guard reads that
  command line);
- a `git` binary inside git's exec-path directory, which git puts first on PATH for its hooks,
  `!` aliases and `rebase --exec`. A `!` alias that builds the word push at run time, such as
  `$(echo pu)sh`, is in this class, and so is one that builds push by transforming arguments
  that do not mention it, such as `tr a-z b-za` over `otrg` or printf over an octal number the
  body puts the backslash before, or reads push from a variable rather than its arguments, such
  as `!git $P --no-verify origin main; true` run as `P=push git g`. One whose arguments mention push,
  such as `!f(){ git $2; }; f` run as `git g stash push`, is refused (above);
- a `!` alias whose body builds and runs a git command without `$`, a backtick or a brace in
  its arguments, such as `echo hsup | rev | xargs -I% git % --no-verify ...`, or `tr` or `base64`
  piped to `sh` (CC-613, open; found in review d16c219d);
- an executable `git-<word>` on PATH or in git's exec-path: `git <word>` runs it unchecked, with
  git's exec-path first on PATH as for a `!` alias;
- pushing without git.

The shim is live for an agent only after a broker restart picks up the
build. `src/__tests__/leak-git-shim.test.ts` runs every rule against real git and a bare remote.
