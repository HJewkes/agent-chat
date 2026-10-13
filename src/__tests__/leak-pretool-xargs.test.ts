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

  it.each([
    `X='nv -I--'; xargs -a $X git push origin HEAD:x --`,
    'xargs -n {1,-I--} git push origin HEAD:x -- < nv',
    'xargs -d $X git push origin HEAD:x --',
    'xargs -P $X git push origin HEAD:x --',
    'xargs -n $X git push origin HEAD:x --',
    'xargs -E $X git push origin HEAD:x --',
    'xargs --arg-file $X git push origin HEAD:x --',
    'xargs --max-procs $X git push origin HEAD:x --',
    'xargs -a * git push origin HEAD:x --',
    'xargs -a f* git push origin HEAD:x --',
    'xargs -a $(cat g) git push origin HEAD:x --',
    'xargs -n$X git push origin HEAD:x --',
    'xargs --arg-file=$X git push origin HEAD:x --',
    'xargs -I$X git push origin HEAD:x --',
  ])('denies a push behind an xargs option value the shell may split: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it('denies --max-lines with no value, which leaves the next word as the command', () => {
    expect(checkCommand('xargs --max-lines git push --no-verify', ctx)).toBe(REASONS.noVerify)
  })

  it('denies an xargs that runs xargs, whose outer words land past the inner --', () => {
    expect(checkCommand('xargs xargs -I{} git push origin -- {}', ctx)).toBeDefined()
  })

  it('denies a script that sh -c reads, keeping its text around the replace string', () => {
    expect(checkCommand(`xargs -I{} sh -c 'git push origin {} --no-verify'`, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    `xargs -I{} bash -c 'git config protocol.ext.allow {}'`,
    `xargs -I% sh -c 'git remote add o %'`,
    `xargs -I{} sh -c 'git push origin {}'`,
  ])('denies a write a -c script takes from the replace string: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it('denies a push whose subcommand word holds the replace string', () => {
    expect(checkCommand('xargs -I{} git pu{} origin', ctx)).toBeDefined()
  })

  it('denies a push BSD -J appends to when no word is the replace string', () => {
    expect(checkCommand('xargs -J % git push origin HEAD:x', ctx)).toBe(REASONS.xargsPush)
  })

  it.each([
    'echo GIT_CONFIG_COUNT | xargs -I% env -u % git push origin --',
    'xargs -I% env %=0 git push origin --',
    'xargs -I% env -u% git push origin --',
    'xargs -I% env --unset=% git push origin --',
    'xargs -I% env -- %=0 git push origin --',
    'xargs -I% env -u "$X" git push origin --',
    'xargs -I% env "$X"=0 git push origin --',
    'xargs env -u "$X" git push origin --',
    'xargs -n1 env "$X"=0 git push origin --',
  ])('denies env words xargs may fill with a GIT_CONFIG_* name: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.gitConfigEnv)
  })

  it.each(['env -u "$X" git push origin', 'env "$X"=0 git push origin', 'env -u $X git push origin'])(
    'denies env unsetting or setting a name the guard cannot read: %s',
    command => {
      expect(checkCommand(command, ctx)).toBeDefined()
    },
  )

  it.each([
    `printf '%s\\n' git push --no-verify origin HEAD:x | xargs nice`,
    'xargs env',
    'xargs command',
    'xargs timeout 5',
    'xargs timeout',
    'xargs nohup',
    'xargs nice -n 5',
    'xargs env FOO=1',
    'xargs xargs',
    'xargs -n1 nice',
  ])('denies an xargs whose wrappers leave the command to its input: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.hiddenCommand)
  })

  it.each([
    `printf '%s\\n' '-Sgit push --no-verify origin HEAD:x' | xargs -I% env %`,
    'xargs -I% %',
    'xargs -I% nice %',
    'xargs -I% %it push origin HEAD:x',
    'xargs -I"$R" ls',
    'xargs -I"$R" env -u x git push origin --',
  ])('denies an xargs whose command word is filled from its input: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.hiddenCommand)
  })

  it.each([
    `printf 'i\\n' | xargs -I% env -% git push origin --`,
    `printf 'uGIT_CONFIG_COUNT\\n' | xargs -I% env -% git push origin --`,
    `printf '%s\\n' 'Ssh -c "git push --no-verify origin HEAD:x"' | xargs -I% env -% true`,
    'xargs -I% env -i% git push origin --',
    'xargs -I% env -S% true',
    'xargs -I% env -C% git push origin --',
    'xargs -I% env --% git push origin --',
    'xargs -I% env -C % git push origin --',
    'xargs -I% env -P % git push origin --',
    'xargs -I% nice -% git push origin --',
    'xargs -I% nice -n % git push origin --',
    'xargs -I% timeout % git push origin --',
    'xargs -I% timeout -% 5 git push origin --',
    'xargs -I% command -% git push origin --',
  ])('denies a wrapper option word xargs fills: %s', command => {
    const reason = checkCommand(command, ctx)
    expect(reason).toBeDefined()
    expect(reason).toBe(REASONS.xargsWrapper)
  })

  it('denies a fed unset glued to -u as a GIT_CONFIG_* unset', () => {
    expect(checkCommand('xargs -I% env -u% git push origin --', ctx)).toBe(REASONS.gitConfigEnv)
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
    'xargs -a "$X" git push origin --',
    'xargs -I {} git push origin -- {}',
    'xargs -- "$X"',
    'xargs -I% env -u FOO git push origin -- %',
    'xargs -I% env FOO=1 git log %',
    'env FOO="$X" git log',
    'xargs -J % git push origin -- HEAD:x',
    'ls | xargs -P "$(nproc)" grep foo',
    `xargs -I{} sh -c 'git log {}'`,
    'xargs -I{} git push origin -- x{}y',
    'xargs git log',
    'ls | xargs git add',
    'xargs git status',
    'xargs gh pr view',
    'ls | xargs grep x',
    'echo a | xargs',
    'xargs nice ls',
    'xargs -I% echo %',
    'xargs -I% nice ls %',
    'xargs timeout 5 ls',
    'xargs -I% env FOO=1 ls %',
    'xargs -I% nice -n 5 ls %',
    'xargs -I% env FOO=% ls',
    'env -C "$dir" git log',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('a git alias keeps the marks of the words around it (CC-1117)', () => {
  const ALIASES: Record<string, string> = {
    cfg: 'config',
    p: 'push',
    sp: '!git push',
    shp: '!sh -c "git push $0"',
  }
  const aliased: GuardContext = {
    ...ctx,
    readAlias: word => (word in ALIASES ? { value: ALIASES[word] as string, runsIn: '/work' } : undefined),
  }

  it.each(['git cfg "$@"', 'git cfg $X', 'xargs git cfg', 'xargs git p'])(
    'denies an aliased config or push that takes unreadable words: %s',
    command => {
      expect(checkCommand(command, aliased)).toBeDefined()
    },
  )

  it('denies an aliased push fed by xargs as a fed push', () => {
    expect(checkCommand('xargs git p origin', aliased)).toBe(REASONS.xargsPush)
  })

  it.each([
    'xargs git sp',
    'xargs -I% git sp %',
    `printf '%s\\n' --no-verify origin HEAD:x | xargs git sp`,
    'xargs git shp',
    'git sp $X',
  ])('denies a ! alias that takes unreadable words: %s', command => {
    expect(checkCommand(command, aliased)).toBe(REASONS.aliasQuotedArgs)
  })

  it.each(['git cfg --get user.name', 'git p origin main', 'xargs git p origin --', 'git sp origin main'])(
    'allows %s',
    command => {
      expect(checkCommand(command, aliased)).toBeUndefined()
    },
  )
})
