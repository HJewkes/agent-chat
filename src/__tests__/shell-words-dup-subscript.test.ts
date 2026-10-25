import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { parseShell, unmark } from '../leak-guard/shell-words.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

const HOOKS = '.agent-chat/git-hooks'
const PUSH = 'git push --no-verify'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: { PATH: '/usr/bin:/bin' },
  protectedPaths: [HOOKS],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const writesOf = (line: string): string[] => parseShell(line).flatMap(cmd => cmd.writes.map(unmark))
const runs = (line: string, words: string[]): boolean =>
  parseShell(line).some(cmd => cmd.words.join(' ') === words.join(' '))

// Each form writes x in at least one of bash and zsh; see the real-shell rows below.
const DUP_WRITES = [
  'cat f >& x',
  'cat f >&x',
  'cat f >>& x',
  'cat f >&| x',
  'cat f >&! x',
  'cat f >&!x',
  'cat f >>&! x',
  'cat f 1>& x',
  'cat f 2>>& x',
  'cat f >&"x"',
  'cat f >! x',
  'cat f >>! x',
  'cat f &>! x',
  '< f >& x',
]

describe('a >& redirect to a word writes it (TP-4257)', () => {
  // Mutation: return 'discard' from duplicateKind for every word, and these rows read no write.
  it.each(DUP_WRITES)('records x as written by %j', line => {
    expect(writesOf(line)).toContain('x')
  })

  // bash reads zsh's `!` as the start of the file name. Mutation: drop noteBashBang, and these
  // record zsh's target alone.
  it.each([
    ['cat f >!x', ['!x', 'x']],
    ['cat f >! x', ['!', 'x']],
    ['cat f >&!x', ['!x', 'x']],
    ['cat f >>!"x"', ['!x', 'x']],
    ['cat f >&!2', ['!2']],
    ['cat f >!~/x', ['!~/x', '~/x']],
  ])('records the targets bash and zsh write for %j', (line, writes) => {
    expect(writesOf(line)).toEqual(writes)
  })

  it.each(['cat /tmp/rc >!b.md', 'cat /tmp/rc >&!b.md', 'cat /tmp/rc >>!b.md'])(
    'denies the body file bash writes for %j',
    write => {
      const readFile = (): string => 'synthetic body\n'
      expect(checkCommand(`${write}; gh pr create -t x --body-file '!b.md'`, { ...ctx, readFile })).toBe(
        REASONS.writtenBody,
      )
    },
  )

  it('records an expanded >& target, which may name a file', () => {
    expect(writesOf('cat f >&$y')).toEqual(['$y'])
  })

  it('records the file 1- zsh writes for 3>&1-, where bash moves a descriptor', () => {
    expect(writesOf('cat f 3>&1-')).toEqual(['1-'])
  })

  // Mutation: return 'write' from duplicateKind for every word, and these rows read a write.
  it.each(['cat f >&2', 'cat f 2>&1 | cat', 'cat f >& -', 'cat f >&"1"', 'cat f 2>&1'])(
    'reads %j as a copy of a descriptor, not a write',
    line => {
      expect(writesOf(line)).toEqual([])
    },
  )

  it.each(['cat /tmp/rc >& "$P"', 'cat /tmp/rc >>& "$P"', 'cat /tmp/rc >&! "$P"', 'cat /tmp/rc 1>& "$P"'])(
    'denies a body file written by %j',
    write => {
      expect(checkCommand(`P=/w/b.md; ${write}; gh pr create -t x --body-file /w/b.md`, ctx)).toBe(
        REASONS.writtenBody,
      )
    },
  )

  it.each(['>&', '>>&', '>&|', '>&!', '1>&'])('denies a write into the hooks dir by %s', op => {
    expect(checkCommand(`cat /tmp/x ${op} ~/${HOOKS}/pre-push`, ctx)).toBe(REASONS.protectedPath)
  })
})

// Each form runs the substitution in at least one of bash and zsh; see the real-shell rows below.
const SUBSCRIPT_RUNS = [
  `printf -v 'a[$(${PUSH})]' y`,
  `printf -va'[$(${PUSH})]' y`,
  `printf -v 'a[\`${PUSH}\`]' y`,
  `builtin printf -v 'a[$(${PUSH})]' y`,
  `test -v 'a[$(${PUSH})]'`,
  `[ -v 'a[$(${PUSH})]' ]`,
  `[[ -v 'a[$(${PUSH})]' ]]`,
  `[[ 'a[$(${PUSH})]' -eq 0 ]]`,
  `[[ -n x && 'b+a[$(${PUSH})]' -gt 0 ]]`,
  `[[ -n x && 'a[$(${PUSH})]' -eq 0 && -n y ]]`,
  `[[ -z x || 'a[$(${PUSH})]' -eq 0 || -n y ]]`,
  `[[ ( 'a[$(${PUSH})]' -gt 0 ) ]]`,
  `[[ ! ( 'a[$(${PUSH})]' -gt 0 ) ]]`,
  `test -v "a[\\$(${PUSH})]"`,
  `read 'a[$(${PUSH})]' < /dev/null`,
  `declare 'a[$(${PUSH})]=1'`,
  `let 'a[$(${PUSH})]'`,
  `a=(1 2); unset 'a[$(${PUSH})]'`,
]

// Builtins outside any list the guard once kept; each runs the substitution in one shell only.
const ONE_SHELL_RUNS: [string, 'bash' | 'zsh'][] = [
  [`sleep 0 & wait -n -p 'a[$(${PUSH})]'`, 'bash'],
  [`getopts x 'a[$(${PUSH})]' -x`, 'zsh'],
  [`zmodload zsh/datetime; strftime -s 'a[$(${PUSH})]' %s 0`, 'zsh'],
  [`zstyle :x y z; zstyle -s :x y 'a[$(${PUSH})]'`, 'zsh'],
  [`zmodload zsh/param/private; private 'a[$(${PUSH})]'=1`, 'zsh'],
]

describe('a quoted subscript a builtin evaluates runs its substitution (TP-4257)', () => {
  // Mutation: return before the loop in readSubscripts, and no row reads the push.
  it.each([...SUBSCRIPT_RUNS, ...ONE_SHELL_RUNS.map(([line]) => line)])(
    'reads the push in %j as a command',
    line => {
      expect(runs(line, ['git', 'push', '--no-verify'])).toBe(true)
      expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
    },
  )

  // The shell evaluates the substitution's output as arithmetic again. Mutation: drop the
  // expandsCommand check, and these allow.
  it.each(['read "a[$(cat f)]" < /dev/null', 'printf -v "a[`cat f`]" y', 'printf -v a[$(cat f)] y'])(
    'denies %j, whose subscript evaluates text the guard cannot read',
    line => {
      expect(checkCommand(line, ctx)).toBe(REASONS.operatorExpansion)
    },
  )

  // Only a known-inert command name skips the read. Mutation: return true from inertOperands for any
  // name, and these allow.
  it.each([
    `getln 'a[$(${PUSH})]'`,
    `some-new-builtin 'a[$(${PUSH})]'`,
    `printf -- '%s' 'a[$(${PUSH})]'`,
    `printf "$f" 'a[$(${PUSH})]'`,
    `c=echo; $c 'a[$(${PUSH})]'`,
    `echo() { read "$1"; }; echo 'a[$(${PUSH})]'`,
    `function echo { read "$1"; }; echo 'a[$(${PUSH})]'`,
    `alias echo=read\necho 'a[$(${PUSH})]'`,
  ])('reads the push in %j, whose command is not known to be inert', line => {
    expect(checkCommand(line, ctx)).not.toBeUndefined()
  })

  it.each([
    `echo 'a[$(${PUSH})]'`,
    `printf '%s' 'a[$(${PUSH})]'`,
    `print 'a[$(${PUSH})]'`,
    `git commit -m 'fix a[$(${PUSH})]'`,
    `printf '%s\\n' 'a=$(${PUSH})'`,
    '[[ "[$(date)]" == x ]]',
    `read -r 'a[1]' < /dev/null`,
    'printf -v x %s "${arr[@]}"',
  ])('allows %j, which evaluates no subscript holding a substitution', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })
})

describe("'< f | sh' feeds the file to the shell (TP-4257)", () => {
  it.each(['< push.sh | sh', '< push.sh | bash', '< push.sh | zsh -f'])(
    'denies %j as a piped script',
    line => {
      expect(checkCommand(line, { ...ctx, protectedPaths: [] })).toBe(REASONS.pipedScript)
    },
  )
})

const REAL_SHELLS = [
  ['zsh', '/bin/zsh', ['-f']],
  ['bash', '/bin/bash', ['--noprofile', '--norc']],
] as const

/** The files the shell creates running `line` in a scratch dir holding `f`. */
function newFiles(shell: string, flags: readonly string[], line: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp4257-'))
  try {
    fs.writeFileSync(path.join(dir, 'f'), 'synthetic rc\n')
    const env = { PATH: '/usr/bin:/bin' }
    try {
      execFileSync(shell, [...flags, '-c', line], { cwd: dir, env, stdio: 'ignore' })
    } catch {
      // A shell that rejects the form writes nothing.
    }
    return fs.readdirSync(dir).filter(file => file !== 'f')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The files each shell writes for a form the two read apart; the guard records every one.
const SPLIT_FILES: [string, { zsh: string[]; bash: string[] }][] = [
  ['cat f >!x', { zsh: ['x'], bash: ['!x'] }],
  ['cat f >! x', { zsh: ['x'], bash: ['!'] }],
  ['cat f >&!x', { zsh: ['x'], bash: ['!x'] }],
  ['cat f 3>&1-', { zsh: ['1-'], bash: [] }],
]

// Which shells write x for each form: zsh writes every one; bash only `>&` and `1>&` to a word.
const BASH_WRITES = new Set(['cat f >& x', 'cat f >&x', 'cat f 1>& x', 'cat f >&"x"', '< f >& x'])

describe('the >& family against real shells (TP-4257)', () => {
  for (const [name, shell, flags] of REAL_SHELLS) {
    it.skipIf(!fs.existsSync(shell)).each(DUP_WRITES)(
      `${name} writes x or rejects %j as the guard reads it`,
      line => {
        expect(newFiles(shell, flags, line).includes('x')).toBe(name === 'zsh' || BASH_WRITES.has(line))
      },
    )

    it.skipIf(!fs.existsSync(shell)).each(['cat f >&2', 'cat f >& -', 'cat f >&"1"'])(
      `${name} writes no file for %j`,
      line => {
        expect(newFiles(shell, flags, line)).toEqual([])
      },
    )

    it.skipIf(!fs.existsSync(shell)).each(SPLIT_FILES)(
      `${name} writes only recorded targets for %j`,
      (line, files) => {
        const written = newFiles(shell, flags, line)
        expect(written).toEqual(files[name])
        expect(writesOf(line)).toEqual(expect.arrayContaining(written))
      },
    )
  }
})

const real = fakeGitShells('tp4257-subscript-', PUSH)
afterAll(real.cleanup)

// bash runs the substitution of every row; zsh of these, and not of test, `[[` or a glued `-v`.
const ZSH_RUNS = new Set([
  `printf -v 'a[$(${PUSH})]' y`,
  `printf -v 'a[\`${PUSH}\`]' y`,
  `builtin printf -v 'a[$(${PUSH})]' y`,
  `read 'a[$(${PUSH})]' < /dev/null`,
  `declare 'a[$(${PUSH})]=1'`,
  `a=(1 2); unset 'a[$(${PUSH})]'`,
])

describe.skipIf(real.shells.length === 0)('quoted subscripts against real shells (TP-4257)', () => {
  it.each(SUBSCRIPT_RUNS)('the shells that evaluate the subscript push for %j', line => {
    const pushed = real.shells.filter(
      ([shell, args]) => real.gitCalls(shell, args, line) === 'push --no-verify',
    )
    const expected = real.shells.filter(([shell]) => !shell.endsWith('zsh') || ZSH_RUNS.has(line))

    expect(pushed.map(([shell]) => shell)).toEqual(expected.map(([shell]) => shell))
  })

  it.each(ONE_SHELL_RUNS)('%j pushes only under %s', (line, runner) => {
    const pushed = real.shells.filter(
      ([shell, args]) => real.gitCalls(shell, args, line) === 'push --no-verify',
    )
    const expected = real.shells.filter(([shell]) => shell.endsWith(runner))

    expect(pushed.map(([shell]) => shell)).toEqual(expected.map(([shell]) => shell))
  })

  it('zsh runs the file a bare redirect pipes into sh, and bash does not', () => {
    const pushed = real.shells.filter(([shell, args]) => real.gitCalls(shell, args, '< push.sh | sh') !== '')

    expect(pushed.map(([shell]) => shell)).toEqual(real.hasZsh ? ['/bin/zsh'] : [])
  })
})
