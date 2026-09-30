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
  pretoolDecision,
  REASONS,
  type GuardContext,
  type TermsLoad,
} from '../leak-guard/pretool.js'
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
  home: '/home/example',
  env: {},
  protectedPaths: [
    '/cfg/titan-egress/private-terms',
    'titan-egress/private-terms',
    '.agent-chat/git-hooks',
    HOOKS_DIR,
  ],
  readFile: () => undefined,
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
  const holding = (file: string, body: string): GuardContext =>
    ctx({ env: { TMPDIR: TMP }, readFile: f => (f === file ? body : undefined) })
  const anyFileIsClean = ctx({ env: { TMPDIR: TMP }, readFile: () => 'clean' })

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
    ['a glob', '$TMPDIR/*.md'],
    ['a tilde with a user name', '~zq7user/pr.md'],
  ])('denies %s rather than guessing the file', (_, file) => {
    expect(checkCommand(`gh pr create -t x --body-file ${file}`, holding(`${TMP}/pr.md`, 'clean'))).toBe(
      REASONS.unreadableBody,
    )
    expect(checkCommand(`gh pr create -t x --body-file ${file}`, anyFileIsClean)).toBe(REASONS.unreadableBody)
  })

  it.each([
    ['single-quoted', "'$TMPDIR/pr.md'"],
    ['escaped', '\\$TMPDIR/pr.md'],
  ])('reads a %s variable as the literal file name, as the shell does', (_, file) => {
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
    expect(checkCommand(inBody, holding(`${TMP}/pr.md`, TERM))).toContain('cat file line 1 private-term #1')
    expect(checkCommand(inBody, ctx())).toBe(REASONS.unreadableBody)
    expect(checkCommand('gh pr create -t x -b "`cat b.md`"', holding('/work/b.md', TERM))).toContain(
      'cat file line 1 private-term #1',
    )
  })
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

  it('runs as agent-chat leak-guard pretool from the built CLI', () => {
    const out = execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
      input: input(`git -c core.hooksPath=/dev/null push`),
      env: { PATH: process.env.PATH ?? '', HOME: SCRATCH, XDG_CONFIG_HOME: path.join(SCRATCH, 'none') },
      encoding: 'utf8',
    })

    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(REASONS.gitConfig)
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

  it('drops redirection targets and comments', () => {
    expect(parseShell('git push 2>&1 >out.log # --no-verify').map(c => c.words)).toEqual([['git', 'push']])
  })
})
