import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const PUSH = 'git push --no-verify'
const DENIES = [REASONS.noVerify, REASONS.operatorExpansion]
const inSub = (body: string): string => `echo "$(${body}; ${PUSH})"`

// A line, whether zsh and bash run its push, and its row in the CC-1324 plan.
type Row = { line: string; zsh: boolean; bash: boolean; row: string }
const zshOnly = (row: string, line: string): Row => ({ line, zsh: true, bash: false, row })

/**
 * Inside a `$( )` or subshell the splitter reads only the case grammar bash and zsh share; any other
 * case form there is unreadable, since a pattern's `)` could end the span and hide the push (CC-1324).
 */
const BYPASSES: Row[] = [
  zshOnly('1 T1', inSub('case x in x) :;| y) echo "a";; esac')),
  zshOnly('1 T1', inSub('case x in x) :;|y) echo "a";; esac')),
  zshOnly('1 T1', inSub('case x in x) :\n;| y) echo "a";; esac')),
  zshOnly('2 T2', inSub('case x { x) echo "a";; }')),
  zshOnly('2 T2', inSub('case x {x) echo "a";; }')),
  zshOnly('2 T2', inSub('case x;{ x) echo "a";; }')),
  zshOnly('2 T2', inSub('case x\n{ x) echo "a";; }')),
  zshOnly('2 T2', inSub('case x { x|z) echo "a";; }')),
  zshOnly('2 T2', inSub('case x { x) echo "a";; esac')),
  zshOnly('3 T2', inSub('case x;in x) :;; y) echo "a";; esac')),
  { line: inSub('case x\nin x) echo "a";; esac'), zsh: true, bash: true, row: '4 T2' },
  zshOnly('5 T1 T2', inSub('case x { x) { :; } ;| y) echo "a";; }')),
  { line: inSub('case x in x) { :; };; y) echo "a";; esac'), zsh: true, bash: true, row: '6 T3' },
  zshOnly('7 T3', inSub('case x in x) {:;} ;; y) echo "a";; esac')),
  zshOnly('7 T3', inSub('case x in x) {:;};; y) echo "a";; esac')),
  zshOnly('7 T3', inSub('case x in x) {echo;} ;; y) echo "a";; esac')),
  zshOnly('7 T3', inSub('case x in x) {: ;} ;; y) echo "a";; esac')),
  zshOnly('7 T3', inSub('case x in x) :; {:;} ;; y) echo "a";; esac')),
  zshOnly('8 T2', inSub('case x { x) {:;} ;; y) echo "a";; }')),
  zshOnly('9 T3', `echo "$(case x in x) :;; } # c\n)"; ${PUSH}`),
  zshOnly('9 T3', `echo "$(case x in x) :;; } )"; ${PUSH}`),
  zshOnly('9 T3', inSub('case x in x) echo "a";; }')),
  { line: inSub('case } in x) :;; }) echo "b";; esac'), zsh: false, bash: true, row: '9 T3' },
  { line: inSub('case } in x) :;; }|y) echo "b";; esac'), zsh: false, bash: true, row: '9 T3' },
  zshOnly('10 T4', inSub('repeat 1 case x # c\nin x) :;; y) echo "a";; esac')),
  zshOnly('10 T4', inSub('repeat 1 case x # c\n{ x) :;; y) echo "a";; }')),
  zshOnly('10 T4', inSub('repeat 2 case x #\nin x) :;; y) echo "a";; esac')),
  zshOnly('10 T4', inSub('repeat 1 case x \\\nin x) :;; y) echo "a";; esac')),
  zshOnly('10 T4', inSub('repeat 1 case x in x) echo "a";; esac')),
  zshOnly('10 T4', inSub('repeat 1 case x { x) echo "a";; }')),
  zshOnly('10', inSub('() { case x in x) echo "a";; esac }')),
  zshOnly('10', inSub('() { case x { x) echo "a";; } }')),
  zshOnly('11', inSub('case x { (x) echo "a";; }')),
  zshOnly('11', `echo $(case x in x) :;| y) echo "a";; esac; ${PUSH})`),
  ...['(x))', '(x|(y)))', 'x|(y))', '((x)))', '(x)|y)', '(x)y)', '(x) |y)', '(x) )', '( x))'].map(pattern =>
    zshOnly('12', inSub(`case x in ${pattern} :;; z) echo "a";; esac`)),
  ),
  zshOnly('12', inSub('case x in x) :;; (z)) echo "a";; esac')),
  ...['(x) \\\n|y)', '(x) \\\n)', '(x)\t\\\n |y)', '(x) \\\n\\\n|y)', '(x)  \\\n\t |y)'].map(pattern =>
    zshOnly('13', inSub(`case x in ${pattern} :;; z) echo "a";; esac`)),
  ),
  zshOnly('12', `echo $(case x in (x)) :;; z) echo "a";; esac; ${PUSH})`),
  zshOnly('12', `echo "\`case x in (x)) :;; z) echo a;; esac; ${PUSH}\`"`),
]

/** Case lines in the shared grammar, or outside any span a `)` can end, which stay readable. */
const ALLOWED = [
  'x="$(case "$a" in foo) echo 1;; *) echo 2;; esac)"; git status',
  'x="$(case "$a" in\n  foo) echo 1;;\n  *) echo 2;;\nesac)"',
  'x="$(case "$a" in (foo) echo 1;; (*) echo 2;; esac)"',
  'x="$(case "$a" in foo) case "$b" in bar) echo 1;; esac;; esac)"',
  'x="$(case "$a" in foo) echo 1;; esac; case "$b" in bar) echo 2;; esac)"',
  'x="$(case "$a" in foo) echo 1;& bar) echo 2;;& *) echo 3;; esac)"',
  'echo "$(case $a in x) echo "${b}";; esac)"',
  'case x in x) { echo a; } ;; esac',
  'x="$(case "$a" in (foo|bar) echo 1;; (*) ;; esac)"',
  'x="$(case "$a" in (foo) echo 1 ;; (*)\n echo 2;; esac)"',
  'case x in (x|(y))) echo a;; esac',
  'x="$(case "$a" in (foo) \\\n echo 1;; (*) "$b" # c\n;; esac)"',
  'echo "$(echo case)"',
  'echo "$(grep -c case f)"',
]

/** Lines the shells read alike that the boundary still refuses: the accepted cost of not modelling zsh. */
const FALSE_DENIES = [
  'x="$(case "$a" in x) { echo a; echo b; } ;; *) echo c;; esac)"',
  'x=$(case $a in (x) echo ${b} {p,q};; esac)',
  'x=$(case $a\nin x) echo a;; esac)',
  'echo "$(case x in x) echo a;| y) echo b;; esac)"',
  'echo $(echo case x in y)',
]

/** Runs `line` in a real shell where `git` is a function that records its words in a file. */
function shellRuns(shell: string, flags: string[], line: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-case-zsh-'))
  const marker = path.join(dir, 'ran')
  try {
    const fake = `git(){ printf '%s\\n' "$*" >> "$M"; }\n`
    const env = { M: marker, PATH: '/usr/bin:/bin' }
    try {
      execFileSync(shell, [...flags, '-c', fake + line], { env, stdio: 'ignore' })
    } catch {
      // A parse error in one shell is the point of a row; only the marker matters.
    }
    return fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'push --no-verify\n'
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const SHELLS = [
  ['zsh', '/bin/zsh', ['-f']],
  ['bash', '/bin/bash', ['--noprofile', '--norc']],
] as const

describe('a case form the shells read apart, inside a $( ) or subshell (CC-1324)', () => {
  it.each(BYPASSES)('denies row $row: $line', ({ line }) => {
    expect(DENIES).toContain(checkCommand(line, ctx))
  })

  for (const [name, shell, flags] of SHELLS) {
    it.skipIf(!fs.existsSync(shell)).each(BYPASSES)(`${name} runs the push as row $row says: $line`, row => {
      expect(shellRuns(shell, [...flags], row.line)).toBe(row[name])
    })
  }

  it.each(ALLOWED)('allows a case the shells agree on: %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })

  it.each(FALSE_DENIES)('denies a line with no git, an accepted cost: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.operatorExpansion)
  })
})
