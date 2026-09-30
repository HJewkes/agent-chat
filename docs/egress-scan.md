# The egress scan

agent-chat is public, so a branch is public the moment it is pushed. `@titan-design/egress-scan`
(its README has the rules and the command line) checks what a push sends for absolute home paths,
paths into the active-work data directory and terms from a private list. A finding names a
location and a rule id and never the matched text. Adopted by CC-172.

## The pre-push hook

`npm ci` runs `prepare`, which runs `titan-egress-scan install-hook`. The hook is written to
`git rev-parse --git-path hooks`, which for a linked worktree is the shared `.git/hooks` of the
main checkout, so one install covers every checkout of this repo. The hook is the control; the CI
job below is a merge gate behind it.

The hook runs the pushing worktree's own `node_modules/.bin/titan-egress-scan` and fails closed
when that worktree has none: the push is refused with `titan-egress-scan: not installed in this
worktree`. Run `npm ci` in that worktree and push again. The message names `pnpm`; `npm ci` is the
equivalent here.

Worktrees that agent-chat creates for spawned agents get that install automatically (CC-313).
`.agent-chat/worktree.json` declares a setup step, and after agent-chat adds a worktree, or
re-creates a parked one on `agent resume`, it runs the step in that worktree before the agent
launches:

```json
{ "setup": { "command": ["npm", "ci", "--no-audit", "--no-fund"], "timeoutMs": 300000 } }
```

`command` is an argv array run without a shell; `timeoutMs` defaults to five minutes and caps at
thirty. Keys agent-chat does not know are ignored. A repository with no such file gets no setup.

The step runs on the broker, outside any permission profile, so agent-chat reads the declaration
only from the commit it fetched as origin's default branch (`git cat-file blob <base sha>:.agent-chat/worktree.json`).
It never reads the file in a working tree or on the agent's branch. This holds for a new worktree, a
parked one re-created on resume, and a reused branch that already carries commits. A branch that adds
or edits the file changes what runs only after that change lands on the default branch. When origin
cannot be fetched and the worktree is cut from a local HEAD, no step runs and the spawn warns.

The step gets an allowlisted environment, not the broker's: `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `TMPDIR`, `LANG`, `LC_*`, `XDG_*_HOME`, the proxy variables, `NODE_EXTRA_CA_CERTS`,
`PNPM_HOME`, `COREPACK_*` and `npm_config_*`.

A step that fails, times out, or is malformed becomes a spawn warning that names the step and its
exit, and the spawn proceeds; the hook then fails closed as before. The warning carries no step
output. The output goes to `agent-chat-setup.log` in the worktree's git dir, readable by the owner
only, and the warning names that path. The step's `npm ci` runs `prepare` in the new worktree, which
rewrites the shared hook only when its managed body differs, leaves a foreign hook alone, and
otherwise reports it unchanged. The command is the default branch's, but the `package.json` whose
lifecycle scripts it runs is the worktree's, which on a reused or resumed branch is the branch's.

When the private term list is missing, egress-scan's own hook prints `private term list not found;
generic rules only` and still scans with the generic rules. It refuses only when
`TITAN_EGRESS_REQUIRE_TERMS=1` is set.

## The CI job

The `egress-scan` job runs `npx --yes @titan-design/egress-scan@<exact version> range` over the
pull request's base and head shas, with no install or build step. When `CI` is set egress-scan
never looks up the term list, so CI checks the generic rules only. The version in `ci.yml` is
pinned; bump it with the `devDependencies` range.

## The allow file

`.egress-allow` at the repo root holds `<glob> <rule-id> <reason>` lines, one per file and rule.
The reason must name a task id. `private-term` is never allowable. A malformed file fails the scan.
Prefer a placeholder home segment (`alice`, `example`, `user`, or one written `<...>`) over a new
entry: those never match.

## The private term list

`$TITAN_EGRESS_TERMS`, else `${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`: one
term per line, mode 0600, never in any repository.
