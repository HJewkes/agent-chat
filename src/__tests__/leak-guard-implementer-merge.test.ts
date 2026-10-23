import { parseTerms } from '@titan-design/egress-scan'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only: a made-up term list and repo.
const ctx = (profile?: string): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: profile === undefined ? {} : { AGENT_CHAT_PROFILE: profile },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const MERGES = [
  'gh pr merge 5',
  'gh pr merge 5 --squash --delete-branch',
  'gh pr merge --squash 5',
  'gh pr  merge   5',
  'gh \'pr\' "merge" 5',
  'gh pr -R o/r merge 5',
  'gh pr merge --auto --squash',
  'gh pr merge "$N" --squash',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api --method PUT repos/o/r/pulls/5/merge',
  'gh api --method=PUT repos/o/r/pulls/5/merge',
  'gh api -XPUT repos/o/r/pulls/5/merge',
  'gh api -X put repos/o/r/pulls/5/merge',
  'gh api repos/o/r/pulls/5/merge -X PUT',
  "gh api -X PUT '/repos/o/r/pulls/5/merge'",
  'gh api -X PUT repos/{owner}/{repo}/pulls/5/merge -f merge_method=squash',
  'gh api -f merge_method=squash -X PUT repos/o/r/pulls/5/merge',
  'gh api -X PUT repos/o/r/pulls/5/merge/',
  "gh api -X PUT 'repos/o/r/pulls/5/merge?x=1'",
  'gh api repos/o/r/pulls/5/merge -f merge_method=squash',
  'agent-chat gh-write -- pr merge 5',
  'agent-chat gh-write -- pr merge 5 --squash',
  'agent-chat gh-write -- api -X PUT repos/o/r/pulls/5/merge',
  'agent-chat gh-write -- api --method PUT repos/o/r/pulls/5/merge -f merge_method=squash',
]

describe('an implementer session cannot merge a pull request', () => {
  it.each(['bd-implementer', 'bd-implementer-lite'])('%s: every merge route is denied', profile => {
    for (const command of MERGES)
      expect(checkCommand(command, ctx(profile)), command).toBe(REASONS.implementerMerge)
  })

  it('names Shepherd as the merge path', () => {
    expect(REASONS.implementerMerge).toContain('Shepherd')
  })

  it.each([
    'gh pr view 5',
    'gh pr checks 5',
    'gh pr list',
    'gh api repos/o/r/pulls/5/merge',
    'gh api -X GET repos/o/r/pulls/5/merge',
    'gh api repos/o/r/pulls/5',
    'gh api -X PUT repos/o/r/pulls/5/update-branch',
    'agent-chat gh-write -- pr comment 5 --body hello',
  ])('%s is not a merge, so the rule leaves it alone', command => {
    expect(checkCommand(command, ctx('bd-implementer'))).not.toBe(REASONS.implementerMerge)
  })
})

describe('other sessions keep their merge routes', () => {
  it.each([undefined, 'reviewer', 'coordinator', 'bd-reviewer', 'bd-planner', 'implementer-ish'])(
    'profile %s is not denied by this rule',
    profile => {
      for (const command of MERGES)
        expect(checkCommand(command, ctx(profile)), command).not.toBe(REASONS.implementerMerge)
    },
  )
})

describe('the profile comes from the injected env', () => {
  afterEach(() => {
    delete process.env.AGENT_CHAT_PROFILE
  })

  it('denies on the injected profile when the process has none', () => {
    expect(checkCommand('gh pr merge 5', ctx('bd-implementer'))).toBe(REASONS.implementerMerge)
  })

  it('ignores an implementer profile in the process env', () => {
    process.env.AGENT_CHAT_PROFILE = 'bd-implementer'

    expect(checkCommand('gh pr merge 5', ctx('reviewer'))).not.toBe(REASONS.implementerMerge)
  })
})
