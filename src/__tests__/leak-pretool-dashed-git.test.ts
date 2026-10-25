import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * git runs a builtin called by its dashed name, `$(git --exec-path)/git-push`, as `git push`, so the
 * guard reads it as one (CC-1633). The push policy itself is the pre-push hook's alone: the pretool
 * keeps only the hook-integrity rules it has for any git push.
 */

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const DASHED = [
  ['/usr/lib/git-core/git-push --no-verify origin feat/x', REASONS.noVerify],
  ['git-push --no-verify origin feat/x', REASONS.noVerify],
  ['command /usr/lib/git-core/git-push --no-verify origin feat/x', REASONS.noVerify],
  ['env /usr/lib/git-core/git-push --no-verify origin feat/x', REASONS.noVerify],
  ['/usr/lib/git-core/git-config core.hooksPath /work/hooks', REASONS.configWrite],
] as const

describe('leak-guard pretool on dashed git builtins (CC-1633)', () => {
  it.each(DASHED)('denies %j as git would run it', (line, reason) => {
    expect(checkCommand(line, ctx)).toBe(reason)
  })

  it('allows a plain dashed push', () => {
    expect(checkCommand('/usr/lib/git-core/git-push origin feat/x', ctx)).toBeUndefined()
  })

  it.each(['git push origin --delete feat/x', 'git push --force origin feat/x', 'git push origin HEAD:main'])(
    'leaves %j to the pre-push hook, which decides the push policy',
    line => {
      expect(checkCommand(line, ctx)).toBeUndefined()
    },
  )

  it('denies an inline alias to push as before (CC-1622)', () => {
    expect(checkCommand('git -c alias.pp=push pp origin --delete feat/x', ctx)).toBe(REASONS.gitConfig)
    expect(checkCommand('git -C . -c alias.pp=push pp origin --delete feat/x', ctx)).toBe(REASONS.gitConfig)
  })
})
