import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkCommand,
  checkToolCall,
  guardContext,
  loadTerms,
  pretoolDecision,
  readText,
  REASONS,
  type GuardContext,
  type TermsLoad,
} from '../leak-guard/pretool.js'
import { aliasReader } from '../leak-guard/git-alias.js'
import { includedHooksPathReader } from '../leak-guard/git-include.js'
import { parseShell } from '../leak-guard/shell-words.js'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-'))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

// Synthetic only: a made-up private term and a made-up home.
const TERM = 'zq7privateseat'
// Joined from parts so this file does not trip the repo's own pre-push scan.
const HOME_PATH = ['', 'Users', 'zq7-probe-home', 'notes'].join('/')
const HOOKS_DIR = '/state/zq7/git-hooks'

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: {},
  protectedPaths: [
    '/cfg/titan-egress/private-terms',
    'titan-egress/private-terms',
    '.agent-chat/git-hooks',
    HOOKS_DIR,
  ],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  ...over,
})

const expectRedacted = (reason: string | undefined): void => {
  expect(reason).toBeDefined()
  expect(reason?.toLowerCase()).not.toContain(TERM)
  expect(reason).not.toContain('zq7-probe-home')
}

describe('the bypass guard denies skipping the pre-push hook', () => {
  it.each([
    'git push --no-verify',
    'git push origin HEAD --no-verify',
    'git push --no-verif origin main',
    'git -C /work push --no-verify',
    '/usr/bin/git push --no-verify',
    'cd /work && git push --no-verify',
    'command git push --no-verify',
    'if git push --no-verify; then echo ok; fi',
    'echo "$(git push --no-verify)"',
    'echo `git push --no-verify`',
    "sh -c 'git push --no-verify'",
    'bash -lc "git push --no-verify origin x"',
    "eval 'git push --no-verify'",
    "env -S 'git push --no-verify'",
    'bash <<EOF\ngit push --no-verify\nEOF',
  ])('%s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.noVerify)
  })

  it.each([
    'git -c core.hooksPath=/dev/null push',
    'git -c core.hookspath= push',
    'git -c CORE.HOOKSPATH=/tmp/x push origin main',
    'git --config-env=core.hooksPath=X push',
    'git --config-env core.hooksPath=X push',
    "git -c alias.p='push --no-verify' p",
  ])('%s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.gitConfig)
  })

  it.each([
    'GIT_CONFIG_COUNT=0 git push',
    'GIT_CONFIG_PARAMETERS= git push',
    'env GIT_CONFIG_COUNT=0 git push',
    'env -u GIT_CONFIG_COUNT git push',
    'env --unset=GIT_CONFIG_KEY_0 git push',
    'unset GIT_CONFIG_COUNT; git push',
    'export GIT_CONFIG_COUNT=0 && git push',
    'export -n GIT_CONFIG_VALUE_0',
    'FOO=1 GIT_CONFIG_VALUE_0=/tmp make push',
  ])('%s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.gitConfigEnv)
  })

  it.each([
    'echo origin | xargs git push --no-verify',
    'xargs -n 1 git push --no-verify',
    'xargs -n 1 git -c core.hooksPath=/dev/null push',
    'xargs -I {} git push {} --no-verify',
    'xargs -L 1 -P 4 -0 git push --no-verify',
    'xargs -d , -a list.txt -s 100 -E EOF git push --no-verify',
    'xargs --max-args=1 --replace=% git push --no-verify',
    'xargs -r env git push --no-verify',
    'xargs --replace git push --no-verify',
    'xargs -J % git push --no-verify',
    'xargs -R 2 git push --no-verify',
    'xargs -S 255 git push --no-verify',
    'xargs -tn 1 git push --no-verify',
    'xargs -rL 1 git push --no-verify',
    'xargs -tn1 git push --no-verify',
    'xargs -- git push --no-verify',
  ])('denies git push --no-verify behind xargs: %s', command => {
    expect(checkCommand(command, ctx())).toBe(
      command.includes('hooksPath') ? REASONS.gitConfig : REASONS.noVerify,
    )
  })

  it.each([
    'xargs --process-slot-var V git push --no-verify',
    'xargs --process-slot-var=V git push --no-verify',
  ])('denies git push --no-verify behind a known long xargs option: %s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.noVerify)
  })

  it.each(['xargs --max-a 1 git push --no-verify', 'xargs --frobnicate git push --no-verify'])(
    'fails closed on a long xargs option it does not know: %s',
    command => {
      expect(checkCommand(command, ctx())).toBe(REASONS.xargsOption)
    },
  )

  it('denies a push that follows git config core.hooksPath in one command', () => {
    expect(checkCommand('git config core.hooksPath /dev/null && git push', ctx())).toBe(REASONS.configWrite)
    expect(checkCommand('git config core.hooksPath /dev/null; git push', ctx())).toBe(REASONS.configWrite)
    expect(checkCommand('cd /work && git config --unset core.hooksPath && git push', ctx())).toBe(
      REASONS.configWrite,
    )
  })

  it.each(['env -i git push', 'env -i PATH=/usr/bin git push', 'env - git push'])('%s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.envClear)
  })

  it.each([
    'git config core.hooksPath /tmp/none',
    'git config --unset core.hooksPath',
    'git config set core.hooksPath /tmp/none',
    'git config alias.p "push --no-verify"',
  ])('%s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.configWrite)
  })

  it.each([
    `rm ${HOOKS_DIR}/pre-push`,
    'cat ~/.agent-chat/git-hooks/pre-push',
    'truncate -s0 ~/.config/titan-egress/private-terms',
  ])('touching the guard itself: %s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.protectedPath)
  })

  it('denies an edit tool writing into the hook directory or the term list', () => {
    expect(checkToolCall('Write', { file_path: `${HOOKS_DIR}/pre-push` }, ctx())).toBe(REASONS.protectedPath)
    expect(checkToolCall('Edit', { file_path: '/cfg/titan-egress/private-terms' }, ctx())).toBe(
      REASONS.protectedPath,
    )
  })
})

describe('the bypass guard leaves ordinary commands alone', () => {
  it.each([
    'git push',
    'git push -u origin agent-chat/x',
    'git push -n origin main',
    'git push --verify origin main',
    'git push origin -- --no-verify',
    'git commit --no-verify -m "wip"',
    'git config --get core.hooksPath',
    'git config core.hooksPath',
    'git -c user.name=x commit -m y',
    'echo "git push --no-verify is denied"',
    "grep -n 'GIT_CONFIG_COUNT' src/leak-guard/hooks-dir.ts",
    'env FOO=1 npm test',
    'gh pr view 12 --json title',
    'gh pr create --title "Add a feature" --body "Plain text"',
    'npm run verify 2>&1 | tail -5',
    'ls | xargs -n 1 echo',
    'ls | xargs -J cp',
    'git log | xargs echo',
    'ls | xargs -tn 1 echo',
    'git ls-files | xargs grep -- --no-verify',
    'echo a | xargs -n 1 cat push-verify.txt',
    'xargs --process-slot-var=V --max-args=1 echo',
    'git ls-files | xargs grep foo',
    'echo origin | xargs -I {} git push {}',
    'xargs -n 1 git status',
  ])('%s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it('leaves non-edit tools and other files alone', () => {
    expect(checkToolCall('Read', { file_path: `${HOOKS_DIR}/pre-push` }, ctx())).toBeUndefined()
    expect(checkToolCall('Write', { file_path: '/work/notes.md' }, ctx())).toBeUndefined()
  })
})

describe('the PR pre-check', () => {
  it.each([
    [`gh pr create --title "Fix ${TERM}" --body ok`, 'title line 1 private-term #1'],
    [`gh pr create -t ok -b "line one\nsee ${HOME_PATH}"`, 'body line 2 home-path'],
    [`gh pr edit 3 --body="${TERM}"`, 'body line 1 private-term #1'],
    [`agent-chat gh-write -- pr create --title ${TERM} --body x`, 'title line 1 private-term #1'],
    [`gh pr create --title t --body "$(cat <<'EOF'\nIt doesn't matter\n${TERM}\nEOF\n)"`, 'private-term #1'],
    [`gh api -X POST repos/o/r/pulls -f title=ok -f body='${TERM}'`, 'field line 1 private-term #1'],
    [`gh issue comment 4 --body "${TERM}"`, 'body line 1 private-term #1'],
  ])('denies %s with a redacted reason', (command, where) => {
    const reason = checkCommand(command, ctx())

    expectRedacted(reason)
    expect(reason).toContain(where)
  })

  it('reads --body-file relative to the cwd, following cd', () => {
    const files: Record<string, string> = { '/work/sub/body.md': `intro\n\n${TERM}` }
    const reason = checkCommand(
      'cd sub && gh pr create -t x --body-file body.md',
      ctx({ readFile: f => files[f] }),
    )

    expectRedacted(reason)
    expect(reason).toContain('body line 3 private-term #1')
  })

  it('reads a heredoc passed as --body-file -', () => {
    const reason = checkCommand(`gh pr create -t x -F - <<'EOF'\nclean\n${TERM}\nEOF`, ctx())

    expect(reason).toContain('body line 2 private-term #1')
  })

  it('reads a gh api --input file and an @file field', () => {
    const files: Record<string, string> = { '/work/p.json': `{"body":"${TERM}"}` }
    const read = ctx({ readFile: f => files[f] })

    expect(checkCommand('gh api repos/o/r/pulls --input p.json', read)).toContain('input line 1')
    expect(checkCommand('gh api repos/o/r/pulls -F body=@p.json', read)).toContain('field line 1')
  })

  it('refuses a body it cannot read rather than passing it unchecked', () => {
    expect(checkCommand('gh pr create -t x --body-file missing.md', ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand('cat b.md | gh pr create -t x --body-file -', ctx())).toBe(REASONS.stdinBody)
  })

  it('refuses PR text while the private term list is missing or unreadable', () => {
    const missing: TermsLoad = { kind: 'missing' }

    expect(checkCommand('gh pr create -t x -b y', ctx({ terms: missing }))).toBe(REASONS.missingTerms)
    expect(checkCommand('gh pr create -t x -b y', ctx({ terms: { kind: 'unreadable' } }))).toBe(
      REASONS.unreadableTerms,
    )
    expect(checkCommand('git status', ctx({ terms: missing }))).toBeUndefined()
  })
})

describe('body file paths are expanded from the hook env', () => {
  const TMP = '/scratch/tmp'
  const ENV = { TMPDIR: TMP, HOME: '/home/example' }
  const holding = (file: string, body: string): GuardContext =>
    ctx({ env: ENV, readFile: f => (f === file ? body : undefined) })
  const anyFileIsClean = ctx({ env: ENV, readFile: () => 'clean' })

  it.each([
    ['--body-file "$TMPDIR/pr.md"', `${TMP}/pr.md`],
    ['--body-file $TMPDIR/pr.md', `${TMP}/pr.md`],
    ['--body-file ${TMPDIR}x', `${TMP}x`],
    ['--body-file ~/x.md', '/home/example/x.md'],
  ])('reads and scans %s', (flag, file) => {
    const command = `gh pr create -t x ${flag}`
    const reason = checkCommand(command, holding(file, `intro\n${TERM}`))

    expect(checkCommand(command, holding(file, 'clean'))).toBeUndefined()
    expectRedacted(reason)
    expect(reason).toContain('body line 2 private-term #1')
  })

  it.each([
    ['an unset variable', '"$ZQ7_UNSET/pr.md"'],
    ['a default-value form', '"${TMPDIR:-/x}/pr.md"'],
    ['a command substitution', '"$(echo /scratch/tmp)/pr.md"'],
    ['backticks', '`echo /scratch/tmp`/pr.md'],
    ['a * glob', '$TMPDIR/*.md'],
    ['a ? glob', '$TMPDIR/pr.m?'],
    ['a [ glob', '$TMPDIR/p[r].md'],
    ['a brace expansion', '$TMPDIR/{pr,x}.md'],
    ['a zsh numeric range', '$TMPDIR/pr<1-2>.md'],
    ['a zsh glob qualifier', '$TMPDIR/pr.md(:h)'],
    ['a zsh command path', '=pr.md'],
    ['a process substitution', '<(cat pr.md)'],
    ['an ANSI-C escape the splitter does not decode', "$'\\x70r.md'"],
    ['a zsh modifier', '$TMPDIR:h/pr.md'],
    ['a quoted zsh modifier', '"$TMPDIR:h/pr.md"'],
    ['a zsh subscript', '"$TMPDIR[1]pr.md"'],
    ['a tilde with a user name', '~zq7user/pr.md'],
  ])('denies %s rather than guessing the file', (_, file) => {
    expect(checkCommand(`gh pr create -t x --body-file ${file}`, holding(`${TMP}/pr.md`, 'clean'))).toBe(
      REASONS.unreadableBody,
    )
    expect(checkCommand(`gh pr create -t x --body-file ${file}`, anyFileIsClean)).toBe(REASONS.unreadableBody)
  })

  it.each([
    ['a single-quoted variable', "'$TMPDIR/pr.md'"],
    ['an escaped variable', '\\$TMPDIR/pr.md'],
  ])('reads %s as the literal file name, as the shell does', (_, file) => {
    const command = `gh pr create -t x --body-file ${file}`

    expect(checkCommand(command, holding(`${TMP}/pr.md`, 'clean'))).toBe(REASONS.unreadableBody)
    expect(checkCommand(command, holding('/work/$TMPDIR/pr.md', TERM))).toContain('body line 1 private-term')
  })

  it('denies a variable the command itself assigns, whose new value the hook env does not hold', () => {
    const command = 'TMPDIR=/elsewhere; gh pr create -t x --body-file "$TMPDIR/pr.md"'

    expect(checkCommand(command, holding(`${TMP}/pr.md`, 'clean'))).toBe(REASONS.unreadableBody)
  })

  it('follows cd into an expanded directory, and denies a relative body after a cd it cannot expand', () => {
    const command = 'cd "$TMPDIR" && gh pr create -t x --body-file pr.md'

    expect(checkCommand(command, holding(`${TMP}/pr.md`, 'clean'))).toBeUndefined()
    expect(checkCommand(command, holding(`${TMP}/pr.md`, TERM))).toContain('body line 1 private-term #1')
    expect(checkCommand('cd "$ZQ7_UNSET" && gh pr create -t x --body-file pr.md', anyFileIsClean)).toBe(
      REASONS.unreadableBody,
    )
  })

  it('reads and scans a file that $(cat file) puts into the body', () => {
    const inBody = 'gh pr create -t x --body "$(cat "$TMPDIR/pr.md")"'

    expect(checkCommand(inBody, holding(`${TMP}/pr.md`, 'clean'))).toBeUndefined()
    expect(checkCommand(inBody, holding(`${TMP}/pr.md`, `a\n${TERM}`))).toContain(
      'body line 2 private-term #1',
    )
    expect(checkCommand(inBody, ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand('gh pr create -t x -b "`cat b.md`"', holding('/work/b.md', TERM))).toContain(
      'body line 1 private-term #1',
    )
  })

  it.each([
    ['HOME assigned, then ~', { HOME: '/home/example' }, 'HOME=/evil; gh pr create -t x --body-file ~/pr.md'],
    ['PWD after a cd', { PWD: '/work' }, 'cd /evil && gh pr create -t x --body-file "$PWD/pr.md"'],
    ['OLDPWD', { OLDPWD: '/work' }, 'gh pr create -t x --body-file "$OLDPWD/pr.md"'],
    ['IFS in bash', { IFS: '/' }, 'gh pr create -t x --body-file$IFS/evil/pr.md'],
    ['SHLVL', { SHLVL: '2' }, 'gh pr create -t x -F "$SHLVL/pr.md"'],
    ['the last argument', { _: '/work' }, 'gh pr create -t x -F "$_/pr.md"'],
    ['an assignment after another command', ENV, 'true; TMPDIR=/evil; gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['export', ENV, 'export TMPDIR=/evil; gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['env', ENV, 'env TMPDIR=/evil gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['read', ENV, 'read TMPDIR <<< /evil; gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['for', ENV, 'for TMPDIR in /evil; do gh pr create -t x -F "$TMPDIR/pr.md"; done'],
    ['printf -v', ENV, 'printf -v TMPDIR /evil; gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['unset', ENV, 'unset TMPDIR; gh pr create -t x -F "${TMPDIR}pr.md"'],
    ['a zsh assigning expansion', ENV, ': ${TMPDIR::=/evil}; gh pr create -t x -F "$TMPDIR/pr.md"'],
    ['an assignment, then eval', ENV, `TMPDIR=/evil; eval 'gh pr create -t x -F "$TMPDIR/pr.md"'`],
    ['an assignment, then sh -c', ENV, `TMPDIR=/evil; sh -c 'gh pr create -t x -F "$TMPDIR/pr.md"'`],
    ['a variable set from a file', { B: 'x' }, 'B=$(cat f); gh pr create -t x --body "$B"'],
    ['a variable holding a flag', { A: 'x' }, 'A=--body-file=/evil/pr.md; gh pr create -t x $A'],
    ['a value with a blank', { V: '/a b' }, 'gh pr create -t x -F "$V"'],
    ['a value with a glob', { V: '/a/*' }, 'gh pr create -t x -F $V'],
    ['an empty value', { V: '' }, 'gh pr create -t x $V -F pr.md'],
  ])('denies %s, whose value in the shell the hook env does not hold', (_, env, command) => {
    expect(checkCommand(command, ctx({ env, readFile: () => 'clean' }))).toBe(REASONS.unreadableBody)
  })
})

describe('the guard never reads one file while the shell posts another', () => {
  const FILES: Record<string, string> = { '/clean/w.md': 'clean', '/work/w.md': TERM, '/work/sub/w.md': TERM }
  const read = (env: GuardContext['env'] = {}): GuardContext => ctx({ env, readFile: f => FILES[f] })
  const POST = 'gh pr create -t x --body-file w.md'

  it.each([
    `(cd /clean); ${POST}`,
    `cd /clean | true; ${POST}`,
    `true | cd /clean; ${POST}`,
    `cd /clean & ${POST}`,
    `false && cd /clean; ${POST}`,
    `false &&\ncd /clean\n${POST}`,
    `false || cd /clean; ${POST}`,
    `echo $(cd /clean); ${POST}`,
    `cd; ${POST}`,
    `cd -P /clean; ${POST}`,
    `cd -; ${POST}`,
    `cd +1; ${POST}`,
    `chdir /clean; ${POST}`,
    `popd; ${POST}`,
    `function f { true; }; ${POST}`,
    `alias ls=true; ${POST}`,
    `. ./env.sh; ${POST}`,
    `emulate sh; ${POST}`,
    `shopt -s extglob; ${POST}`,
    `unsetopt nomatch; ${POST}`,
    `cd /clean /work; ${POST}`,
    `cd nowhere/../../clean; ${POST}`,
    `builtin cd /clean; ${POST}`,
    `if true; then cd /clean; fi; ${POST}`,
    `pushd /clean; ${POST}`,
    `f() { true; }; ${POST}`,
    `f () { true; }; ${POST}`,
    `eval 'true'; ${POST}`,
    `source ./env.sh; ${POST}`,
    `setopt autocd; ${POST}`,
    `set -o autocd; ${POST}`,
    `trap 'true' EXIT; ${POST}`,
    `"$(echo cd)" /clean; ${POST}`,
    `env -C /clean ${POST}`,
    `env --chdir=/clean ${POST}`,
    `CDPATH=/; cd clean; ${POST}`,
  ])('denies %s', command => {
    expect(checkCommand(command, ctx({ readFile: () => 'clean' }))).toBe(REASONS.unreadableBody)
  })

  it('denies a relative cd while CDPATH is set in the hook env', () => {
    const command = `cd sub; ${POST}`

    expect(checkCommand(command, read())).toContain('body line 1 private-term #1')
    expect(checkCommand(command, read({ CDPATH: '/clean' }))).toBe(REASONS.unreadableBody)
    expect(checkCommand(`cd ./sub; ${POST}`, read({ CDPATH: '/clean' }))).toContain('private-term #1')
  })

  it.each([
    `cd /clean && ${POST}`,
    `cd /clean; ${POST}`,
    `cd /clean\n${POST}`,
    `true && cd /clean && ${POST}`,
    `cd /clean || exit 1; ${POST}`,
    `set -euo pipefail; cd /clean; ${POST}`,
    `cd /clean/sub && cd .. && ${POST}`,
    `echo "f() is gone"; cd /clean; ${POST}`,
  ])('follows the plain cd in %s', command => {
    expect(checkCommand(command, read())).toBeUndefined()
  })

  it.each([
    `${POST} # after no cd`,
    `(cd /clean && true) || true; gh pr create -t x --body-file /work/w.md`,
    `cd /work/sub && ${POST}`,
  ])('reads the file the shell posts in %s', command => {
    expect(checkCommand(command, read())).toContain('body line 1 private-term #1')
  })

  it.each([
    ['a body from a command', 'gh pr create -t x --body "$(git log -1)"'],
    ['a body from a redirect', 'gh pr create -t x --body "$(< w.md)"'],
    ['an unquoted $(cat file), which the shell splits', 'gh pr create -t x --body $(cat w.md)'],
    ['a cat after a cd in the substitution', 'gh pr create -t x --body "$(cd /clean && cat w.md)"'],
    ['a cat piped through another command', 'gh pr create -t x --body "$(cat /clean/w.md | tr a-z A-Z)"'],
    ['a cat with an option', 'gh pr create -t x --body "$(cat -n /clean/w.md)"'],
    ['a heredoc the shell expands', 'gh pr create -t x -F - <<EOF\n$(cat secret)\nEOF'],
    ['a heredoc the shell expands, through cat', 'gh pr create -t x -b "$(cat <<EOF\n`cat secret`\nEOF\n)"'],
    ['a here-string the shell expands', 'gh pr create -t x -F - <<< "$(cat secret)"'],
    ['a heredoc overridden by a redirect', "gh pr create -t x -F - <<'EOF' < /clean/w.md\nclean\nEOF"],
    ['an expanded verb', 'gh pr $V -t x -b y'],
    ['an expanded group', 'gh "$G" create -t x -b y'],
    ['an expanded positional', 'gh pr comment "$(gh pr view --json number -q .number)" -b y'],
    ['an expanded gh api endpoint', 'gh api "repos/o/r/issues/$N/comments" -f body=y'],
  ])('denies %s', (_, command) => {
    expect(checkCommand(command, ctx({ readFile: () => 'clean' }))).toBe(REASONS.unreadableBody)
  })

  it('still reads a quoted heredoc, with or without an expansion-free unquoted delimiter', () => {
    expect(checkCommand("gh pr create -t x -F - <<'EOF'\nclean\nEOF", ctx())).toBeUndefined()
    expect(checkCommand('gh pr create -t x -F - <<EOF\nclean\nEOF', ctx())).toBeUndefined()
    expect(checkCommand(`gh pr create -t x -F - <<EOF\n${TERM}\nEOF`, ctx())).toContain('private-term #1')
  })

  it.each([
    ['a short flag behind another', 'gh pr create -t x -dF /work/w.md', 'body line 1'],
    ['a short flag joined with =', 'gh pr create -t x -F=/work/w.md', 'body line 1'],
    ['a repo flag before the verb', `gh pr -R o/r create -t x -b ${TERM}`, 'body line 1'],
    ['gh pr new', `gh pr new -t ${TERM} -b y`, 'title line 1'],
    ['gh pr merge --body', `gh pr merge 12 --squash --body ${TERM}`, 'body line 1'],
    ['gh pr merge --subject', `gh pr merge 12 --squash --subject ${TERM}`, 'title line 1'],
    ['gh pr merge --body-file', 'gh pr merge 12 --squash --body-file w.md', 'body line 1'],
  ])('scans %s', (_, command, where) => {
    expect(checkCommand(command, read())).toContain(`${where} private-term #1`)
  })

  it('leaves gh commands that post no text alone, whatever their arguments', () => {
    const noList = ctx({ terms: { kind: 'missing' } })

    expect(checkCommand('gh pr merge 12 --squash --delete-branch', noList)).toBeUndefined()
    expect(checkCommand('gh pr view "$PR" --json title', noList)).toBeUndefined()
    expect(
      checkCommand('gh run watch $(gh run list -L1 --json databaseId -q ".[0].databaseId")', noList),
    ).toBeUndefined()
  })

  it('denies a FIFO or a directory as a body file without waiting on it', () => {
    const fifo = path.join(SCRATCH, 'body.fifo')
    execFileSync('mkfifo', [fifo])
    const real = ctx({ readFile: readText })

    expect(checkCommand(`gh pr create -t x --body-file ${fifo}`, real)).toBe(REASONS.unreadableBody)
    expect(checkCommand(`gh pr create -t x --body-file ${SCRATCH}`, real)).toBe(REASONS.unreadableBody)
    expect(checkCommand('gh pr create -t x --body-file /dev/stdin', real)).toBe(REASONS.unreadableBody)
  })
})

describe('stdin with more than one source, or a source the guard did not read', () => {
  const HEREDOC = "<<'EOF'\nclean\nEOF"
  const COMMENTS = 'repos/o/r/issues/1/comments'

  it.each([
    `cat /evil/pr.md | gh pr create -t x -F - ${HEREDOC}`,
    `cat /evil/pr.md |\ngh pr create -t x -F - ${HEREDOC}`,
    `cat /evil/pr.md | gh pr create -t x -F - <<< clean`,
    `cat /evil/pr.md | gh api ${COMMENTS} --input - ${HEREDOC}`,
    `cat /evil/pr.md | gh api ${COMMENTS} -F body=@- ${HEREDOC}`,
    `cat /evil/pr.md | command gh pr create -t x -F - ${HEREDOC}`,
    `cat /evil/pr.md | agent-chat gh-write -- pr create -t x -F - ${HEREDOC}`,
    `cat /evil/pr.md | { gh pr create -t x -F - ${HEREDOC}\n}`,
    `cat /evil/pr.md | (gh pr create -t x -F - ${HEREDOC}\n)`,
    `cat /evil/pr.md |& gh pr create -t x -F - ${HEREDOC}`,
    `cat /evil/pr.md | gh pr create -t x -F - 0${HEREDOC}`,
  ])('denies a heredoc or here-string behind a pipe: %j', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.stdinBody)
  })

  it.each([
    `gh pr create -t x -F - 3${HEREDOC}`,
    'gh pr create -t x -F - 3<<< clean',
    `cat /evil/pr.md | gh pr create -t x -F - 3${HEREDOC}`,
    'cat /evil/pr.md | gh pr create -t x -F - 3<<< clean',
    `gh api ${COMMENTS} --input - 12${HEREDOC}`,
  ])('does not take a heredoc on another descriptor for stdin: %j', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.stdinBody)
  })

  it('reads the heredoc on descriptor 0 and reads past one on another descriptor', () => {
    const both = `gh pr create -t x -F - <<'EOF' 3<<'E2'\n${TERM}\nEOF\nclean\nE2`

    expect(checkCommand(`gh pr create -t x -F - 0<<'EOF'\n${TERM}\nEOF`, ctx())).toContain('body line 1')
    expect(checkCommand(both, ctx())).toContain('body line 1 private-term #1')
    expect(checkCommand("gh pr create -t x -b y 3<<'E2'\ngit push --no-verify\nE2", ctx())).toBeUndefined()
    expect(checkCommand(`gh pr create -t x -F - "3"<<'EOF'\n${TERM}\nEOF`, ctx())).toContain('body line 1')
    expect(checkCommand("gh pr create -t x -F - 3< f <<'EOF'\nclean\nEOF", ctx())).toBeUndefined()
  })

  it.each([
    "gh pr create -t x -F - <<'A' <<'B'\nclean\nA\nclean\nB",
    "gh pr create -t x -F - <<'A' <<< clean\nclean\nA",
    'gh pr create -t x -F - <<< clean <<< clean',
    `gh pr create -t x -b "$(cat <<'A' <<'B'\nclean\nA\nclean\nB\n)"`,
  ])('denies two heredocs or here-strings on one command: %j', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.unreadableBody)
  })

  it('denies an unquoted heredoc holding a backslash, which joins lines and escapes', () => {
    const split = (delim: string): string => `<<${delim}\nzq7private\\\nseat\nEOF`

    expect(checkCommand(`gh pr create -t x -F - ${split('EOF')}`, ctx())).toBe(REASONS.heredocBackslash)
    expect(checkCommand(`gh pr create -t x -b "$(cat ${split('EOF')}\n)"`, ctx())).toBe(
      REASONS.heredocBackslash,
    )
    expect(checkCommand(`gh pr create -t x -F - ${split("'EOF'")}`, ctx())).toBeUndefined()
  })

  it('denies a line ending in a backslash in a quoted heredoc inside a substitution, which bash 3.2 joins', () => {
    const body = (last: string): string => `<<'EOF'\nzq7private\\\nseat${last}\nEOF\n`

    expect(checkCommand(`gh pr create -t x -b "$(cat ${body('')})"`, ctx())).toBe(REASONS.heredocBackslash)
    expect(checkCommand(`gh pr create -t x -b "$(cat <<'EOF'\nclean\\\nEOF\n)"`, ctx())).toBe(
      REASONS.heredocBackslash,
    )
    expect(checkCommand(`echo "$(gh pr create -t x -F - ${body('')})"`, ctx())).toBe(REASONS.heredocBackslash)
    expect(checkCommand(`gh pr create -t x -b "$(cat <<'EOF'\na\\b\nEOF\n)"`, ctx())).toBeUndefined()
  })

  it('denies a backtick substitution holding a backslash, which the shell rewrites before parsing', () => {
    const files: Record<string, string> = { '/work/a\\$b.md': 'clean', '/work/b.md': 'clean' }
    const read = ctx({ readFile: f => files[f] })

    expect(checkCommand('gh pr create -t x -b "`cat <<\'EOF\'\nzq7private\\\\seat\nEOF\n`"', read)).toBe(
      REASONS.unreadableBody,
    )
    expect(checkCommand('gh pr create -t x -b "`cat \'a\\$b.md\'`"', read)).toBe(REASONS.unreadableBody)
    expect(checkCommand("echo `gh pr create -t 'x\\y' -b y`", read)).toBe(REASONS.unreadableBody)
    expect(checkCommand('gh pr create -t x -b "`cat b.md`"', read)).toBeUndefined()
    expect(checkCommand('echo `git push \\\n--no-verify`', read)).toBe(REASONS.noVerify)
  })

  it('names the backslash only when a heredoc with one is what it could not read', () => {
    const backslash = '<<EOF\nclean\\\nEOF'

    expect(REASONS.heredocBackslash).toContain('holds a backslash')
    expect(checkCommand(`gh pr create -t x -F - ${backslash}`, ctx())).toBe(REASONS.heredocBackslash)
    expect(checkCommand('gh pr create -t x -F - <<EOF\n$HOME\nEOF', ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand(`gh pr create -t x -F missing.md ${backslash}`, ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand(`gh pr create -t x -F - <<< $X 3${backslash}`, ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand(`gh pr create -t x -b "$(git log -1)" -F - ${backslash}`, ctx())).toBe(
      REASONS.unreadableBody,
    )
  })

  it('leaves a redirect of another descriptor alone, with or without its number', () => {
    const redirected = (text: string): string =>
      `gh pr create -t x -F - <<'EOF' > out.txt 2>&1 1>&2\n${text}\nEOF`

    expect(checkCommand(redirected('clean'), ctx())).toBeUndefined()
    expect(checkCommand(redirected(TERM), ctx())).toContain('body line 1 private-term #1')
  })

  it.each([
    "gh pr create -t x -F - <<'EOF' 0>&3\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 0>&3-\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 0>& 3\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 00>&3\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 0<&3\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' <&3\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 0<> f\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' < f\nclean\nEOF",
    'gh pr create -t x -F - <<< clean 0>&3',
    `gh api ${COMMENTS} --input - <<'EOF' 0>&3\nclean\nEOF`,
    "agent-chat gh-write -- pr create -t x -F - <<'EOF' 0>&3\nclean\nEOF",
  ])('denies any redirect of descriptor 0 beside a heredoc or here-string: %j', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.unreadableBody)
  })

  it.each([
    "gh pr create -t x -F - <<'EOF' 12< /evil/pr.md\nclean\nEOF",
    "gh pr create -t x -F - <<'EOF' 12<<'E2'\nclean\nEOF\nclean\nE2",
    "gh pr create -t x -F - <<'EOF' 00<<< clean\nclean\nEOF",
  ])('denies a descriptor of two digits, which zsh reads as a word and a redirect of stdin: %j', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.unreadableBody)
  })

  it('reads the file a path with a control character names, not the path without it', () => {
    const files: Record<string, string> = {
      '/work/ab.md': 'clean',
      '/work/a\x01b.md': TERM,
      '/t/a\x01b.md': 'x',
    }
    const read = ctx({ env: { T: '/t' }, readFile: f => files[f] })

    expect(checkCommand('gh pr create -t x --body-file a\x01b.md', read)).toContain(
      'body line 1 private-term',
    )
    expect(checkCommand("gh pr create -t x --body-file 'a\x01b.md'", read)).toContain('body line 1')
    expect(checkCommand('gh pr create -t x --body-file "$T/a\x01b.md"', read)).toBe(REASONS.unreadableBody)
  })
})

describe("gh's own placeholders in an api path", () => {
  it.each([
    'gh api -X POST repos/{owner}/{repo}/issues/12/comments -f body=hello',
    'gh api repos/{owner}/{repo}/git/refs/heads/{branch} -f note=hello',
    'agent-chat gh-write -- api -X PATCH repos/{owner}/{repo}/pulls/12 -f title=hello',
  ])('passes %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
    expect(checkCommand(command.replace('hello', TERM), ctx())).toContain('private-term #1')
  })

  it('takes the merge path with placeholders for a merge', () => {
    const merge = 'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash'

    expect(checkCommand(merge, ctx({ terms: { kind: 'missing' } }))).toBeUndefined()
  })

  it.each([
    'repos/{owner,o}/r/issues',
    'repos/{o}/r/issues',
    'repos/o/r/issues/{1..2}',
    'repos/{ownerx}/r',
    'repos/{owner}/{o,p}/issues',
  ])('still denies the brace group in %s', endpoint => {
    expect(checkCommand(`gh api ${endpoint} -f body=hello`, ctx())).toBe(REASONS.unreadableBody)
  })
})

describe('a gh command the command line hides', () => {
  it.each([
    ['an expanded group that resolves', 'gh "$G" create -t x -b y', { G: 'pr' }],
    ['an expanded verb that resolves', 'gh pr $V -t x -b y', { V: 'create' }],
  ])('denies %s, since flags are not read from an expanded subcommand', (_, command, env) => {
    expect(checkCommand(command, ctx({ env }))).toBe(REASONS.unreadableBody)
  })

  it.each([
    'G=gh; $G pr create -t x -b y',
    '$(command -v gh) pr create -t x -b y',
    '"$(which gh)" api repos/o/r/issues/1/comments -f body=y',
    '`which gh` issue comment 4 -b y',
    '=gh pr create -t x -b y',
    'command "$G" pr edit 3 -b y',
    '$AC gh-write -- pr create -t x -b y',
    '$AC gh-write api repos/o/r/issues/1/comments -f body=y',
  ])('denies %s, whose command word is an expansion', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.hiddenCommand)
  })

  it('checks an expanded command word as git too, and by name once it resolves', () => {
    const env = { GH: '/opt/bin/gh', GIT: 'git' }

    expect(checkCommand('G=git; $G push --no-verify', ctx())).toBe(REASONS.noVerify)
    expect(checkCommand(`$GH pr create -t ${TERM} -b y`, ctx({ env }))).toContain('title line 1')
    expect(checkCommand('"$GIT" push --no-verify', ctx({ env }))).toBe(REASONS.noVerify)
  })

  it.each([
    '$E gh pr create -t x --body-file /w/pr.md',
    '$(true) gh pr create -t x --body-file /w/pr.md',
    '$E $F gh pr create -t x --body-file /w/pr.md',
    '$E command gh pr create -t x --body-file /w/pr.md',
    '$E agent-chat gh-write -- pr create -t x --body-file /w/pr.md',
    "$E gh pr create -t x -F - <<'EOF'\nFILE\nEOF",
    `$E sh -c 'gh pr create -t x -b FILE'`,
  ])('scans %j, whose leading expansion may be empty', command => {
    const holding = (text: string): GuardContext => ctx({ readFile: () => text })

    expect(checkCommand(command.replace('FILE', TERM), holding(TERM))).toContain('line 1 private-term #1')
    expect(checkCommand(command, holding('clean'))).toBeUndefined()
  })

  it('trusts no directory and no variable behind a command word it cannot resolve', () => {
    const read = ctx({ env: { T: '/w' }, readFile: () => 'clean' })

    expect(checkCommand('$E gh pr create -t x --body-file pr.md', read)).toBe(REASONS.unreadableBody)
    expect(checkCommand('$E gh pr create -t x --body-file "$T/pr.md"', read)).toBe(REASONS.unreadableBody)
    expect(checkCommand('gh pr create -t x --body-file "$T/pr.md"', read)).toBeUndefined()
    expect(checkCommand('$E git push --no-verify', read)).toBe(REASONS.noVerify)
  })

  it.each([
    '$EDITOR notes.md',
    '"$X" "$Y" z',
    '$G pr view 12',
    '$G push origin main',
    '$AC gh-write -- pr view 1',
    '$X run -- pr create -t x -b y',
  ])('leaves %s alone', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it.each([
    `C='gh pr create -t x -b y'; eval "$C"`,
    `gh pr view 1; sh -c 'eval "$C"'`,
    'eval "$(cat post.sh)" # gh',
    'eval "$(ssh-agent -s)" && git push',
    'eval $C; gh pr view 1',
  ])('denies %s: eval of unread text on a line that names git or gh', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.hiddenScript)
  })

  it('reads eval text it can resolve, and leaves eval alone on a line without git or gh', () => {
    const env = { T: TERM, V: '--no-verify' }

    expect(checkCommand('eval "gh pr create -t $T -b y"', ctx({ env }))).toContain('title line 1')
    expect(checkCommand('eval "git push $V"', ctx({ env }))).toBe(REASONS.noVerify)
    expect(checkCommand('eval "$(ssh-agent -s)"; npm test', ctx())).toBeUndefined()
    expect(checkCommand('eval "$(fnm env)" && eval "git push --no-verify"', ctx())).toBe(REASONS.hiddenScript)
  })

  it.each(['noglob', 'nocorrect'])('checks gh behind the zsh modifier %s', modifier => {
    expect(checkCommand(`${modifier} gh pr create -t x -b y`, ctx())).toBeUndefined()
    expect(checkCommand(`${modifier} gh pr create -t ${TERM} -b y`, ctx())).toContain('title line 1')
    expect(checkCommand(`${modifier} git push --no-verify`, ctx())).toBe(REASONS.noVerify)
  })

  it.each([
    'repeat 3',
    'caffeinate',
    'caffeinate -i -t 60',
    'caffeinate -w 12',
    'coproc',
    '/usr/bin/nice',
    '/usr/bin/caffeinate -t 60',
  ])('checks gh behind the wrapper %s', wrapper => {
    expect(checkCommand(`${wrapper} gh pr create -t x -b y`, ctx())).toBeUndefined()
    expect(checkCommand(`${wrapper} gh pr create -t ${TERM} -b y`, ctx())).toContain('title line 1')
    expect(checkCommand(`${wrapper} git push --no-verify`, ctx())).toBe(REASONS.noVerify)
  })

  it.each(['export TMP""DIR=/evil', "TMP''DIR=/evil", 'TMP\\DIR=/evil', 'TMP\\\nDIR=/evil'])(
    'denies a variable assigned under a quote-split name: %j',
    assign => {
      const known = ctx({ env: { TMPDIR: '/scratch/tmp' }, readFile: () => 'clean' })

      expect(checkCommand(`${assign}; gh pr create -t x -F "$TMPDIR/pr.md"`, known)).toBe(
        REASONS.unreadableBody,
      )
    },
  )
})

describe('the commands coordinators and agents post with', () => {
  const NO_LIST: TermsLoad = { kind: 'missing' }
  const mergeArgs = (message: string): string =>
    `api -X PUT repos/o/r/pulls/12/merge -f merge_method=squash -f sha=${'a'.repeat(40)} -f commit_message='${message}'`
  const withBody = (terms: TermsLoad, body: string): GuardContext =>
    ctx({ terms, readFile: f => (f === '/work/pr.md' ? body : undefined) })

  const MERGES: [string, (message: string) => string][] = [
    ['gh api merge PUT', message => `gh ${mergeArgs(message)}`],
    ['gh-write merge PUT', message => `agent-chat gh-write -- ${mergeArgs(message)}`],
  ]
  const CREATES: [string, string][] = [
    ['gh pr create --body-file', 'gh pr create --title "Add a feature" --body-file pr.md'],
    ['gh-write pr create', 'agent-chat gh-write -- pr create --title "Add a feature" --body-file pr.md'],
  ]

  it.each(MERGES)('%s: a clean message passes and a term is denied, with a term list', (_, merge) => {
    const reason = checkCommand(merge(`Add a feature (#12)\n\n${TERM}`), ctx())

    expect(checkCommand(merge('Add a feature (#12)'), ctx())).toBeUndefined()
    expectRedacted(reason)
    expect(reason).toContain('field line 3 private-term #1')
  })

  it.each(MERGES)('%s: a clean message passes with no term list, on the generic rules', (_, merge) => {
    const reason = checkCommand(merge(`see ${HOME_PATH}`), ctx({ terms: NO_LIST }))

    expect(checkCommand(merge('Add a feature (#12)'), ctx({ terms: NO_LIST }))).toBeUndefined()
    expectRedacted(reason)
    expect(reason).toContain('field line 1 home-path')
  })

  it.each(MERGES)('%s: still refused while the term list is unreadable', (_, merge) => {
    expect(checkCommand(merge('Add a feature (#12)'), ctx({ terms: { kind: 'unreadable' } }))).toBe(
      REASONS.unreadableTerms,
    )
  })

  it.each(CREATES)('%s: a clean body passes and a term is denied, with a term list', (_, create) => {
    const terms = ctx().terms

    expect(checkCommand(create, withBody(terms, 'Plain text'))).toBeUndefined()
    expect(checkCommand(create, withBody(terms, TERM))).toContain('body line 1 private-term #1')
  })

  it.each(CREATES)('%s: refused with no term list, like the push before it', (_, create) => {
    expect(checkCommand(create, withBody(NO_LIST, 'Plain text'))).toBe(REASONS.missingTerms)
  })

  it('refuses any other gh api write with no term list', () => {
    const comment = 'gh api -X POST repos/o/r/issues/12/comments -f body=hello'

    expect(checkCommand(comment, ctx({ terms: NO_LIST }))).toBe(REASONS.missingTerms)
  })

  it.each([
    "-f body='hello see /repos/o/r/pulls/12/merge'",
    '-f body=hello -f x=/repos/o/r/pulls/12/merge',
    "-f body=hello -H 'X-N: /repos/o/r/pulls/12/merge'",
    '-f body=hello --jq repos/o/r/pulls/12/merge',
    '-f body=hello repos/o/r/pulls/12/merge',
  ])('does not take a comment for a merge because %s names the merge path', rest => {
    const comment = `gh api -X POST repos/o/r/issues/12/comments ${rest}`

    expect(checkCommand(comment, ctx({ terms: NO_LIST }))).toBe(REASONS.missingTerms)
  })

  it('does not take an endpoint that only ends in the merge path for a merge', () => {
    const comment = "gh api -X POST 'repos/o/r/issues/12/comments?x=/repos/o/r/pulls/12/merge' -f body=hello"

    expect(checkCommand(comment, ctx({ terms: NO_LIST }))).toBe(REASONS.missingTerms)
  })
})

describe('a git alias already in config', () => {
  // Fixture repos carry their own aliases; the machine's global and system config stay out.
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

  const repo = (name: string, aliases: Record<string, string>): string => {
    const dir = path.join(SCRATCH, name)
    execFileSync('git', ['init', '-q', dir], { env: GIT_ENV })
    for (const [word, value] of Object.entries(aliases))
      execFileSync('git', ['-C', dir, 'config', `alias.${word}`, value], { env: GIT_ENV })
    return dir
  }

  // The lookup reads a made-up empty home, so a HOME or XDG_CONFIG_HOME the command sets is what it sees.
  const emptyHome = path.join(SCRATCH, 'empty-home')
  const READ_ENV: NodeJS.ProcessEnv = { ...process.env, HOME: emptyHome, XDG_CONFIG_HOME: emptyHome }
  READ_ENV.GIT_CONFIG_NOSYSTEM = '1'
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_WORK_TREE']) delete READ_ENV[name]

  const at = (cwd: string): GuardContext =>
    ctx({ cwd, readAlias: aliasReader(READ_ENV), readIncludedHooksPath: includedHooksPathReader(READ_ENV) })

  const aliased = repo('aliased', {
    pnv: 'push --no-verify',
    'p-nv': 'push --no-verify',
    pnv2: 'push --no-verify',
    quoted: "push '--no-verify' origin",
    chained: 'pnv',
    bang: '!git push --no-verify origin HEAD',
    hp: '-c core.hooksPath=/dev/null push',
    cob: '!git checkout -b $1 && git push -u origin $1',
    loop: 'loop',
    bangloop: '!git bangloop',
  })
  const plain = repo('plain', {})

  it.each([
    'git pnv',
    'git pnv origin HEAD',
    'git quoted main',
    'git chained',
    'git PNV',
    'git p-nv',
    'git pnv2',
  ])('denies a repo alias that expands to push --no-verify: %s', command => {
    expect(checkCommand(command, at(aliased))).toBe(REASONS.noVerify)
  })

  it('denies a ! alias whose body runs git push --no-verify', () => {
    expect(checkCommand('git bang', at(aliased))).toBe(REASONS.noVerify)
  })

  it('denies an alias that sets -c core.hooksPath', () => {
    expect(checkCommand('git hp origin main', at(aliased))).toBe(REASONS.gitConfig)
  })

  it('allows an alias that pushes without skipping the hook', () => {
    expect(checkCommand('git cob feat-x', at(aliased))).toBeUndefined()
  })

  it('denies a ! alias that passes --no-verify through its arguments', () => {
    expect(checkCommand('git cob --no-verify', at(aliased))).toBe(REASONS.noVerify)
  })

  it.each(['git loop', 'git bangloop'])('stops on a self-referencing alias: %s', command => {
    expect(checkCommand(command, at(aliased))).toBe(REASONS.aliasDepth)
  })

  it.each([`cd ${aliased} && git pnv`, `git -C ${aliased} pnv`, `cd ${SCRATCH} && git -C aliased pnv`])(
    'reads the alias where the command cds to: %s',
    command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.noVerify)
    },
  )

  it.each(['git pnv', `cd ${SCRATCH}/missing && git pnv`, 'git status', 'git push origin main'])(
    'allows a git command with no alias where it runs: %s',
    command => {
      expect(checkCommand(command, at(plain))).toBeUndefined()
    },
  )

  describe('where the guard cannot tell the directory or the word', () => {
    const inAliased = (): GuardContext => ({ ...at(aliased), env: { HOME: emptyHome } })

    it.each([
      'source /dev/null; git pnv',
      'set -a; git pnv',
      "trap '' INT; git pnv",
      'pushd .; git pnv',
      'cd ~/../aliased && git pnv',
      `set -a; HOME=${path.join(SCRATCH, 'alias-home')}; git pnv`,
      'S=pnv; git $S',
      'D=x; git -C "$D" pnv',
      'export "$V"; git pnv',
    ])('denies a git word that may be an alias: %s', command => {
      expect(checkCommand(command, inAliased())).toBe(REASONS.aliasEnv)
    })

    it.each(['x=git; $x pnv', '${X:-git} pnv', '"$(echo git)" pnv', 'command $G pnv'])(
      'reads the alias behind a command word that is an expansion: %s',
      command => {
        expect(checkCommand(command, inAliased())).toBe(REASONS.noVerify)
      },
    )

    it.each(['source ./env.sh; x=git; $x pnv', 'source ./env.sh; ${X:-git} pnv'])(
      'denies an expanded command word on a line that names git where it cannot look: %s',
      command => {
        expect(checkCommand(command, inAliased())).toBe(REASONS.aliasEnv)
      },
    )

    it.each([
      `x=git; $x pnv`,
      `git -C ${aliased} push origin main`,
      'source ./env.sh; $EDITOR notes',
      'source ./env.sh; $CD /tmp && git status',
      '$E $F gh pr view 1',
    ])('allows an expanded command word with no alias to follow: %s', command => {
      expect(checkCommand(command, { ...at(plain), env: { HOME: emptyHome } })).toBeUndefined()
    })

    it.each(['git pnv', `cd ${aliased} && git pnv`])(
      'still reads the alias where the directory is known: %s',
      command => {
        expect(checkCommand(command, inAliased())).toBe(REASONS.noVerify)
      },
    )

    it.each([
      'git push origin main',
      'source ./env.sh && git push',
      'git lfs pull',
      'brew --prefix HOMEBREW; git lfs pull',
      'for d in a b; do git -C "$d" status; done',
    ])('allows a builtin, or a word with no alias where it runs: %s', command => {
      expect(checkCommand(command, inAliased())).toBeUndefined()
    })
  })

  describe('in config the command itself points git at', () => {
    const aliasHome = path.join(SCRATCH, 'alias-home')
    const include = path.join(SCRATCH, 'alias-include')
    const gitDir = path.join(aliased, '.git')
    const fwd = repo('fwd', { fwd: '!git incl' })
    fs.mkdirSync(aliasHome)
    fs.writeFileSync(path.join(aliasHome, '.gitconfig'), '[alias]\n\tpnv = push --no-verify\n')
    fs.writeFileSync(include, '[alias]\n\tpnv = push --no-verify\n\tincl = push --no-verify\n')

    it.each([
      `GIT_DIR=${gitDir} git pnv`,
      `HOME=${aliasHome} git pnv`,
      `env GIT_DIR=${gitDir} git pnv`,
      `export GIT_DIR=${gitDir}; git pnv`,
      `export HOME=${aliasHome}; git pnv`,
      `HOME=${aliasHome}; git pnv`,
      `git -c include.path=${include} pnv`,
      `git -cinclude.path=${include} pnv`,
      `E=${include} git --config-env=include.path=E pnv`,
      `git --git-dir=${gitDir} pnv`,
      `git -c include.path=${include} -C ${fwd} fwd`,
    ])('denies an alias found through it: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.noVerify)
    })

    it.each([`git -c alias.x='push --no-verify' x`, `GIT_CONFIG_GLOBAL=${include} git pnv`])(
      'keeps denying config set on the command line: %s',
      command => {
        expect(checkCommand(command, at(plain))).toBeDefined()
      },
    )

    it.each([
      `read GIT_DIR; git pnv`,
      `true && export GIT_DIR=${gitDir}; git pnv`,
      `GIT_DIR=$(cat f) git pnv`,
      `source ./env.sh; git -C ${plain} pnv`,
    ])('denies an alias lookup whose config it cannot follow: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.aliasEnv)
    })

    it.each([`export HOME=${aliasHome}; git status`, `unset GIT_DIR; git pnv`, `HOME=${emptyHome} git pnv`])(
      'allows it where that config holds no alias to follow: %s',
      command => {
        expect(checkCommand(command, at(plain))).toBeUndefined()
      },
    )
  })

  describe('config a command-line include pulls in (TP-602)', () => {
    const hooksCfg = path.join(SCRATCH, 'include-hooks')
    const nameCfg = path.join(SCRATCH, 'include-name')
    const nestedCfg = path.join(SCRATCH, 'include-nested')
    fs.writeFileSync(hooksCfg, '[core]\n\thooksPath = /dev/null\n')
    fs.writeFileSync(nameCfg, '[user]\n\tname = x\n')
    fs.writeFileSync(nestedCfg, `[include]\n\tpath = ${hooksCfg}\n`)
    // git matches gitdir: against the real path, and the scratch dir sits behind a symlink on macOS.
    const inAliased = `includeIf.gitdir:${fs.realpathSync(aliased)}/.path=${hooksCfg}`

    it.each([
      `git -c include.path=${hooksCfg} push`,
      `git -cinclude.path=${hooksCfg} push origin main`,
      `E=${hooksCfg} git --config-env=include.path=E push`,
      `git -c include.path=${nestedCfg} push`,
      `git -c ${inAliased} -C ${aliased} push`,
      `cd ${aliased} && git -c ${inAliased} push`,
    ])('denies an include that sets core.hooksPath: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.includePath)
    })

    it.each([
      `git -c include.path=${nameCfg} push`,
      `E=${nameCfg} git --config-env=include.path=E push`,
      `git -c ${inAliased} push`,
      `git log --grep include`,
    ])('allows an include that leaves core.hooksPath alone: %s', command => {
      expect(checkCommand(command, at(plain))).toBeUndefined()
    })

    it.each([
      'git -c include.path="$(cat f)" push',
      `source ./env.sh; git -c include.path=${hooksCfg} push`,
      'git --config-env=include.path=E push',
    ])('denies an include it cannot read: %s', command => {
      expect(checkCommand(command, { ...at(plain), env: { HOME: emptyHome } })).toBe(REASONS.includePath)
    })

    it.each([
      `git -c include.path=${path.join(SCRATCH, 'include-missing')} push`,
      'git -c include.path=~/include-missing push',
      `E=${path.join(SCRATCH, 'include-missing')} git --config-env=include.path=E push`,
    ])('denies an include whose file does not exist yet: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.includePath)
    })

    it.each([
      `printf '[core]\\n\\thooksPath=X\\n' > ${nameCfg}; git -c include.path=${nameCfg} push`,
      `cp ${hooksCfg} ${nameCfg} && git -c include.path=${nameCfg} push`,
      `echo x | tee ${nameCfg}; git -c include.path=${nameCfg} push`,
    ])('denies an include on a line that writes a file: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.includePath)
    })

    it('allows an include beside a descriptor copy', () => {
      expect(checkCommand(`git -c include.path=${nameCfg} push 2>&1 | tail -3`, at(plain))).toBeUndefined()
    })

    it('denies an include git cannot read within the timeout', () => {
      const fifo = path.join(SCRATCH, 'include-fifo')
      execFileSync('mkfifo', [fifo])

      expect(checkCommand(`git -c include.path=${fifo} push`, at(plain))).toBe(REASONS.includePath)
    })

    it('denies an include git fails to read', () => {
      const circular = path.join(SCRATCH, 'include-circular')
      fs.writeFileSync(circular, `[include]\n\tpath = ${circular}\n`)

      expect(checkCommand(`git -c include.path=${circular} push`, at(plain))).toBe(REASONS.includePath)
    })
  })

  describe('an alias the same command line writes (TP-607)', () => {
    const writeAlias = `git config alias.pnvw '!git push --no-ve""rify'`

    it.each(['&&', ';', '||', '\n'])('denies git config alias then its use joined by %j', joiner => {
      expect(checkCommand(`${writeAlias} ${joiner} git pnvw`, at(plain))).toBe(REASONS.aliasWritten)
    })

    it.each([
      `printf '[alias]\\n\\tpx = push --no-verify\\n' >> .git/config; git px`,
      `echo x | tee -a ~/.gitconfig && git px`,
      `sh -c "git config --global alias.px log"; git px`,
    ])('denies a config file write then an alias: %s', command => {
      expect(checkCommand(command, at(plain))).toBe(REASONS.aliasWritten)
    })

    it.each(['git config user.name x && git push', 'git config user.name x; git status', `${writeAlias}`])(
      'allows a config write with no alias use: %s',
      command => {
        expect(checkCommand(command, at(plain))).toBeUndefined()
      },
    )
  })
})

describe('the hook entry point', () => {
  const input = (command: string): string =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/work', session_id: 's' })

  it('prints a PreToolUse deny, and nothing for an allowed call', () => {
    const out = JSON.parse(pretoolDecision(input('git push --no-verify'), () => ctx())) as {
      hookSpecificOutput: Record<string, string>
    }

    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASONS.noVerify,
    })
    expect(pretoolDecision(input('git push'), () => ctx())).toBe('')
  })

  it('fails closed only for an unreadable call that mentions git', () => {
    expect(pretoolDecision('{"tool_name": 1, "x": "git push"}', () => ctx())).toContain('"deny"')
    expect(pretoolDecision('not json', () => ctx())).toBe('')
  })

  it('reads the default term list, ignoring TITAN_EGRESS_TERMS, and protects the hook dir from the env', () => {
    const cfg = path.join(SCRATCH, 'cfg')
    fs.mkdirSync(path.join(cfg, 'titan-egress'), { recursive: true })
    fs.writeFileSync(path.join(cfg, 'titan-egress', 'private-terms'), `${TERM}\n`, { mode: 0o600 })
    const env = {
      XDG_CONFIG_HOME: cfg,
      TITAN_EGRESS_TERMS: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: path.join(SCRATCH, 'hooks'),
    }
    const built = guardContext(env, '/work', '/home/example')

    expect(built.terms.kind).toBe('ok')
    expect(checkCommand(`gh pr create -t ${TERM} -b x`, built)).toContain('private-term')
    expect(checkCommand(`ls ${path.join(SCRATCH, 'hooks')}`, built)).toBe(REASONS.protectedPath)
  })

  it.skipIf(process.getuid?.() === 0)('reports a term list it cannot read as unreadable, not missing', () => {
    const locked = path.join(SCRATCH, 'locked-terms')
    fs.writeFileSync(locked, `${TERM}\n`, { mode: 0o000 })

    expect(loadTerms(locked)).toEqual({ kind: 'unreadable' })
    expect(loadTerms(SCRATCH)).toEqual({ kind: 'unreadable' })
    expect(loadTerms(path.join(SCRATCH, 'no-such-terms'))).toEqual({ kind: 'missing' })
    expect(checkCommand('gh pr create -t x -b y', ctx({ terms: loadTerms(locked) }))).toBe(
      REASONS.unreadableTerms,
    )
  })

  it('takes an empty term list file for a list', () => {
    const empty = path.join(SCRATCH, 'empty-terms')
    fs.writeFileSync(empty, '', { mode: 0o600 })

    expect(loadTerms(empty)).toEqual({ kind: 'ok', rules: [] })
  })

  it('runs as agent-chat leak-guard pretool from the built CLI', () => {
    const out = execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
      input: input(`git -c core.hooksPath=/dev/null push`),
      env: { PATH: process.env.PATH ?? '', HOME: SCRATCH, XDG_CONFIG_HOME: path.join(SCRATCH, 'none') },
      encoding: 'utf8',
    })

    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(REASONS.gitConfig)
  })

  it('names the rule in the hook output for both done_when forms', () => {
    const reasonFor = (command: string): unknown => {
      const out = execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
        input: input(command),
        env: { PATH: process.env.PATH ?? '', HOME: SCRATCH, XDG_CONFIG_HOME: path.join(SCRATCH, 'none') },
        encoding: 'utf8',
      })
      const hook = JSON.parse(out).hookSpecificOutput
      expect(hook.permissionDecision).toBe('deny')
      return hook.permissionDecisionReason
    }

    expect(reasonFor('git push --no-verify')).toBe(REASONS.noVerify)
    expect(reasonFor('git -c core.hooksPath=/dev/null push')).toBe(REASONS.gitConfig)
  })

  it('expands $TMPDIR in a body file path from the hook process env, from the built CLI', () => {
    const cfg = path.join(SCRATCH, 'cli-cfg')
    const tmp = path.join(SCRATCH, 'cli-tmp')
    fs.mkdirSync(path.join(cfg, 'titan-egress'), { recursive: true })
    fs.mkdirSync(tmp)
    fs.writeFileSync(path.join(cfg, 'titan-egress', 'private-terms'), `${TERM}\n`, { mode: 0o600 })
    const run = (body: string): string => {
      fs.writeFileSync(path.join(tmp, 'pr.md'), body)
      return execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
        input: input('gh pr create -t x --body-file "$TMPDIR/pr.md"'),
        env: { PATH: process.env.PATH ?? '', HOME: SCRATCH, XDG_CONFIG_HOME: cfg, TMPDIR: tmp },
        encoding: 'utf8',
      })
    }

    expect(run('Plain text')).toBe('')
    expect(JSON.parse(run(TERM)).hookSpecificOutput.permissionDecisionReason).toContain(
      'body line 1 private-term #1',
    )
  })
})

describe('the shell splitter', () => {
  it('splits operators, strips quotes and keeps heredoc bodies as stdin', () => {
    const cmds = parseShell(`a 'b c' "d\\"e" f\\ g && h|i; j <<-EOF\n\tbody\n\tEOF\nk`)

    expect(cmds.map(c => c.words)).toEqual([['a', 'b c', 'd"e', 'f g'], ['h'], ['i'], ['j'], ['k']])
    expect(cmds[3]?.stdin).toBe('\tbody')
  })

  it('marks what the shell would expand, and nothing quoted or escaped', () => {
    const [cmd] = parseShell(`a "$X/b" '$Y' \\$Z ~/c d~ *.md "~" "\\$W"`)

    expect(cmd?.marked).toEqual(['a', '\0$X/b', '$Y', '$Z', '\0~/c', 'd~', '\0*.md', '~', '$W'])
    expect(cmd?.words).toEqual(['a', '$X/b', '$Y', '$Z', '~/c', 'd~', '*.md', '~', '$W'])
  })

  it('records how each command is joined and whether it runs in a subshell', () => {
    const cmds = parseShell('a && b |\nc; (d) || e & f "$(g)"')
    const shape = cmds.map(c => [c.words[0], c.before, c.after, c.nested])

    expect(shape).toEqual([
      ['a', '', '&&', false],
      ['b', '&&', '|', false],
      ['c', '|', ';', false],
      ['d', ';', '||', true],
      ['e', '||', '&', false],
      ['g', '', '', true],
      ['f', '&', '', false],
    ])
  })

  it('drops redirection targets and comments', () => {
    expect(parseShell('git push 2>&1 >out.log # --no-verify').map(c => c.words)).toEqual([['git', 'push']])
  })
})
