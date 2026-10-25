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

  it.each([
    'stdbuf --out L git push --no-verify',
    'stdbuf --outp L git push --no-verify',
    'stdbuf --e 0 git push --no-verify',
    'stdbuf --in 0 git push --no-verify',
    'stdbuf --out=L git push --no-verify',
    'stdbuf -- git push --no-verify',
    'ionice --classd 7 git push --no-verify',
    'ionice --cl 3 git push --no-verify',
    'ionice -tc 3 git push --no-verify',
    'ionice -tn 7 git push --no-verify',
    'ionice -tc3 -tn7 git push --no-verify',
    'ionice -p 1 git push --no-verify',
  ])('reads option prefixes and clusters as getopt does: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'stdbuf "$O" git push --no-verify',
    'ionice -t"$O" 3 git push --no-verify',
    'ionice --"$O" 3 git push --no-verify',
    'stdbuf -oL ionice -c3 "$C" git push --no-verify',
  ])('denies an option word it cannot read: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
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

describe('caffeinate and exec read option clusters as getopt does (CC-1300)', () => {
  it.each([
    'caffeinate -it 5 git push --no-verify',
    'caffeinate -iw 12 git push --no-verify',
    'caffeinate -t5 git push --no-verify',
    'caffeinate -di -t 5 git push --no-verify',
    'caffeinate -- git push --no-verify',
    'exec -la x git push --no-verify',
    'exec -cla x git push --no-verify',
    'exec -ax git push --no-verify',
    'exec -l -a x git push --no-verify',
    'exec -- git push --no-verify',
    '/usr/bin/caffeinate -it 5 exec -la x git push --no-verify',
  ])('denies a push that skips hooks behind it: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'caffeinate -it 5 env GIT_CONFIG_COUNT=0 git push',
    'exec -la x env -u GIT_CONFIG_COUNT git push',
  ])('denies a git config variable it carries: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.gitConfigEnv)
  })

  it.each(['caffeinate -"$O" 5 git push --no-verify', 'exec -l"$A" x git push --no-verify'])(
    'denies an option word it cannot read: %s',
    command => {
      expect(checkCommand(command, ctx)).toBeDefined()
    },
  )

  it('denies a variable name built at runtime behind an exec -la cluster', () => {
    const bare = checkCommand('printf -v "$N" y; git push', ctx)

    const wrapped = checkCommand('exec -la x printf -v "$N" y; git push', ctx)

    expect(bare).toBeDefined()
    expect(wrapped).toBe(bare)
  })

  it('scans PR text for private terms behind a caffeinate -it cluster', () => {
    expect(checkCommand('caffeinate -it 5 gh pr create -t zq7privateseat -b y', ctx)).toMatch(/private data/)
  })

  it.each([
    'caffeinate -i make',
    'caffeinate -it 5 make',
    'caffeinate -w 12 git status',
    'exec make',
    'exec -la x make',
    'exec -a x git push',
    'exec 1<>b.md; git status',
  ])('allows a command that pushes nothing past hooks: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
