import { describe, expect, it, vi } from 'vitest'
import { arithSubstitutions } from '../leak-guard/arith-subscript.js'
import { parseShell } from '../leak-guard/shell-words.js'

// parseShell can throw (RangeError on deep recursion). The module reads each quoted opener with its own call,
// which starts at the opener; that call throws here, while the line's own parse, which starts elsewhere, does not.
vi.mock('../leak-guard/shell-words.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../leak-guard/shell-words.js')>()
  return {
    ...actual,
    parseShell: (src: string) => {
      if (src.startsWith('$(THROW')) throw new RangeError('Maximum call stack size exceeded')
      if (src.startsWith('$(SLOW')) {
        const until = performance.now() + 300
        while (performance.now() < until);
      }
      return actual.parseShell(src)
    },
  }
})

describe('a parseShell throw or slow call inside the module', () => {
  it('reports the rest from the opener as the sentinel, not [] and not an error', () => {
    const line = "n='x[$(THROW git push --no-verify)]'"
    expect(arithSubstitutions(parseShell(line))).toEqual(['$(THROW git push --no-verify)]'])
  })

  it('stops at the deadline and reports the rest as the sentinel', () => {
    const line = `n='${Array.from({ length: 60 }, (_, i) => `x[$(SLOW ${i}) ]${'y'.repeat(300)}`).join(' ')}'`
    const parsed = parseShell(line)
    const start = performance.now()
    const bodies = arithSubstitutions(parsed)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(bodies.at(-1)).toMatch(/^\$\(SLOW/)
    expect(bodies.length).toBeLessThan(60)
  })
})
