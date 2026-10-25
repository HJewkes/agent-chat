import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-push-'))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

/** The three done_when forms, each at top level, under `sh -c` and in the scripts git hands a shell. */
const DONE_WHEN = [
  'git push --no-verif?',
  'git push origin main --no-verif*',
  '{git,push,--no-verify}',
  '{git,push,--no-verify} origin main',
  "sh -c 'git push --no-verif?'",
  "bash -c 'git push origin --no-verif*'",
  "sh -c '{git,push,--no-verify}'",
  "git rebase -x 'git push --no-verif*' main",
  "git rebase --exec 'git push --no-verif?' main",
  "git rebase -x '{git,push,--no-verify}' main",
  "git submodule foreach 'git push --no-verif?'",
  "git submodule foreach '{git,push,--no-verify}'",
  "git -c core.pager='git push --no-verif*' log",
]

/** git reads a `--` after an option that takes a value as that value, and keeps reading options. */
const SWALLOWED_END = [
  'git push -o -- --no-verif?',
  'git push --push-option -- --no-verif*',
  'git push --repo -- --no-verif?',
  'git push --receive-pack -- --no-verif?',
  'git push --exec -- --no-verif?',
  'git push -fo -- --no-verif?',
  'git push -? -- --no-verif?',
  "sh -c 'git push -o -- --no-verif?'",
  "git rebase -x 'git push -o -- --no-verif*' main",
]

const aliased: GuardContext = {
  ...ctx,
  readAlias: word => (word === 'p' ? { value: 'push', runsIn: '/work' } : undefined),
}

describe('a push option that takes the -- as its value (TP-4235)', () => {
  it.each(SWALLOWED_END)('denies a glob after the swallowed --: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.globPush)
  })

  it('denies a glob after the swallowed -- through an alias for push', () => {
    expect(checkCommand('git p -o -- --no-verif?', aliased)).toBe(REASONS.globPush)
  })

  it.each(['git push -o -- --no-verify', 'git push --push-option -- origin --no-verify'])(
    'denies the literal flag after the swallowed --: %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
    },
  )

  it.each([
    'git push -o x -- --no-verif?',
    'git push --push-option=x -- --no-verif*',
    'git push -o -- -- --no-verif?',
    'git push origin -- --no-verify',
  ])('allows words after a -- no option takes: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('a glob or brace word that may form push or --no-verify (TP-4235)', () => {
  it.each(DONE_WHEN)('denies it at every depth: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.globPush)
  })

  it.each([
    'git push --no-veri?y',
    'git push --no-?erify',
    'git push --*-verify',
    'git push origin -*',
    'git push origin *',
    'echo ok; git push --no-verif?',
    'GIT_TRACE=1 git push --no-verif?',
    '{git,push} origin main',
  ])('denies a glob or brace that may match the flag or push: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.globPush)
  })

  it.each([
    'git push "--no-verif?"',
    "git push '--no-verif*'",
    'sh -c \'git push "--no-verif?"\'',
    'git push --no-verif"y"?',
    'git push -- --no-verif?',
    'git push origin -- *',
    "git push origin 'feat/*'",
    'git push origin feat/x*',
    'git push origin refs/tags/v1.?',
    'git push origin main:refs/heads/rel-*',
    'git push origin feat/{a,b}',
    'git push --force-with-lease=main:* origin',
    'git add *.ts src/{a,b}.ts',
    "git commit -m 'fix *' -- src/*.ts",
    "git rebase -x 'ls *.ts' main",
    '{git,status}',
    'echo {a,b} *',
  ])('allows a quoted glob, or one that cannot form either word: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

/** zsh's EXTENDED_GLOB operators, which the same line can switch on, so `--no-veri#fy` may match `--no-verify`. */
const EXTENDED = [
  'touch -- --no-verify; setopt extendedglob; git push --no-veri#fy origin main',
  'setopt extendedglob; git push origin ^x',
  'zsh -o extendedglob -c "git push --no-verify#"',
  'git push --no-verif~x',
  'git push -o -- --no-verif#y',
  "sh -c 'git push origin ^main'",
]

describe('a zsh extended glob that may form --no-verify (TP-4235)', () => {
  it.each(EXTENDED)('denies it: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.globPush)
  })

  it.each([
    'git push origin fix#12',
    'git push origin main~1:refs/heads/rel',
    'git push origin HEAD^:main',
    'git push ~/repo main',
    'git push -- ^x',
    'git commit -m fix#12',
  ])('allows an operator that cannot form the flag, or one after the --: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('the built guard on the done_when rows (TP-4235)', () => {
  const decide = (command: string): { permissionDecision?: string; permissionDecisionReason?: string } => {
    const out = execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: SCRATCH, session_id: 's' }),
      env: { PATH: process.env.PATH ?? '', HOME: SCRATCH, XDG_CONFIG_HOME: path.join(SCRATCH, 'none') },
      encoding: 'utf8',
    })
    return out.trim() === '' ? {} : (JSON.parse(out).hookSpecificOutput ?? {})
  }

  it('denies each done_when row through the hook', () => {
    const decisions = DONE_WHEN.map(command => decide(command).permissionDecisionReason)

    expect(decisions).toEqual(DONE_WHEN.map(() => REASONS.globPush))
  })

  it('denies a glob after a swallowed -- through the hook', () => {
    const decisions = SWALLOWED_END.map(command => decide(command).permissionDecisionReason)

    expect(decisions).toEqual(SWALLOWED_END.map(() => REASONS.globPush))
  })

  it('denies a zsh extended glob through the hook', () => {
    const decisions = EXTENDED.map(command => decide(command).permissionDecisionReason)

    expect(decisions).toEqual(EXTENDED.map(() => REASONS.globPush))
  })

  it('allows a quoted glob through the hook', () => {
    expect(decide('git push "--no-verif?"').permissionDecision).not.toBe('deny')
  })
})
