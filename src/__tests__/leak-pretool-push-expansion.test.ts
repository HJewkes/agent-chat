import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * A git push word that starts with `-` and holds an expansion the guard cannot read can still spell
 * `--no-verify` (CC-1438). Each deny row is a line, the shell prefix that gives its variables the
 * value that builds the flag, and the argv a real shell passes a fake git first on PATH.
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

const PUSH = 'push --no-verify origin HEAD:main'
// [line, shell prefix, argv, runs the same in zsh]
const DENIED: [string, string, string, boolean][] = [
  ['git push "--no-${V:-verify}" origin HEAD:main', '', PUSH, true],
  ['git push "--no-${V}verify" origin HEAD:main', '', PUSH, true],
  ['git push "--no-${V}verify" origin HEAD:main', 'V=; ', PUSH, true],
  ['git push "--no-$(echo verify)" origin HEAD:main', '', PUSH, true],
  ['git push "--no-`echo verify`" origin HEAD:main', '', PUSH, true],
  ['git push "--no-veri${X}fy" origin HEAD:main', '', PUSH, true],
  ['git push "--no-${V:+x}verify" origin HEAD:main', 'V=; ', PUSH, true],
  ['git push $"--no-$V" origin HEAD:main', 'V=verify; ', PUSH, false],
  ['git push $"--no-${V:-verify}" origin HEAD:main', '', PUSH, false],
]

const ALLOWED = [
  'git push origin "$BRANCH"',
  'git push origin "HEAD:${B:-main}"',
  'git push -u origin "$(git branch --show-current)"',
  'git push "$REMOTE" "$BRANCH"',
  'git push --push-option="ci.skip=$X" origin feat/x',
  'git push origin "refs/heads/${B}"',
  'git commit -m "fix $(date)"',
  'git push origin --tags',
  'git push -- "--no-$X" origin main',
  'git push "-u$X" origin main',
]

describe('checkCommand on a push option built by an expansion (CC-1438)', () => {
  it.each(DENIED.map(([line]) => line))('denies %j', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.noVerify)
  })

  it.each(ALLOWED)('allows %j', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-push-expansion-')))
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

describe.skipIf(BASH === undefined)('bash builds --no-verify from each denied line (CC-1438)', () => {
  it.each(DENIED)('runs %j after %j as git %j', (line, prefix, argv) => {
    expect(gitCalls(BASH as string, ['--noprofile', '--norc'], prefix + line)).toEqual([argv])
  })
})

describe.skipIf(ZSH === undefined)(
  'zsh builds --no-verify from the denied lines without $"…" (CC-1438)',
  () => {
    it.each(DENIED.filter(([, , , zsh]) => zsh))('runs %j after %j as git %j', (line, prefix, argv) => {
      expect(gitCalls(ZSH as string, ['-f'], prefix + line)).toEqual([argv])
    })
  },
)
