import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { pretoolDecision, REASONS, type GuardContext } from '../leak-guard/pretool.js'

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
const HIDDEN_PUSH = "; g''it push --no-verify origin x"
const BIG = 1e6

const decide = (command: string): string =>
  pretoolDecision(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), ctx)

describe('leak-guard call-argument spreads over attacker-sized input', () => {
  it('denies a hidden push after a tee with 1M operands', () => {
    const out = decide(`echo x | tee ${'a '.repeat(BIG)}${HIDDEN_PUSH}`)
    expect(out).toContain(REASONS.noVerify)
  })

  it('denies a hidden push after an env with 1M assignments', () => {
    const out = decide(`env ${'A=1 '.repeat(BIG)}true${HIDDEN_PUSH}`)
    expect(out).toContain(REASONS.noVerify)
  })

  it('denies a hidden push after 1M carried redirects', () => {
    const out = decide(`${'>a '.repeat(BIG)}; true${HIDDEN_PUSH}`)
    expect(out).toContain(REASONS.noVerify)
  })

  it('denies a hidden push after a substitution with 1M commands', () => {
    const out = decide(`echo $(${'true;'.repeat(BIG)})${HIDDEN_PUSH}`)
    expect(out).toContain(REASONS.noVerify)
  })
})
