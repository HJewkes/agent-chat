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
    const found = parseShell(src).some(c => c.words.join(' ') === 'git push --no-verify')
    expect(found).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  it.each([200, 201])('reads %i levels as unreadable', depth => {
    const src = '$('.repeat(depth) + 'git push --no-verify' + ')'.repeat(depth)
    expect(expansionRisk(src)).toBe('unreadable')
  })
})

// A worker thread has a larger stack than the main thread, so the spread limit is reached at the larger
// size here; the smaller size is what the hook meets on the main thread.
describe('parseShell on very wide input', () => {
  it.each([
    { open: '$(', close: ')', count: 300000 },
    { open: '$(', close: ')', count: 600000 },
    { open: '`', close: '`', count: 300000 },
    { open: '`', close: '`', count: 600000 },
  ])('reads a $open substitution holding $count commands', ({ open, close, count }) => {
    const src = open + 'a;'.repeat(count) + close
    let commands: unknown[] = []
    expect(() => (commands = parseShell(src))).not.toThrow()
    expect(commands.length).toBeGreaterThanOrEqual(count)
  })

  it.each([2000, 4000])('reads %i lines of a call followed by an open paren in a comment', lines => {
    const src = '$(el).css(x) // note: (see below\n'.repeat(lines)
    expect(() => parseShell(src)).not.toThrow()
  })

  it.each([
    ['a run of writes with no command, then a command', '>f '.repeat(600000) + '\nx'],
    ['a run of write-only lines, then a command', '>f\n'.repeat(600000) + 'x'],
  ])('keeps every write of %s', (_name, src) => {
    let commands: Array<{ writes: unknown[] }> = []
    expect(() => (commands = parseShell(src))).not.toThrow()
    expect(commands.at(-1)?.writes.length).toBe(600000)
  })
})
