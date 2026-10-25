import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * An expanded command word may be git, and the word after it its subcommand, so `$X $Y --no-verify`
 * may be `git push --no-verify` and `$X $Y core.hooksPath /dev/null` a `git config` that drops the
 * hook (CC-1322). A command word that splits may hold the subcommand itself, and an unread word may
 * be an option that takes a `--` as its value. Real bash and zsh with a fake `git` first on PATH
 * confirm each row runs the push or the config write once its words are filled in.
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

const H = REASONS.hiddenSubcommand
const BOTH = ['bash', 'zsh']

// Each row: the line, the reason the guard gives, what the shell sets first, and the shells that skip the hook.
const BYPASSES: [string, string, string, string[]][] = [
  ['$X $Y --no-verify', H, 'X=git; Y=push', BOTH],
  ['git status; $X $Y --no-verify', H, 'X=git; Y=push', BOTH],
  ['$X $Y origin HEAD --no-verify', H, 'X=git; Y=push', BOTH],
  ['$X $Y core.hooksPath=/dev/null push', H, 'X=git; Y=-c', BOTH],
  ['git status; $X $Y core.hooksPath=/dev/null push', H, 'X=git; Y=-c', BOTH],
  ['$X $Y core.hooksPath /dev/null', H, 'X=git; Y=config', BOTH],
  ['git status; $X $Y core.hooksPath /dev/null', H, 'X=git; Y=config', BOTH],
  // The unread word is an option that takes the `--` as its value.
  ['$X $Y -- push --no-verify', REASONS.noVerify, 'X=git; Y=--namespace', BOTH],
  ['$X $Y -- -c core.hooksPath=/dev/null push', REASONS.gitConfig, 'X=git; Y=--namespace', BOTH],
  ['$X $Y -- $Z core.hooksPath /dev/null', H, 'X=git; Y=--namespace; Z=config', BOTH],
  // The command word splits into git and its subcommand.
  ['X="git push"; ${=X} origin --no-verify', H, '', ['zsh']],
  ['X="git config"; ${=X} core.hooksPath /dev/null', H, '', ['zsh']],
  ['X="git -c"; ${=X} core.hooksPath=/dev/null push', H, '', ['zsh']],
  ['X="git push"; $X --no-verify', H, '', ['bash']],
  ['source /dev/null; ${=X} --no-verify', H, 'X="git push"', ['zsh']],
  // An include key, whose file may set core.hooksPath.
  ['$X $Y include.path=/w/hp push', H, 'X=git; Y=-c', BOTH],
  ['git status; $X $Y include.path=/w/hp push', H, 'X=git; Y=-c', BOTH],
  ['$X $Y include.path /w/hp', H, 'X=git; Y=config', BOTH],
  ['git status; $X $Y include.path /w/hp', H, 'X=git; Y=config', BOTH],
  ['$X $Y includeIf.onbranch:main.path=/w/hp push', H, 'X=git; Y=-c', BOTH],
  // A key or flag the shell finishes from an expansion.
  ['$X $Y core.hooks$K /dev/null', H, 'X=git; Y=config; K=Path', BOTH],
  ['$X $Y core.hooks$K=/dev/null push', H, 'X=git; Y=-c; K=Path', BOTH],
  ['$X $Y core.$K=/dev/null push', H, 'X=git; Y=-c; K=hooksPath', BOTH],
  ['$X $Y "core.hooks${K}" /dev/null', H, 'X=git; Y=config; K=Path', BOTH],
  // Writes an alias, which a later git runs; no push of its own.
  ['$X $Y alias.$A x', H, 'X=git; Y=config; A=p', []],
  ['$X $Y "--no-veri$V"', H, 'X=git; Y=push; V=fy', BOTH],
]

const ALLOWED = [
  '$EDITOR $FILE',
  '"$CMD" "$@"',
  '$E $F gh pr view 1',
  '$X $Y status',
  '"$X" status --no-verify',
  '$X $Y origin $Z',
  '$X $Y $K /dev/null',
  '$X $Y "$B" --body-file pr.md',
]

describe('checkCommand on a hidden git subcommand beside a word that skips the hook', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx()) ?? 'allowed').toBe(reason)
  })

  it.each(ALLOWED)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it('denies a lone --no-verify after a hidden subcommand and a --, which git rejects', () => {
    expect(checkCommand('$X $Y -- --no-verify', ctx())).toBe(H)
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
    ['$X $Y p --no-verify', H],
    ['env -C /x $X $Y p --no-verify', H],
    ['sudo $X $Y p --no-verify', REASONS.privilegedHidden],
  ])('keeps denying a hidden subcommand filled by an alias: %j', (src, reason) => {
    expect(checkCommand(src, aliased())).toBe(reason)
  })
})

const real = fakeGitShells('agent-chat-pretool-hidden-sub-', 'git push --no-verify')
const SKIPS_HOOK =
  /^(?:--namespace -- )?(?:push .*--no-verify|-c (?:core\.hooksPath=\/dev\/null|include(?:If\.\S+)?\.path=\/w\/hp) push|config (?:core\.hooksPath \/dev\/null|include\.path \/w\/hp))$/m

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run the hidden subcommand the guard denies', () => {
  it.each(BYPASSES)('each named shell skips the hook for %j', (src, _, setup, names) => {
    const shells = real.shells.filter(([shell]) => names.some(name => shell.endsWith(`/${name}`)))
    for (const [shell, args] of shells)
      expect(real.gitCalls(shell, args, setup === '' ? src : `${setup}; ${src}`)).toMatch(SKIPS_HOOK)
  })
})
