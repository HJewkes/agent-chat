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

describe('git options and config writes that set a trust input (TP-2376)', () => {
  it.each([
    "git -c safe.directory='*' status",
    'git -c SAFE.Directory=/x status',
    'git -c safe.directory="$PWD" status',
    'git --config-env=safe.directory=D status',
    'git --config-env safe.directory=D status',
    "git config --global safe.directory '*'",
    'git config set --global --append safe.directory /x',
    'git -C /w config --global safe.directory x',
  ])('denies safeDirectory for %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.safeDirectory)
  })

  it.each([
    'git -c init.templateDir=/t init r',
    'git init --template=/t r',
    'git init --templ /t r',
    'git clone --template=/t https://github.com/o/r',
    'git clone https://github.com/o/r "$D" --template=/t',
    'git config --global init.templateDir /t',
    'git config rename-section foo init',
  ])('denies templateDir for %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.templateDir)
  })

  it('denies gitExecPath for git --exec-path=<dir>', () => {
    expect(checkCommand('git --exec-path=/tmp/x push', ctx)).toBe(REASONS.gitExecPath)
  })

  it.each([
    'git config --get-all safe.directory',
    'git config --global --unset safe.directory /x',
    'git --exec-path',
    'git init --template= r',
    'git init r',
    'git clone https://github.com/o/r',
    'git clone https://github.com/o/r "$D"',
    'git -c user.name=x status',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
