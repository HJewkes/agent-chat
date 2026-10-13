import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const TERM = 'zq7privateseat'
const REAL_HOME = '/srv/agent'

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: { HOME: REAL_HOME },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const READ = 'gh api "repos/o/r/commits/$SHA/check-runs"'

describe('a gh call that sets a gh config home (CC-733)', () => {
  it.each([
    'GH_CONFIG_DIR=/tmp/x',
    'XDG_CONFIG_HOME=/tmp/x',
    'HOME=/tmp/x',
    'HOME+=x',
    'HOME[0]=/tmp/x',
    'HOME="$x"',
    'GH_CONFIG_DIR="$x"',
    'XDG_CONFIG_HOME="$x"',
    'env GH_CONFIG_DIR=/tmp/x',
    'env -- XDG_CONFIG_HOME=/tmp/x',
    "env -S 'HOME=/tmp/x'",
  ])('denies an unread gh api read behind %s', prefix => {
    expect(checkCommand(`${prefix} ${READ}`, ctx())).toBe(REASONS.ghConfigHome)
  })

  it('denies a standalone config-home assignment on the line of an unread read', () => {
    expect(checkCommand('GH_CONFIG_DIR=/tmp/x; gh api "repos/o/r/commits/$SHA"', ctx())).toBe(
      REASONS.ghConfigHome,
    )
  })

  it.each([
    'GH_CONFIG_DIR=/tmp/x gh pr create -t x -b ok',
    'env HOME=/tmp/x gh issue comment 1 --body ok',
    'XDG_CONFIG_HOME=/tmp/x agent-chat gh-write -- pr comment 1 --body ok',
  ])('denies the gh write %s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghConfigHome)
  })

  it.each([
    `HOME=${REAL_HOME} gh api "repos/o/r/commits/$SHA"`,
    READ,
    'env -u GH_CONFIG_DIR gh pr create -t x -b ok',
    'gh pr create -t x -b ok',
    'HOME=/tmp/x gh pr view 1',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})
