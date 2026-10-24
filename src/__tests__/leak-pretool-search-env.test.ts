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

describe('PATH or a loader variable set to a value the guard cannot read, on a line that may reach git (CC-1236)', () => {
  it.each([
    'LD_PRELOAD=$X git push',
    'LD_PRELOAD="$X" git push',
    'env LD_PRELOAD="$X" git push',
    'PATH=$(mktemp -d) git push',
    'PATH="$X" git push',
    'env PATH="$X" git push',
    'export PATH="$X"; git push',
    'PATH=/usr/bin:$X git push',
    'PATH+=:$X git push',
    'read PATH; git push',
    ': ${PATH:=/x}; git push',
    'env -S "PATH=/x git push"',
    'LD_LIBRARY_PATH=$X git push',
    'LD_AUDIT=$X git push',
    'DYLD_INSERT_LIBRARIES=$X git push',
    'DYLD_LIBRARY_PATH=$X git push',
    'echo p | xargs env PATH="$X" git push origin --',
  ])('denies searchPathEnv: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.searchPathEnv)
  })

  it('lets a per-command reason win over an unreadable PATH on the same line', () => {
    expect(checkCommand('PATH="$X" git push --no-verify', ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'PATH=/usr/bin:/bin git push',
    'PATH=/opt/git/bin:$PATH git push',
    'PATH="/opt/git/bin:${PATH}" git status',
    'LD_PRELOAD=/usr/lib/libfake.so git status',
    'env PATH=/usr/bin git push',
    'PATH+=:/opt/bin git push',
    'PATH=~/bin:$PATH git push',
    'export PATH=$HOME/bin:$PATH; git fetch x',
    'echo "$PATH"; git status',
    'unset LD_PRELOAD; git push',
    'PATH=$X make',
    "git commit -m 'set PATH and LD_PRELOAD'",
    'NODE_PATH=$X git status',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
