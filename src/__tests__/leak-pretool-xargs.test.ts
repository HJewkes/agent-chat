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

  it.each([
    'xargs -I{} -n2 git push',
    'xargs -i -n2 git push',
    'xargs -n2 -I{} git push',
    'xargs -I{} --max-args=2 git push',
    'xargs -I{} --max-lines git push',
    'xargs -I{} -tL1 git push',
  ])('denies a push whose replace mode a batch option may switch to appending: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
  })

  it.each(['xargs -I{} -L1 git config', 'xargs -I{} -l git config'])(
    'denies a config write a batch option may append to: %s',
    command => {
      expect(checkCommand(command, ctx)).toBeDefined()
    },
  )

  it.each([
    'xargs git push -o --',
    'xargs git push --push-option --',
    'xargs git push --repo --',
    'xargs git push --receive-pack --',
    'xargs git push origin -o --',
    'xargs git push $X --',
  ])('denies a push whose -- may be an option value: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
  })

  it.each(['R=origin; xargs -I"$R" git push origin', 'xargs -I"$R" git push origin --'])(
    'denies a push when the replace string is unreadable: %s',
    command => {
      expect(checkCommand(command, ctx)).toBeDefined()
    },
  )

  it.each([
    `X=-I--; printf '%s\\n' --no-verify | xargs "$X" git push origin HEAD:x --`,
    'xargs $X git push origin HEAD:x --',
    'xargs "$(cat f)" git push origin HEAD:x --',
    'xargs -t "$X" git push origin HEAD:x --',
    'xargs -t"$X" git push origin HEAD:x --',
  ])('denies a push behind an xargs option word the guard cannot read: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it('denies --max-lines with no value, which leaves the next word as the command', () => {
    expect(checkCommand('xargs --max-lines git push --no-verify', ctx)).toBe(REASONS.noVerify)
  })

  it('denies an xargs that runs xargs, whose outer words land past the inner --', () => {
    expect(checkCommand('xargs xargs -I{} git push origin -- {}', ctx)).toBeDefined()
  })

  it('denies a config write through the replace word', () => {
    expect(checkCommand('xargs -I % git config %', ctx)).toBeDefined()
  })

  it.each([
    'xargs git push origin --',
    'xargs -I{} git push origin -- {}',
    'xargs git push -u -f origin --',
    'xargs --max-lines=1 git push origin --',
    'xargs -I{} -P4 git push origin -- {}',
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
