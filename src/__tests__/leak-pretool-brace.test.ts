import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * A brace expansion after `git push` that may spell an option, a sequence such as
 * `--no-verif{y..y}` as much as a list such as `--no-verif{y,}`, is denied (CC-1427). Real shells
 * with a fake `git` first on PATH confirm what each line runs.
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

// On main every row here was allowed. Dropping braceSpellsOption from spellsOption allows them all again.
const DENIED = [
  'git push --no-verif{y..y} origin HEAD:main',
  // bash runs `git push --no-verifx --no-verify origin HEAD:main`.
  'git push --no-verif{x..y} origin HEAD:main',
  'git push --no-verif{y,} origin HEAD:main',
  'git push origin {main,--no-verify}',
  "bash -c 'git push --no-verif{y..y} origin HEAD:main'",
  "zsh -c 'git push --no-verif{y..y} origin HEAD:main'",
  // zsh's sequence runs over any single characters, and `{+../}` yields `-`.
  'git push origin {+../}-no-verify',
  "git push --rec{e..e}ive-pack='git push --no-verify' origin",
]

const ALLOWED = [
  'for i in {1..3}; do echo $i; done',
  'mkdir -p d{1..3}',
  'echo {a..c}',
  'touch f{01..03}.txt',
  'git log -{1..1}',
  'git add f{1..3}.txt',
  'git push origin HEAD:feat/{a,b}',
  // As `git commit --no-verify` is: the pre-push scan still runs.
  'git commit --no-verif{y..y} -m x',
  'gh api repos/{owner}/{repo}/pulls',
]

describe('checkCommand on brace expansions (CC-1427)', () => {
  it.each(DENIED)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it.each(ALLOWED)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it('reads a sequence that spells a branch as the branch it spells', () => {
    expect(checkCommand('git push origin HEAD:mai{n..n}', ctx())).toBe(
      checkCommand('git push origin HEAD:main', ctx()),
    )
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-brace-')))
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

describe.skipIf(BASH === undefined)('bash expands brace sequences in what git receives (CC-1427)', () => {
  const bash = (src: string): string[] => gitCalls(BASH as string, ['--noprofile', '--norc'], src)

  it.each([
    ['git push --no-verif{y..y} origin HEAD:main', 'push --no-verify origin HEAD:main'],
    ['git push origin HEAD:mai{n..n}', 'push origin HEAD:main'],
    ['git push --no-verif{x..y} origin HEAD:main', 'push --no-verifx --no-verify origin HEAD:main'],
  ])('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })

  it('leaves a zsh character sequence as written', () => {
    expect(bash('git push origin {+../}-no-verify')).toEqual(['push origin {+../}-no-verify'])
  })
})

describe.skipIf(ZSH === undefined)('zsh expands brace sequences in what git receives (CC-1427)', () => {
  const zsh = (src: string): string[] => gitCalls(ZSH as string, ['-f'], src)

  it('runs a letter sequence as the flag it spells', () => {
    expect(zsh('git push --no-verif{y..y} origin HEAD:main')).toEqual(['push --no-verify origin HEAD:main'])
  })

  it('runs a character sequence that yields - as --no-verify', () => {
    expect(zsh('git push origin {+../}-no-verify')).toEqual([
      'push origin +-no-verify ,-no-verify --no-verify .-no-verify /-no-verify',
    ])
  })
})
