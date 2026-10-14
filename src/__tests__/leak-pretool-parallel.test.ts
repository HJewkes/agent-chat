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

describe('GNU parallel runs its command as a shell script with the inputs filled in (CC-1223)', () => {
  it.each([
    'parallel env -u {} git push ::: GIT_CONFIG_COUNT',
    "parallel 'env -u {} git push' ::: GIT_CONFIG_COUNT",
  ])('denies an env that unsets a name parallel fills: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it.each([
    'parallel git push --no-verify ::: a',
    "parallel 'git push --no-verify' ::: a",
    'env_parallel git push --no-verify ::: a',
  ])('denies a push that skips hooks in the command: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'parallel git push {} ::: --no-verify',
    'parallel -q git push ::: --no-verify',
    'parallel -I % git push % ::: a',
    'parallel -I % git log {} \\; git push ::: --no-verify',
  ])('denies a push that may take --no-verify from an input: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
  })

  it.each([`parallel "git push '{}'" ::: --no-verify`, "parallel 'git push \\{}' ::: --no-verify"])(
    'denies an input the guard would read as quoted text: %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.parallelQuoted)
    },
  )

  it.each([
    ["parallel ::: 'git push --no-verify'", REASONS.noVerify],
    ["echo 'git push --no-verify' | parallel", REASONS.hiddenScript],
    ['parallel ::: git ::: push', REASONS.hiddenScript],
  ])('denies inputs run as commands that may push: %s', (command, reason) => {
    expect(checkCommand(command, ctx)).toBe(reason)
  })

  it.each(["parallel --rpl '{a} s/a/b/' git push {a} ::: x", 'parallel $X git push ::: a'])(
    'denies an option it cannot read on a git line: %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.parallelOption)
    },
  )

  it.each([
    ['g=gi; parallel ${g}t push --no-verify ::: a', REASONS.parallelOption],
    ['parallel -j2 $(printf gi)t push --no-verify ::: a', REASONS.parallelOption],
    [`parallel 'echo "{}"' ::: '$(g=gi; \${g}t push --no-verify)'`, REASONS.parallelQuoted],
  ])('denies on a line that may reach git without spelling it: %s', (command, reason) => {
    expect(checkCommand(command, ctx)).toBe(reason)
  })

  it.each([
    `parallel 'eval echo {}' ::: '$(g=gi; \${g}t push --no-verify)'`,
    `parallel -q eval 'echo {}' ::: '$(g=gi; \${g}t push --no-verify)'`,
    `parallel -q bash -c 'echo {}' ::: '$(g=gi; \${g}t push --no-verify)'`,
    `echo '$(g=gi; \${g}t push --no-verify)' | parallel`,
    `parallel 'eval "$P"; echo {}' ::: '$(g=gi; \${g}t push)'`,
    `parallel echo "$(printf gi)t" push --no-verify ::: a`,
  ])('denies a script or input that may run a hidden git: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.hiddenScript)
  })

  it.each([
    `parallel 'cat <<< "{}"' ::: '$(git push --no-verify)'`,
    `parallel 'cat <<< {}' ::: '$(git push --no-verify)'`,
    `parallel 'echo hi > "{}"' ::: '$(git push --no-verify)'`,
    `parallel 'echo hi > {}' ::: '$(git push --no-verify)'`,
    `parallel 'cat < "{}"' ::: '$(git push --no-verify)'`,
    `parallel 'cat <<X\n"{}"\nX' ::: '$(git push --no-verify)'`,
    `parallel 'cat <<X\n{}\nX' ::: '$(g=gi; \${g}t push --no-verify)'`,
  ])('denies an input in a redirect, here-string or heredoc body: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.parallelQuoted)
  })

  it('denies an input inside double quotes, where the shell expands what parallel quoted', () => {
    expect(checkCommand(`parallel 'git log "{}"' ::: a`, ctx)).toBe(REASONS.parallelQuoted)
  })

  it.each([
    'parallel {} ::: git ::: push ::: --no-verify',
    'parallel -I X X ::: git ::: push ::: --no-verify',
    "parallel {} ::: 'git push --no-verify'",
    "parallel {} --no-verify ::: 'git push'",
    "parallel 'true; {}' ::: 'git push --no-verify'",
    "parallel -q {} ::: 'git push --no-verify'",
  ])('denies an input that stands as the command: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.hiddenCommand)
  })

  describe('-q quotes each command word and keeps each input one word', () => {
    it.each([
      ['parallel -q git push {} ::: --no-verify', REASONS.xargsPush],
      ['parallel -q git push x{}y ::: a', REASONS.xargsPush],
      ['parallel -q git push "it\'s" ::: --no-verify', REASONS.xargsPush],
      ["parallel -q 'git push' --no-verify ::: a", undefined],
      ["parallel -q 'git push --no-verify' ::: a", undefined],
      ['parallel -q git log "a \'{}\' b" ::: --no-verify', undefined],
      ["parallel -q echo 'a;git push --no-verify' ::: x", undefined],
    ])('reads %s', (command, reason) => {
      expect(checkCommand(command, ctx)).toBe(reason)
    })
  })

  it.each([
    'parallel gzip ::: a b',
    'ls | parallel -j4 gzip',
    'parallel git log -1 {} ::: a',
    "parallel 'git log {}' ::: a",
    'parallel -q git log -1 {} ::: a',
    "parallel ::: 'echo hi' 'ls'",
    'parallel --unknown-flag gzip ::: a',
    `parallel 'echo "{}"' ::: a`,
  ])('allows a command that runs no push: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
