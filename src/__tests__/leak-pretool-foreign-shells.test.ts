import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * The guard reads only shells with an observed grammar: sh, ash, bash, dash and zsh. Any other shell
 * it knows by name, and any shell named by value that it does not read, denies on every line, whatever
 * its text (CC-1631). Where a shell is on PATH, the real one with a fake `git` first on PATH confirms
 * each push row pushes. Observed in ksh93u+m 1.0.10, mksh 59c, bsd-csh 20240808 and tcsh 6.24.
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

// None spells git where an sh scan would see it, so a deny gated on that scan let each through.
const CSH_HISTORY = `csh -c 'echo xit pxsh --no-verxfy ; !#:1:s/x/g/ !#:2:s/x/u/ !#:3:s/x/i/ origin HEAD:main'`
const FISH_PIECES = `fish -c '(printf gi)t (printf pu)sh --no-(printf ver)ify origin HEAD:main'`
const TCSH_EDITS = `tcsh -c '$shell:t:s/tcsh/gi/t $shell:t:s/tc/pu/ --no-ve$shell:t:s/tcsh/rify/ origin HEAD:main'`
const NO_GIT_WORD = [
  FISH_PIECES,
  `rc -c 'gi^t pu^sh --no-ver^ify origin HEAD:main'`,
  `printf 'gi\npu\nver\n' | csh -c '"$<"t "$<"sh --no-"$<"ify origin HEAD:main'`,
  CSH_HISTORY,
  TCSH_EDITS,
  `fish -c 'eval (string join "" g i t) (string join "" p u s h) (string join -- "" --no- ver ify) origin HEAD:main'`,
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

// A shell named by value that the guard does not read denies the same way, listed or not.
const BY_VALUE = [
  `su -s /bin/csh -c 'nice +5 ${P}'`,
  `su -s /bin/ksh93 -c '${P}'`,
  `capsh --shell=/bin/csh -- -c 'hup ${P}'`,
  `SHELL=/bin/tcsh script -c '${P}'`,
  `su -s /bin/csh -c '${CSH_HISTORY.slice("csh -c '".length, -1)}'`,
  `capsh --shell=/bin/fish -- -c '${FISH_PIECES.slice("fish -c '".length, -1)}'`,
  `SHELL=/bin/tcsh script -qc '${TCSH_EDITS.slice("tcsh -c '".length, -1)}' /dev/null`,
  `su -s /usr/bin/elvish -c 'echo hi'`,
  `SHELL=/usr/bin/elvish doas -s <<< 'echo hi'`,
]

// No text is read, so a foreign shell denies on any line, with git or without.
const OVER_DENY = [
  `ksh -c 'git status'`,
  `csh -c 'git log -1'`,
  `git status && ksh -c 'echo hi'`,
  `echo 'git status' | ksh`,
  'mksh build.mksh && git status',
  `csh -c 'echo hi'`,
  `ksh -c 'echo hi'`,
  `tcsh -c 'ls -la'`,
  `fish -c 'echo hi'`,
  'ksh --version',
]

// A $SHELL the guard cannot resolve keeps its reason, which denies only on a line that may reach git.
const UNRESOLVED_SHELL_VAR = [
  `SHELL=$X script -qc 'echo hi' /dev/null`,
  `SHELL=$X script -qc 'git status' /dev/null`,
]

const ALLOWED = [
  'which ksh csh; git status',
  UNRESOLVED_SHELL_VAR[0] as string,
  `bash -c 'git status'`,
  `zsh -c 'git log -1'`,
  `sh -c 'git status'`,
  `su -s /bin/bash -c 'git status' bob`,
  `ash -c 'git push -n origin HEAD:main'`,
]

describe('a shell the guard has no grammar for denies on every line (CC-1631)', () => {
  it.each([...FIX_FIRST, ...NO_GIT_WORD, ...BY_NAME, ...BY_VALUE, ...OVER_DENY])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.foreignShell)
  })

  it('denies a $SHELL it cannot resolve only on a line that may reach git', () => {
    expect(checkCommand(UNRESOLVED_SHELL_VAR[1] as string, ctx)).toBe(REASONS.jobShell)
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
