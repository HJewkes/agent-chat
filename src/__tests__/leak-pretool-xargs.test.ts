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

describe('git and gh fed words by xargs (CC-1117)', () => {
  it.each([
    'echo always | xargs git config protocol.ext.allow',
    'echo protocol.ext.allow always | xargs git config',
    'xargs git remote add o < urls',
    'xargs git remote set-url o',
    'xargs git config alias.p',
    'xargs -n2 git config url.x.insteadOf',
  ])('denies a config or remote write whose words come from stdin: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('denies core.hooksPath set from stdin', () => {
    expect(checkCommand('echo core.hooksPath /x | xargs git config', ctx)).toBeDefined()
  })

  it('denies git with no subcommand, since stdin names it', () => {
    expect(checkCommand('echo config protocol.allow always | xargs git', ctx)).toBe(REASONS.aliasEnv)
  })

  it('denies gh with no subcommand, since stdin may name an alias', () => {
    expect(checkCommand('echo pv | xargs gh', ctx)).toBeDefined()
  })

  it.each([
    'xargs git push',
    'echo --no-verify | xargs git push origin',
    'xargs -n1 git -C . push',
    'xargs env git push',
  ])('denies a push that may take --no-verify from stdin: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
  })

  it.each([
    'xargs -I{} git push {}',
    'echo origin | xargs -I {} git push {}',
    'xargs -I{} git push {} --',
    'xargs -i git push {}',
    'xargs -i% git push %',
    'xargs --replace=R git push R',
    'xargs --replace git push {}',
    'xargs -J % git push %',
  ])('denies a push whose replace word comes before --: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
  })

  it('denies a config write through the replace word', () => {
    expect(checkCommand('xargs -I % git config %', ctx)).toBeDefined()
  })

  it.each([
    'xargs git push origin --',
    'xargs -I{} git push origin -- {}',
    'xargs git log',
    'ls | xargs git add',
    'xargs git status',
    'xargs gh pr view',
    'ls | xargs grep x',
    'echo a | xargs',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
