import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell } from '../leak-guard/shell-words.js'

const MIB = 1 << 20

/** `unit` repeated until the input is 1 MiB; every opener is left unclosed. */
function nested(unit: string): string {
  return unit.repeat(Math.ceil(MIB / unit.length))
}

// Each unit reaches a substitution, so the arithSpan -> substitutionEnd cycle nests; a bare `((`, `$[` or
// `x(` repeat does not recurse and is a scan-cost matter, not a depth one.
const OPENERS: Array<[string, string]> = [
  ['command substitution', '$('],
  ['quoted command substitution', '"$( '],
  ['escaped backticks', '$(\\`'],
  ['funsub', '${ '],
  ['arithmetic substitution', '$(( '],
  ['arithmetic command', '(( $('],
  ['legacy arithmetic', '$[ $('],
  ['glob span', 'x(a $('],
]

describe('parseShell on deeply nested input', { timeout: 60000 }, () => {
  it.each(OPENERS)('1 MiB of nested %s neither throws nor reads as safe', (_name, unit) => {
    const src = nested(unit)
    expect(() => parseShell(src)).not.toThrow()
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it('still yields the inner command at 199 levels', () => {
    const src = '$('.repeat(199) + 'git push --no-verify' + ')'.repeat(199)
    const found = parseShell(src).some((c) => c.words.join(' ') === 'git push --no-verify')
    expect(found).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  it('reads 201 levels as unreadable', () => {
    const src = '$('.repeat(201) + 'git push --no-verify' + ')'.repeat(201)
    expect(expansionRisk(src)).toBe('unreadable')
  })
})

describe('parseShell on very wide input', () => {
  it.each([
    ['$(', ')'],
    ['`', '`'],
  ])('reads a %s substitution holding 300K commands', (open, close) => {
    const src = open + 'a;'.repeat(300000) + close
    let commands: unknown[] = []
    expect(() => (commands = parseShell(src))).not.toThrow()
    expect(commands.length).toBeGreaterThanOrEqual(300000)
  })

  it('reads 2000 lines of a call followed by an open paren in a comment', () => {
    const src = '$(el).css(x) // note: (see below\n'.repeat(2000)
    expect(() => parseShell(src)).not.toThrow()
  })

  it('keeps every write of a long redirect run on one command', () => {
    const src = 'x ' + '>f '.repeat(150000)
    let commands: Array<{ writes: unknown[] }> = []
    expect(() => (commands = parseShell(src))).not.toThrow()
    expect(commands[0]?.writes.length).toBe(150000)
  })
})
