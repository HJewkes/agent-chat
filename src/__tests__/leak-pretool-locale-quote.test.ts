import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * bash reads `$"…"` (locale translation) as a double-quoted string, so `git push $"--no-verify"` runs
 * `git push --no-verify` (CC-1430). zsh reads a literal `$` and then the string. The guard reads the
 * bash form. Real shells with a fake `git` first on PATH confirm what each line runs.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

// On main every row here was allowed. Dropping the `$"` case from wordPart allows them again.
// Each line with what bash 5.3 passes git.
const DENIED: [string, string][] = [
  ['git push $"--no-verify" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push $"--no-verif"{y,} origin HEAD:main', 'push --no-verify --no-verif origin HEAD:main'],
  ['git push {,}$"--no-verify" origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push {x,$"--no-verify"} origin HEAD:main', 'push x --no-verify origin HEAD:main'],
  ['git push $"--no-""verify" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push $"--no-verify"$"" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['bash -c \'git push $"--no-verify" origin HEAD:main\'', 'push --no-verify origin HEAD:main'],
]

// Expansions inside `$"…"` behave as they do inside "…".
const EXPANDING = ['${V:-verify}', '$(echo verify)', '`echo verify`', '$V']

const ALLOWED: [string, string][] = [
  ['echo $"hello"', ''],
  ['git commit -m $"msg"', 'commit -m msg'],
  ['printf $"%s\\n" x', ''],
  ['git log --format=$"%H"', 'log --format=%H'],
  ['git push origin HEAD:feat/x', 'push origin HEAD:feat/x'],
  // `$"` inside quotes is text and changes nothing.
  ['git commit -m "$"--no-verify', 'commit -m $--no-verify'],
  ['git commit -m \'$"--no-verify"\'', 'commit -m $"--no-verify"'],
  ['git commit -m "cost $\\"--no-verify\\""', 'commit -m cost $"--no-verify"'],
]

describe('checkCommand on bash locale quoting (CC-1430)', () => {
  it.each(DENIED.map(([src]) => src))('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it.each(EXPANDING)('reads $"--no-%s" as it reads "--no-%s"', body => {
    const plain = checkCommand(`git push "--no-${body}" origin HEAD:main`, ctx())
    expect(checkCommand(`git push $"--no-${body}" origin HEAD:main`, ctx())).toBe(plain)
  })

  it.each(ALLOWED.map(([src]) => src))('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-locale-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : undefined
const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : undefined

/** The argument lines `shell -c src` passed the fake git. */
function gitCalls(shell: string, args: string[], src: string): string[] {
  fs.rmSync(RECORD, { force: true })
  execFileSync(shell, [...args, '-c', src], { env: ENV, cwd: ROOT, stdio: 'ignore' })
  return fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8').trim().split('\n') : []
}

describe.skipIf(BASH === undefined)('bash runs $"…" as a double-quoted string (CC-1430)', () => {
  const bash = (src: string): string[] => gitCalls(BASH as string, ['--noprofile', '--norc'], src)

  it.each(DENIED.filter(([src]) => !src.startsWith('bash -c')))('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })

  it.each(ALLOWED.filter(([src]) => src.startsWith('git ')))('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })
})

describe.skipIf(ZSH === undefined)('zsh reads $"…" as a literal $ and a string (CC-1430)', () => {
  it('passes git $--no-verify, which is no option', () => {
    expect(gitCalls(ZSH as string, ['-f'], 'git push $"--no-verify" origin HEAD:main')).toEqual([
      'push $--no-verify origin HEAD:main',
    ])
  })
})
