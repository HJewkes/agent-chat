import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * An expanded command word may be git, and the word after it its subcommand, so `$X $Y --no-verify`
 * may be `git push --no-verify` and `$X $Y core.hooksPath /dev/null` a `git config` that drops the
 * hook (CC-1322). Real bash and zsh with a fake `git` first on PATH confirm each row runs the push
 * or the config write once the two words are filled in.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

// Each row: the line, and what fills $Y so that the line skips the hook.
const BYPASSES: [string, string][] = [
  ['$X $Y --no-verify', 'push'],
  ['git status; $X $Y --no-verify', 'push'],
  ['$X $Y origin HEAD --no-verify', 'push'],
  ['$X $Y core.hooksPath=/dev/null push', '-c'],
  ['git status; $X $Y core.hooksPath=/dev/null push', '-c'],
  ['$X $Y core.hooksPath /dev/null', 'config'],
  ['git status; $X $Y core.hooksPath /dev/null', 'config'],
]

const ALLOWED = ['$EDITOR $FILE', '"$CMD" "$@"', '$E $F gh pr view 1', '$X $Y status', '$X $Y -- --no-verify']

describe('checkCommand on a hidden git subcommand beside a word that skips the hook', () => {
  it.each(BYPASSES)('denies %j', src => {
    expect(checkCommand(src, ctx()) ?? 'allowed').toBe(REASONS.hiddenSubcommand)
  })

  it.each(ALLOWED)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  // `p` is a push --no-verify alias where the hook runs.
  const aliased = (): GuardContext => ({
    ...ctx(),
    readAlias: (word, dir) =>
      word === 'p' && dir === '/work' ? { value: 'push --no-verify', runsIn: '/work' } : undefined,
  })

  it.each([
    ['$X $Y p', REASONS.noVerify],
    ['env -C /x $X $Y p', REASONS.noVerify],
    ['sudo $X $Y p', REASONS.noVerify],
    ['$X $Y p --no-verify', REASONS.noVerify],
    ['env -C /x $X $Y p --no-verify', REASONS.noVerify],
    ['sudo $X $Y p --no-verify', REASONS.privilegedHidden],
  ])('keeps denying a hidden subcommand filled by an alias: %j', (src, reason) => {
    expect(checkCommand(src, aliased())).toBe(reason)
  })
})

const real = fakeGitShells('agent-chat-pretool-hidden-sub-', 'git push --no-verify')

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run the hidden subcommand the guard denies', () => {
  it.each(BYPASSES)('every shell skips the hook for %j', (src, sub) => {
    for (const [shell, args] of real.shells)
      expect(real.gitCalls(shell, args, `X=git; Y=${sub}; ${src}`)).toMatch(
        /^(?:push .*--no-verify|-c core\.hooksPath=\/dev\/null push|config core\.hooksPath \/dev\/null)$/m,
      )
  })
})
