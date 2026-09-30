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
`CI= TITAN_EGRESS_REQUIRE_TERMS=1 titan-egress-scan pre-push <remote>` with git's ref lines on
stdin, the same call egress-scan's own hook makes. It then runs the repository's own `pre-push`
with the same arguments and stdin. The push is refused if either one fails, and the repository's
hook runs even when the scan has already refused. The repository's hook is found with
`git rev-parse --git-path hooks` with the guard's variables removed, so a repository's own
`core.hooksPath` (husky, lefthook) is honoured.

`node` and `titan-egress-scan` are found on the agent's `PATH` when the hook runs. The hook never
bakes in a path, because a versioned node can disappear. If either is missing, the hook prints one
line starting `leak-scan: guard NOT run, this push was not scanned` that names the missing tool.
It then lets the push go ahead, still running the repository's own hook. This fails open on
purpose: a missing guard must not refuse every push from every agent, and the burndown backstop
still reports a leak that got through. The fix is to put node on the agent's `PATH` or run
`npm i -g @titan-design/egress-scan`.

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

### The private term list

egress-scan reads its private terms from `$TITAN_EGRESS_TERMS`, else
`${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`: one term per line, mode 0600,
never in any repository. The hook sets `TITAN_EGRESS_REQUIRE_TERMS=1`, so while that file is
missing every agent push is refused with one line naming the file to create. The hook also clears
`CI`, because egress-scan never reads the term list when `CI` is set.

The hook ignores an inherited `TITAN_EGRESS_TERMS`. It overwrites the variable with the default
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
`nice`, `timeout`, zsh's `noglob` and `nocorrect`, `if`/`then` and other prefixes are stripped, is
one of these:

| Denied                                                                                                   | Why                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `git push` with `--no-verify`, or its abbreviations `--no-veri` and `--no-verif`, anywhere before `--`   | skips the pre-push hook                           |
| `git -c` or `--config-env` on `core.hooksPath` or any `alias.*` key                                      | command-line config beats the guard's environment |
| a `GIT_CONFIG*` assignment, `export`, `export -n`, `unset`, `declare` or `env -u`                        | removes or overrides the guard's `core.hooksPath` |
| `env -i` or `env -`                                                                                      | clears the environment, guard included            |
| `git config` writing or unsetting `core.hooksPath`, or writing a value that holds `--no-verify`          | a hooks path or alias in shared repo config       |
| any mention of the guard's hook directory or the private term list; an edit tool writing to either       | rewriting the hook or emptying the term list      |
| `gh pr` or `gh issue` `create`, `edit`, `comment`, `review` or `merge` whose title or body has a finding | the text is public the moment it is posted        |
| one of those commands, or `gh api`, with an argument or body file the guard cannot be sure of            | the guard would scan one text and gh post another |
| `gh api` whose `-f`, `-F` or `--input` values have a finding                                             | the same text by another route                    |
| a command word that is an expansion, followed by the words of one of those gh commands                   | `$G pr create` may run gh unscanned               |
| `eval` of text the guard cannot be sure of, on a command line that names `git` or `gh`                   | the text may be a push or a gh command            |

The splitter looks inside `$(...)`, backticks, `sh -c`/`bash -c` strings, `eval`, `env -S` and a
heredoc fed to a shell. `agent-chat gh-write -- <gh args>` is checked like `gh`. `git push -n` is
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
`name(qualifier)` and `<1-9>`, and an ANSI-C escape other than `\n`, `\t`, `\r`, `\\` and the
quotes. gh's own `{owner}`, `{repo}` and `{branch}` are not brace expansions and pass as written.
A `gh` whose group or verb is an expansion (`gh pr $V`) is unknown even when the value is known,
because the guard picks the flags to read from the literal subcommand.

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
- a `<` redirect of stdin, with or without a heredoc.
- a heredoc with an unquoted delimiter whose body holds a `$`, a backtick or a backslash. The
  shell expands the first two, and a backslash joins two lines or escapes a character. Quote the
  delimiter: `<<'EOF'`.
- a here-string the shell expands.
- inside `$(...)` or backticks, a heredoc with a line that ends in a backslash, even under a
  quoted delimiter. bash 3.2, which is `/bin/bash` on macOS, joins that line to the next. This
  covers `--body "$(cat <<'EOF' ... EOF)"`.
- a backtick substitution that holds a backslash. The shell rewrites `\\`, `\$` and a backslash
  before a newline inside backticks before it parses them. Use `$(...)`.

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
- command text held in a variable and run by a shell: `C='gh pr create ...'; sh -c "$C"`. The
  guard reads a `sh -c` string as written and does not expand it. `eval "$C"` is denied only
  when the command line names `git` or `gh`, so text set in an earlier tool call gets through;
- a command word that is an expansion, when the group or verb after it is one too (`$G pr $V`);
- text in a place the guard does not scan: the query string of a `gh api` path
  (`'repos/o/r/issues/1/comments?body=<text>'`), and flag values other than the title, body and
  fields, such as `--head`, `--label` and `--milestone`;
- zsh with `BRACE_CCL` set in a startup file, which expands `{owner}` into single characters;
- a different `git` on `PATH`, `GIT_EXEC_PATH`, or `--exec-path`;
- pushing without git at all, for example over the GitHub API with `curl`;
- an alias that was already in git config before the agent started;
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
