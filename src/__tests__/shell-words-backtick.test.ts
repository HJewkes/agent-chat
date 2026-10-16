import { describe, expect, it } from 'vitest'
import { parseShell } from '../leak-guard/shell-words.js'

/**
 * The shell skips each backslash pair while it looks for a closing backtick, then drops the
 * backslash before `$`, `` ` `` and `\` (and `"` inside double quotes) before it parses the body,
 * so `` echo `\`cmd\`` `` runs cmd (CC-1350).
 */

const heads = (line: string): string[] => parseShell(line).map(cmd => cmd.words[0] ?? '')

// Each row names the mutation in src/leak-guard/shell-words.ts that makes it fail.
const LISTED: [string, string][] = [
  // backtick() ends at the first backtick again (until('`')).
  ['plain', 'echo `\\`cmd\\``'],
  ['double-quoted', 'echo "`\\`cmd\\``"'],
  ['assignment', 'x=`\\`cmd\\``'],
  // backtickBody unescapes only the backtick, not `\\`.
  ['three levels', 'echo `echo \\`echo \\\\\\`cmd\\\\\\`\\``'],
  ['inside $(( ))', 'echo $(( `echo \\`cmd\\`` ))'],
  ['an unknown escape before it', 'echo `echo \\x\\`cmd\\``'],
  // `$` left out of backtickBody's set.
  ['an escaped $(', 'echo `echo \\$(cmd)`'],
  ['a heredoc body', 'cat <<E\n`echo \\`cmd\\``\nE'],
]

const LITERAL: [string, string][] = [
  // backtickEnd stops at an escaped backtick, or the body is unescaped twice.
  ['an escaped backslash before the backtick', 'echo `echo \\\\\\`cmd\\\\\\``'],
  ['a single-quoted body', "echo `echo '\\`cmd\\`'`"],
  ['an escaped backslash before $(', 'echo `echo \\\\$(cmd)`'],
]

describe('parseShell on nested escaped backticks', () => {
  it.each(LISTED)('lists the nested command: %s', (_how, line) => {
    expect(heads(line)).toContain('cmd')
  })

  it.each(LITERAL)('does not list a command the shell prints: %s', (_how, line) => {
    expect(heads(line)).not.toContain('cmd')
  })

  // backtickBody keeps `\"` inside double quotes: the inner echo's word is then `"`cmd`"`.
  it('drops the backslash before " only inside double quotes', () => {
    const quoted = parseShell('echo "`echo \\"\\`cmd\\`\\"`"')
    const plain = parseShell('echo `echo \\"\\`cmd\\`\\"`')

    expect(quoted.map(cmd => cmd.words)).toEqual([
      ['cmd'],
      ['echo', '`cmd`'],
      ['echo', '`echo \\"\\`cmd\\`\\"`'],
    ])
    expect(plain.find(cmd => cmd.words[0] === 'echo')?.words).toEqual(['echo', '"`cmd`"'])
  })

  // skipQuoted ends a backtick at the first backtick again: the span then never closes and no body is kept.
  it('keeps the arithmetic text past a nested escaped backtick', () => {
    const cmd = parseShell('(( `echo \\`echo 1\\`` + b ))').find(c => c.arith)

    expect(cmd?.arithBodies).toEqual(['   + b '])
  })

  it('reads an unclosed backtick body to the end of the line', () => {
    expect(heads('echo `\\`cmd')).toContain('cmd')
  })
})
