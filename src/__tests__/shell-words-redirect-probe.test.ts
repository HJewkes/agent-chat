import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { pretoolDecision, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { LIVE, parseShell, unmark } from '../leak-guard/shell-words.js'

// The `<n-m>` glob probe once copied the rest of the line at every `<` and `>`, so carried redirects took quadratic time (CC-1379).
const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

// The quote split hides `git` from the raw-line prefilter, so only the parsed path can deny.
const HIDDEN_PUSH = "; true; g''it push --no-verify origin x"
const BIG = 1e6
// The quadratic probe took 12-26 s here; linear runs take 1-3 s on a loaded CI runner, so these budgets leave margin both ways.
const DENY_BUDGET_MS = 8000
const PARSE_BUDGET_MS = 4000

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

describe('carried redirects over attacker-sized input', () => {
  it('denies a hidden push after 1M carried redirects in under 8 s', () => {
    const command = `${'>a '.repeat(BIG)}${HIDDEN_PUSH}`
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

    const { value, ms } = timed(() => pretoolDecision(input, ctx))

    expect(value).toContain(REASONS.noVerify)
    expect(ms).toBeLessThan(DENY_BUDGET_MS)
  })

  it.each(['>a ', '<a ', '&>a ', '2>a ', '>>a ', '<<<a ', '<1-9> '])(
    'parses 1M %j units in under 4 s',
    unit => {
      const { value, ms } = timed(() => parseShell(`${unit.repeat(BIG)}${HIDDEN_PUSH}`))

      expect(ms).toBeLessThan(PARSE_BUDGET_MS)
      expect(unmark(value.at(-1)?.marked[0] ?? '')).toBe('git')
    },
  )
})

const shape = (src: string) =>
  parseShell(src).map(({ marked, writes, stdinLive }) => ({ marked, writes, stdinLive }))
const one = (marked: string[], writes: string[] = [], stdinLive = false) => [{ marked, writes, stdinLive }]

describe('the <n-m> glob next to redirects', () => {
  it.each([
    ['echo <1-9>', one(['echo', `${LIVE}<1-9>`])],
    ['echo <1\\\n-9>', one(['echo', `${LIVE}<1-9>`])],
    ['echo <->', one(['echo', `${LIVE}<->`])],
    ['echo <\\\n1-9\\\n>', one(['echo', `${LIVE}<1-9>`])],
    ['echo <12-345>x y', one(['echo', `${LIVE}<12-345>x`, 'y'])],
    ['cat 2<1-9>', one(['cat', `2${LIVE}<1-9>`])],
    ['echo <1-9>>f', one(['echo', `${LIVE}<1-9>`], ['f'])],
    ['cat <1-x>', one(['cat'], [], true)],
    ['cat < 1-9>', one(['cat'], [], true)],
    ['cat <1-9', one(['cat'], [], true)],
  ])('reads %j as zsh does', (src, expected) => {
    expect(shape(src)).toEqual(expected)
  })

  it('reads an escaped backslash before a newline as no join', () => {
    expect(shape('echo <\\\\\n1-9>')).toEqual([
      { marked: ['echo'], writes: [], stdinLive: true },
      { marked: ['1-9'], writes: [], stdinLive: false },
    ])
  })
})

// The regex the cursor walk replaced, kept as the oracle for where a glob starts.
const oldProbe = (src: string, at: number): string | undefined =>
  /^<\d*-\d*>/.exec(src.slice(at).replaceAll('\\\n', ''))?.[0]

const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}

describe('the <n-m> glob probe against the old regex', () => {
  it('finds a glob exactly where the old probe did over 5,000 seeded lines', () => {
    const random = seeded(1379)
    const alphabet = ['>', '-', '0', '9', 'a', ' ', '\\', '\n']
    for (let n = 0; n < 5000; n++) {
      const tail = Array.from(
        { length: 1 + Math.floor(random() * 12) },
        () => alphabet[Math.floor(random() * 8)],
      )
      const src = `echo <${tail.join('')}`
      const range = oldProbe(src, 'echo '.length)

      const marked = parseShell(src).flatMap(command => command.marked)

      const glob = marked.find(word => word.includes(`${LIVE}<`))
      expect(glob === undefined ? undefined : glob.slice(glob.indexOf('<'), glob.indexOf('>') + 1), src).toBe(
        range,
      )
    }
  })
})

describe('a redirect-only command keeps the text the shell expands where it stands (TP-2499)', () => {
  it.each([
    'git fetch o; > ${!A:=ext}',
    'trap "git fetch o" EXIT && > ${!A:=ext}',
    'trap "git fetch o" EXIT; 2> ${!A:=ext}',
    'trap "git fetch o" EXIT; 3<<<${!A:=ext}',
    'trap "git fetch o" EXIT\n> ${!A:=ext}',
    'trap "git fetch o" EXIT; 3<<E\n${!A:=ext}\nE',
    '3<<E\n${!A:=ext}\nE\ngit fetch o',
    'trap "git fetch o" EXIT; cat <<E; > ${!A:=ext}\nE',
  ])('returns a command whose expanded text holds the assignment: %j', line => {
    const expanded = parseShell(line).flatMap(command => command.expanded.map(unmark))

    expect(expanded.some(text => text.includes('${!A:=ext}'))).toBe(true)
  })
})
