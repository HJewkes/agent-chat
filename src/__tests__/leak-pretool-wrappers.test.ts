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

describe('stdbuf and ionice run the command after their options (CC-1223)', () => {
  it.each([
    'stdbuf -o0 git push --no-verify',
    'stdbuf -o L git push --no-verify',
    'stdbuf --output=L git push --no-verify',
    'stdbuf --output L -e 0 git push --no-verify',
    'ionice -c3 git push --no-verify',
    'ionice -c 3 -n 7 git push --no-verify',
    'ionice --class 3 --classdata 7 git push --no-verify',
    '/usr/bin/stdbuf -i0 nice ionice -t git push --no-verify',
  ])('denies a push that skips hooks behind it: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each(['ionice -c3 env -u GIT_CONFIG_COUNT git push', 'stdbuf -oL env GIT_CONFIG_COUNT=0 git push'])(
    'denies a git config variable it carries: %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.gitConfigEnv)
    },
  )

  it.each([
    'stdbuf -oL tail -f log',
    'stdbuf -o L git push',
    'ionice -c3 make',
    'ionice -c 2 -n 0 git status',
  ])('allows a command that pushes nothing past hooks: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
