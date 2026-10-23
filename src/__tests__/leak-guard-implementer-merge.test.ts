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

const files: Record<string, string> = {
  '/work/merge.json':
    '{"query":"mutation { mergePullRequest(input:{pullRequestId:\\"PR_x\\"}) { clientMutationId } }"}',
  '/work/read.graphql': 'query { viewer { login } }',
}
const withFiles = (profile: string): GuardContext => ({ ...ctx(profile), readFile: file => files[file] })

const GRAPHQL_MERGES = [
  `gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { clientMutationId } }'`,
  `gh api graphql -f query='mutation {\n  mergePullRequest(\n    input: { pullRequestId: "PR_x" }\n  ) { clientMutationId }\n}'`,
  `gh api graphql -F query='mutation { enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"}) { clientMutationId } }'`,
  `gh api graphql --raw-field 'query=mutation { mergeBranch(input:{repositoryId:"R_x",base:"main",head:"f"}) { clientMutationId } }'`,
  'gh api graphql --input merge.json',
  'gh api /graphql --input /work/merge.json',
  'agent-chat gh-write -- api graphql --input merge.json',
]

describe('an implementer session cannot merge through gh api graphql', () => {
  it.each(GRAPHQL_MERGES)('%s is denied', command => {
    expect(checkCommand(command, withFiles('bd-implementer'))).toBe(REASONS.implementerMerge)
  })

  it.each([
    'gh api graphql --input missing.json',
    'gh api graphql -F query=@missing.graphql',
    'gh api graphql -f query="$Q"',
  ])('%s has a query the guard cannot read, so it fails closed', command => {
    const reason = checkCommand(command, withFiles('bd-implementer'))

    expect(reason).toBe(REASONS.implementerMergeUnread)
    expect(reason).toContain('fail closed')
  })

  it.each([
    `gh api graphql -f query='query { repository(owner:"o",name:"r"){ id } }'`,
    `gh api graphql -f query='mutation { MergePullRequest(input:{}) { clientMutationId } }'`,
    'gh api graphql -F query=@read.graphql',
  ])('%s does not merge, so the rule leaves it alone', command => {
    const reason = checkCommand(command, withFiles('bd-implementer'))

    expect(reason).not.toBe(REASONS.implementerMerge)
    expect(reason).not.toBe(REASONS.implementerMergeUnread)
  })

  it.each(['reviewer', 'bd-reviewer'])('profile %s is not denied by this rule', profile => {
    for (const command of GRAPHQL_MERGES) {
      const reason = checkCommand(command, withFiles(profile))

      expect(reason, command).not.toBe(REASONS.implementerMerge)
      expect(reason, command).not.toBe(REASONS.implementerMergeUnread)
    }
  })
})

const escaped: GuardContext = {
  ...ctx('bd-implementer'),
  readFile: file =>
    file === '/work/m.json'
      ? '{"query":"mutation { merge\\u0050ullRequest(input:{}) { clientMutationId } }"}'
      : undefined,
}

describe('gh api spellings that gh and GitHub read as a merge', () => {
  it.each([
    'gh api -iX PUT repos/o/r/pulls/5/merge',
    'gh api -iXPUT repos/o/r/pulls/5/merge',
    'gh api repos/o/r/pulls/5/merge -if merge_method=squash',
    `gh api graphql -if query='mutation { mergePullRequest(input:{}) { clientMutationId } }'`,
    'gh api -X PUT https://api.github.com/repos/o/r/pulls/5/merge',
    'gh api -X PUT https://ghe.example/api/v3/repos/o/r/pulls/5/merge',
    `gh api https://api.github.com/graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'`,
    'gh api -X PUT repos//o/r/pulls/5/merge',
    'gh api -X PUT repos/o/r/pulls/5/%6Derge',
    'gh api repos/o/r/merges -f base=main -f head=feat',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc123',
    'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc123',
  ])('%s is denied', command => {
    expect(checkCommand(command, ctx('bd-implementer'))).toBe(REASONS.implementerMerge)
  })

  it('decodes a JSON --input body, so an escape cannot hide the mutation', () => {
    expect(checkCommand('gh api graphql --input m.json', escaped)).toBe(REASONS.implementerMerge)
  })

  it.each(['gh api repos/o/r/pulls/5/merge repos/o/r/merges -X PUT', 'gh api -X PUT "$EP"'])(
    '%s does not name one endpoint the guard can read, so it fails closed',
    command => {
      expect(checkCommand(command, ctx('bd-implementer'))).toBe(REASONS.implementerMergeUnread)
    },
  )

  it.each([
    'gh api -i repos/o/r/pulls/5/merge',
    'gh api repos/o/r/git/refs/heads/main',
    'gh api https://api.github.com/repos/o/r/merges',
    'gh api -iq .sha repos/o/r/git/refs/heads/main',
  ])('%s is a read, so the rule leaves it alone', command => {
    const reason = checkCommand(command, ctx('bd-implementer'))

    expect(reason).not.toBe(REASONS.implementerMerge)
    expect(reason).not.toBe(REASONS.implementerMergeUnread)
  })

  it('leaves these spellings to other profiles', () => {
    expect(checkCommand('gh api -iX PUT repos/o/r/pulls/5/merge', ctx('reviewer'))).not.toBe(
      REASONS.implementerMerge,
    )
    expect(checkCommand('gh api repos/o/r/merges -f base=main -f head=feat', ctx('reviewer'))).not.toBe(
      REASONS.implementerMerge,
    )
  })
})
