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

/** A case whose pattern `)` once closed the quoted `$( )` early, so the push read as part of a string (CC-1324). */
const BYPASSES = [
  `echo "$(case x in x) :;| y) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x in x) :;|y) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x in x) :\n;| y) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x { x) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x {x) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x\n{ x) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x;{ x) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x { x|z) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x { x) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x in x) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x { x) { :; } ;| y) echo "a" ;; }; ${PUSH})"`,
  `echo "$(case x;in x) :;; y) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x\nin x) :;; y) echo "a" ;; esac; ${PUSH})"`,
  `echo "$(case x { x) :;; }; case y { y) echo "a" ;; }; ${PUSH})"`,
]

/** Where a pattern is due, zsh closes the case at `}` and bash reads `})` or `}|y)` as a pattern. */
const SPLIT: [string, string, string[]][] = [
  // bash allows only blanks between a pattern and its `)`, so here only zsh's close runs.
  ['/bin/zsh', `echo "$(case x in x) :;; } # c\n)"; ${PUSH}`, ['-f']],
  ['/bin/zsh', `echo "$(case x { x) :;; })"; ${PUSH}`, ['-f']],
  ['/bin/zsh', `echo "$(case x in x) :;; } )"; ${PUSH}`, ['-f']],
  ['/bin/bash', `echo "$(case } in x) :;; }) echo "b";; esac; ${PUSH})"`, ['--noprofile', '--norc']],
  ['/bin/bash', `echo "$(case } in x) :;; }|y) echo "b";; esac; ${PUSH})"`, ['--noprofile', '--norc']],
]

const ZSH = ['/bin/zsh', ['-f']] as const
const BASH = ['/bin/bash', ['--noprofile', '--norc']] as const
// A shell, its flags and the line it runs.
type Row = readonly [string, readonly string[], string]

/** A `}` or `esac` touching a terminator, which once updated the case frames after the terminator read them. */
const TOUCHING: Row[] = [
  // zsh has no `;;&`, and bash no `;|`.
  ...[';;', ';&', ';;&'].map(
    op => [...BASH, `echo "$(case x in x) { :; }${op} y) echo "a";; esac; ${PUSH})"`] as const,
  ),
  ...[';;', ';&', ';|'].map(
    op => [...ZSH, `echo "$(case x { x) { :; }${op} y) echo "a";; }; ${PUSH})"`] as const,
  ),
  [...BASH, `echo "$(case x in x) case y in y) :;; esac;; z) echo "a";; esac; ${PUSH})"`],
]

/** A `case` zsh reads as a command where the splitter reads an argument: after `repeat N` and in `() {`. */
const STRAY: Row[] = [
  [...ZSH, `echo "$(repeat 1 case x # c\nin x) :;; y) echo "a";; esac; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 case x # c\n{ x) :;; y) echo "a";; }; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 2 case x #\nin x) :;; y) echo "a";; esac; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 case x\n# c\nin x) :;; y) echo "a";; esac; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 case x \\\nin x) :;; y) echo "a";; esac; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 case x in x) echo "a";; esac; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 case x { x) echo "a";; }; ${PUSH})"`],
  [...ZSH, `echo "$(repeat 1 { case x { x) echo "a";; } }; ${PUSH})"`],
  [...ZSH, `echo "$(() { case x in x) echo "a";; esac }; ${PUSH})"`],
  [...ZSH, `echo "$(() { case x { x) echo "a";; } }; ${PUSH})"`],
]

const BENIGN = [
  'echo "$(echo case x)"',
  'echo "$(grep -c case f)"',
  'echo "$(case x in x) echo a;| y) echo b;; esac)"',
  'case x { x) echo a;; }',
  'echo "$(case x { x) { echo a; } ;; })"',
  'case x;in x) :;; esac',
]

/** Runs `line` in a real shell where `git` is a function that records its words in a file. */
function shellRuns(shell: string, flags: string[], line: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-case-zsh-'))
  const marker = path.join(dir, 'ran')
  try {
    const fake = `git(){ printf '%s\\n' "$*" >> "$M"; }\n`
    execFileSync(shell, [...flags, '-c', fake + line], {
      env: { M: marker, PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
    })
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('a zsh case pattern does not end a quoted $( ) (CC-1324)', () => {
  it.each(BYPASSES)('denies the push after the case: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.skipIf(!fs.existsSync('/bin/zsh')).each(BYPASSES)('zsh runs the push: %s', line => {
    expect(shellRuns('/bin/zsh', ['-f'], line)).toBe('push --no-verify\n')
  })

  it.skipIf(!fs.existsSync('/bin/bash'))('bash runs the push after a newline before in', () => {
    expect(shellRuns('/bin/bash', ['--noprofile', '--norc'], BYPASSES[12] as string)).toBe(
      'push --no-verify\n',
    )
  })

  it.each(SPLIT)('denies a } that the shells read apart, which %s runs: %s', (shell, line, flags) => {
    expect(checkCommand(line, ctx)).toBeDefined()
    if (fs.existsSync(shell)) expect(shellRuns(shell, flags, line)).toBe('push --no-verify\n')
  })

  it.each(TOUCHING)('denies the push after a touching close, which %s runs: %s', (shell, flags, line) => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
    if (fs.existsSync(shell)) expect(shellRuns(shell, [...flags], line)).toBe('push --no-verify\n')
  })

  it.each(STRAY)('denies a case only zsh reads as a command, which %s runs: %s', (shell, flags, line) => {
    expect(checkCommand(line, ctx)).toBeDefined()
    if (fs.existsSync(shell)) expect(shellRuns(shell, [...flags], line)).toBe('push --no-verify\n')
  })

  it.each(BENIGN)('allows a case with no git: %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })
})
