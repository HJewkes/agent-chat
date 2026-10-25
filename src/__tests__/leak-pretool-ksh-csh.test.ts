import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * mksh and csh are checked shells, and ksh, mksh and csh have their options read as observed in
 * mksh 59c, ksh93u+m 1.0.10, bsd-csh 20240808 and tcsh 6.24 (CC-1631). Where a shell is on PATH, the
 * real one with a fake `git` first on PATH confirms each push row pushes and each allowed row does not.
 */

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const P = 'git push --no-verify origin HEAD:main'
const PUSHED = 'push --no-verify origin HEAD:main'

const PUSHES: Record<'ksh' | 'mksh' | 'csh', string[]> = {
  ksh: [`ksh -c '${P}'`, `ksh -ec '${P}'`, `ksh -c -- '${P}'`, `ksh -o -c '${P}'`, `ksh -s -c '${P}'`],
  mksh: [
    `mksh -c '${P}'`,
    `mksh -ec '${P}'`,
    `mksh -c -e '${P}'`,
    `mksh -o errexit -c '${P}'`,
    `mksh -oerrexit -c '${P}'`,
    `mksh -co errexit '${P}'`,
    `mksh +o errexit -c '${P}'`,
    // mksh reads `-o -c` as the letter c.
    `mksh -o -c '${P}'`,
    `mksh -s -c '${P}'`,
    `echo '${P}' | mksh`,
    `mksh <<'EOF'\n${P}\nEOF`,
    `env mksh -c '${P}'`,
  ],
  csh: [
    `csh -c '${P}'`,
    `csh -fc '${P}'`,
    `csh -cf '${P}'`,
    `csh -x -c '${P}'`,
    `csh -s -c '${P}'`,
    `echo '${P}' | csh`,
    `env csh -c '${P}'`,
  ],
}

// Rows one implementation runs: mksh's -T forks a detached copy, ksh93 runs a script operand no file
// has as a command line with the later operands appended, and bsd-csh ignores the letters it does not know.
const ONE_SHELL_PUSHES = [
  `mksh -T - -c '${P}'`,
  `mksh -T- -c '${P}'`,
  `ksh -T - -c '${P}'`,
  `ksh '${P}'`,
  `ksh +c '${P}'`,
  `ksh 'git push' --no-verify origin HEAD:main`,
  `csh --c '${P}'`,
  `csh -Z -c '${P}'`,
  `/bin/mksh -c '${P}'`,
  `/bin/csh -c '${P}'`,
]

// csh rewrites `!` history in the text it reads, so `!#:1` is the line's second word.
const HISTORY = [
  `csh -c 'echo --no-verify; git push !#:1 origin HEAD:main'`,
  `echo 'echo --no-verify; git push !#:1 origin HEAD:main' | csh`,
]

const NOT_PUSHED = [
  // The string is `echo hi`, and the push is $0.
  `ksh -c 'echo hi' '${P}'`,
  `mksh -c 'echo hi' '${P}'`,
  // `-o` takes `c` as its option name, so errexit is the script, run with the push as its argument.
  `ksh -oc errexit '${P}'`,
  // csh runs the word after -c, here `-x`; and -b ends the options, so -c is a script file.
  `csh -c -x '${P}'`,
  `csh -b -c '${P}'`,
]

const ALLOWED = [
  `ksh -c 'git status'`,
  'ksh script.ksh',
  'mksh script.mksh',
  `mksh -o -c 'echo hi'`,
  `csh -c 'echo hi'`,
  'csh script.csh',
  `csh -c 'echo hi!'`,
  ...NOT_PUSHED,
]

describe('ksh, mksh and csh run their -c string and stdin checked (CC-1631)', () => {
  it.each([...Object.values(PUSHES).flat(), ...ONE_SHELL_PUSHES])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each(HISTORY)('denies %s, whose text csh rewrites', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.cshHistory)
  })

  it.each(ALLOWED)('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })
})

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '')
    .split(':')
    .filter(dir => dir !== '')
    .find(dir => fs.existsSync(path.join(dir, name)))

const found = { ksh: onPath('ksh'), mksh: onPath('mksh'), csh: onPath('csh') }
const dirs = Object.values(found).filter((dir): dir is string => dir !== undefined)
const real = fakeGitShells('agent-chat-ksh-csh-', P, [...new Set(dirs)])
afterAll(real.cleanup)
const SH = real.shells.find(([shell]) => shell.endsWith('bash'))
const run = (line: string): string => {
  const [shell, args] = SH as [string, string[]]
  return real.gitCalls(shell, args, line)
}

describe.each(Object.entries(PUSHES))('real %s', (name, lines) => {
  const has = found[name as keyof typeof found] !== undefined && SH !== undefined
  it.skipIf(!has).each(lines)('%s pushes', line => {
    expect(run(line)).toBe(PUSHED)
  })

  const quiet = NOT_PUSHED.filter(line => line.startsWith(`${name} `))
  it.skipIf(!has).each(quiet)('%s pushes nothing', line => {
    expect(run(line)).toBe('')
  })
})

describe.skipIf(found.csh === undefined || SH === undefined)('real csh', () => {
  it.each(HISTORY)('%s pushes with --no-verify', line => {
    expect(run(line)).toMatch(/^push --no-verify/)
  })
})
