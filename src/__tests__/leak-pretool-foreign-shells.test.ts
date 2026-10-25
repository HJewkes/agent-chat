import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * The guard reads only shells with an observed grammar: sh, ash, bash, dash and zsh. Any other shell
 * it knows by name denies on a line that may reach git or gh, whatever its text (CC-1631). Where a
 * shell is on PATH, the real one with a fake `git` first on PATH confirms each push row pushes.
 * Observed in ksh93u+m 1.0.10, mksh 59c, bsd-csh 20240808 and tcsh 6.24.
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

// Each ran as a --no-verify push under a real ksh93, bsd-csh or tcsh, where an earlier round read it as sh.
const KSH93_OPERANDS = [
  `ksh 'git --work-tree' '#' ${PUSHED}`,
  `ksh 'git -C' '#' ${PUSHED}`,
  `ksh 'git push' --no-verify origin HEAD:main`,
  `F=--no-verify; ksh 'git push' "$F" origin HEAD:main`,
  `ksh 'git push' "$(printf -- --no-verify)" origin HEAD:main`,
]
const CSH_TEXT = [
  `csh -c 'echo "a\\" ; ${P} ; #"'`,
  `echo 'echo "a\\" ; ${P} ; #"' | csh`,
  `csh -c 'echo --no-verify; git push !#:1 origin HEAD:main'`,
  `csh -c 'nice +5 ${P}'`,
  `echo 'nice +5 ${P}' | csh`,
  `csh -c '@ x = { ${P} }'`,
  `csh -c 'exit { ${P} }'`,
  `echo 'exit { ${P} }' | csh`,
]
const FIX_FIRST = [
  ...KSH93_OPERANDS,
  ...CSH_TEXT,
  `csh -c 'echo "\\" ; ${P} ; echo "\\"'`,
  `csh -c 'set g=g; $g"it" ${PUSHED}'`,
  `csh -c 'hup ${P}'`,
  `ksh -R x -c '${P}'`,
  `ksh --rcfile x -c '${P}'`,
]

// The shell is the resolved program word's base name, past wrappers and quotes; argv0 never counts.
const BY_NAME = [
  `tcsh -c '${P}'`,
  `ksh93 -c '${P}'`,
  `lksh -c '${P}'`,
  `mksh -c '${P}'`,
  `mksh -T x -c '${P}'`,
  `fish -c '${P}'`,
  `yash -c '${P}'`,
  `/usr/bin/tcsh -c 'nice +5 ${P}'`,
  `env tcsh -c 'hup ${P}'`,
  `exec -a sh /bin/csh -c 'nice +5 ${P}'`,
  `sudo csh -c 'hup ${P}'`,
  `nohup csh -c 'hup ${P}'`,
  `c''sh -c 'hup ${P}'`,
  `echo x | xargs csh -c 'hup ${P}'`,
  `find . -exec csh -c 'hup ${P}' \\;`,
]

// A shell named by value that the guard does not read fails closed, under the wrapper's own reason.
const BY_VALUE: [string, string][] = [
  [`su -s /bin/csh -c 'nice +5 ${P}'`, REASONS.privilegeOption],
  [`su -s /bin/ksh93 -c '${P}'`, REASONS.privilegeOption],
  [`capsh --shell=/bin/csh -- -c 'hup ${P}'`, REASONS.privilegeOption],
  [`SHELL=/bin/tcsh script -c '${P}'`, REASONS.jobShell],
]

// No text is read, so a foreign shell on any line that may reach git denies.
const OVER_DENY = [
  `ksh -c 'git status'`,
  `csh -c 'git log -1'`,
  `git status && ksh -c 'echo hi'`,
  `echo 'git status' | ksh`,
  'mksh build.mksh && git status',
]

const ALLOWED = [
  `csh -c 'echo hi'`,
  `ksh -c 'echo hi'`,
  `tcsh -c 'ls -la'`,
  `fish -c 'echo hi'`,
  'ksh --version',
  'which ksh csh; git status',
  `bash -c 'git status'`,
  `zsh -c 'git log -1'`,
  `sh -c 'git status'`,
  `su -s /bin/bash -c 'git status' bob`,
  `ash -c 'git push -n origin HEAD:main'`,
]

describe('a shell the guard has no grammar for denies on a line that may reach git (CC-1631)', () => {
  it.each([...FIX_FIRST, ...BY_NAME, ...OVER_DENY])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.foreignShell)
  })

  it.each(BY_VALUE)('denies %s', (line, reason) => {
    expect(checkCommand(line, ctx)).toBe(reason)
  })

  it.each([`sh -c '${P}'`, `bash -c '${P}'`])('still reads %s as sh', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
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

const isKsh93 = (): boolean => {
  try {
    return execFileSync('ksh', ['-c', 'echo ${.sh.version}'], { encoding: 'utf8' }).includes('93')
  } catch {
    return false
  }
}

// The rows each real shell runs as a push. `ksh` must be ksh93 for its missing-file runs.
const REAL: Record<string, string[]> = {
  csh: CSH_TEXT,
  tcsh: [`tcsh -c '${P}'`, `tcsh -c 'hup ${P}'`],
  ksh: KSH93_OPERANDS,
  ksh93: [`ksh93 -c '${P}'`],
  mksh: [`mksh -c '${P}'`],
  lksh: [`lksh -c '${P}'`],
}
const found = Object.fromEntries(Object.keys(REAL).map(name => [name, onPath(name)]))
const dirs = Object.values(found).filter((dir): dir is string => dir !== undefined)
const real = fakeGitShells('agent-chat-foreign-shells-', P, [...new Set(dirs)])
afterAll(real.cleanup)
const BASH = real.shells.find(([shell]) => shell.endsWith('bash'))

describe.each(Object.entries(REAL))('real %s', (name, lines) => {
  const has = found[name] !== undefined && BASH !== undefined && (name !== 'ksh' || isKsh93())
  it.skipIf(!has).each(lines)('%s pushes with --no-verify', line => {
    const [shell, args] = BASH as [string, string[]]
    expect(real.gitCalls(shell, args, line)).toMatch(/(?:^| )push --no-verify origin HEAD:main$/)
  })
})
