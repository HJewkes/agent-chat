import { parseTerms } from '@titan-design/egress-scan'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only: a made-up term list and repo. scansGhWrite and PATH keep the gh-write deferral live.
const ctx = (profile?: string): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: { ...(profile === undefined ? {} : { AGENT_CHAT_PROFILE: profile }), PATH: '/usr/bin' },
  scansGhWrite: true,
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const IMPLEMENTERS = ['bd-implementer', 'bd-implementer-lite']
const IMPLEMENTER_REASONS: readonly (string | undefined)[] = [
  REASONS.implementerGh,
  REASONS.implementerGhUnread,
]

const MERGE = 'repos/o/r/pulls/5/merge'
const mutation = (field: string): string => `'query=mutation { ${field} { clientMutationId } }'`

/** gh argv after `gh`, from the head's merge corpus and every reviewer probe of rounds 1 to 4. */
const DENIED = [
  'pr merge 5',
  'pr merge 5 --squash --delete-branch',
  'pr merge --squash 5',
  'pr  merge   5',
  `'pr' "merge" 5`,
  'pr -R o/r merge 5',
  'pr merge --auto --squash',
  'pr merge "$N" --squash',
  `api -X PUT ${MERGE}`,
  `api --method PUT ${MERGE}`,
  `api --method=PUT ${MERGE}`,
  `api -XPUT ${MERGE}`,
  `api -X put ${MERGE}`,
  `api ${MERGE} -X PUT`,
  `api -X PUT '/${MERGE}'`,
  'api -X PUT repos/{owner}/{repo}/pulls/5/merge -f merge_method=squash',
  `api -f merge_method=squash -X PUT ${MERGE}`,
  `api -X PUT ${MERGE}/`,
  `api -X PUT '${MERGE}?x=1'`,
  `api ${MERGE} -f merge_method=squash`,
  `api graphql -f ${mutation('mergePullRequest(input:{pullRequestId:"PR_x"})')}`,
  `api graphql -f 'query=mutation {\n  mergePullRequest(\n    input: { pullRequestId: "PR_x" }\n  ) { clientMutationId }\n}'`,
  `api graphql -F ${mutation('enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"})')}`,
  `api graphql --raw-field ${mutation('mergeBranch(input:{repositoryId:"R_x",base:"main",head:"f"})')}`,
  'api graphql --input merge.json',
  'api /graphql --input /work/merge.json',
  `api -iX PUT ${MERGE}`,
  `api -iXPUT ${MERGE}`,
  `api ${MERGE} -if merge_method=squash`,
  `api graphql -if ${mutation('mergePullRequest(input:{})')}`,
  `api -X PUT https://api.github.com/${MERGE}`,
  `api -X PUT https://ghe.example/api/v3/${MERGE}`,
  `api https://api.github.com/graphql -f ${mutation('mergePullRequest(input:{})')}`,
  'api -X PUT repos//o/r/pulls/5/merge',
  'api -X PUT repos/o/r/pulls/5/%6Derge',
  'api repos/o/r/merges -f base=main -f head=feat',
  'api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc123',
  'api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc123',
  `-X PUT api ${MERGE}`,
  'pr "${V:-merge}" 5',
  '"$G" merge 5',
  'pr "$V" 5',
  `api graphql -f ${mutation('enqueuePullRequest(input:{pullRequestId:"PR_x"})')}`,
  `api graphql -f ${mutation('updateRef(input:{refId:"REF_x",oid:"abc123"})')}`,
  `api graphql -f ${mutation('updateRefs(input:{repositoryId:"R_x",refUpdates:[]})')}`,
  `api -X PUT ${MERGE} -p -XGET`,
  `api -X PUT ${MERGE} -q -XGET`,
  `api -X PUT ${MERGE} -t -XGET`,
  `api -X PUT ${MERGE} --jq -XGET`,
  `api -X PUT ${MERGE} -p --method=GET`,
  `api -X PUT ${MERGE} --template --method=GET`,
  `api -X PUT ${MERGE} -X GET`,
  'api -X PUT repositories/123/pulls/5/merge',
  'api repositories/123/merges -f base=main -f head=feat',
  'api -X PATCH repositories/123/git/refs/heads/main -f sha=abc123',
  'api -X PUT repos/o/r/pulls/1/x/../merge',
  'repo sync o/r --branch main',
  'pr review 5 --approve',
  'pr update-branch 5',
  'workflow run x',
  `api graphql -f 'query=query { viewer { login } }'`,
  `api -X GET -H 'X-HTTP-Method-Override: PUT' ${MERGE}`,
  'api --bogus repos/o/r',
  `api ${MERGE} repos/o/r/merges -X PUT`,
  'api -X PUT "$EP"',
]

const ROOT_FLAGS = ['', '-R o/r ', '--repo o/r ', '--repo=o/r ']
const SPELLINGS = (row: string): string[] =>
  ROOT_FLAGS.flatMap(flag => [`gh ${flag}${row}`, `agent-chat gh-write -- ${flag}${row}`])

describe('A: an implementer runs no gh call off the allowlist', () => {
  it.each(IMPLEMENTERS.flatMap(profile => DENIED.map(row => [profile, row])))(
    '%s: %s is denied via gh and gh-write, behind every root flag',
    (profile, row) => {
      for (const command of SPELLINGS(row))
        expect(IMPLEMENTER_REASONS, command).toContain(checkCommand(command, ctx(profile)))
    },
  )

  // gh's alias and extension rule runs before the allowlist and denies these with its own reason.
  it.each(
    IMPLEMENTERS.flatMap(profile =>
      [`alias set mm 'pr merge'`, 'extension exec x'].map(row => [profile, row]),
    ),
  )('%s: %s is denied by the earlier gh rule', (profile, row) => {
    for (const command of SPELLINGS(row)) expect(checkCommand(command, ctx(profile)), command).toBeDefined()
  })

  it.each([
    'gh pr merge 5',
    'agent-chat gh-write -- pr merge 5',
    `agent-chat gh-write -- api -X PUT ${MERGE}`,
    'gh repo sync o/r --branch main',
    `gh api -X PUT ${MERGE} -p -XGET`,
    `gh api -X PUT ${MERGE} -X GET`,
  ])('%s is off the allowlist', command => {
    expect(checkCommand(command, ctx('bd-implementer'))).toBe(REASONS.implementerGh)
  })

  it.each([
    'agent-chat gh-write -- pr "${V:-merge}" 5',
    'agent-chat gh-write -- "$G" merge 5',
    'gh -R o/r api -X GET repos/o/r',
    `gh api graphql -f 'query=query { viewer { login } }'`,
    'gh api --bogus repos/o/r',
    'gh api -X PUT "$EP"',
  ])('%s cannot be resolved, so it fails closed', command => {
    const reason = checkCommand(command, ctx('bd-implementer'))

    expect(reason).toBe(REASONS.implementerGhUnread)
    expect(reason).toContain('fail closed')
  })

  it('names Shepherd as the merge path and gh-write as the way to open a PR', () => {
    expect(REASONS.implementerGh).toContain('Shepherd')
    expect(REASONS.implementerGh).toContain('agent-chat gh-write -- pr create')
  })
})

/** Shapes taken from implementer transcripts, with synthetic repos and ids. */
const ALLOWED = [
  'gh pr view 5 --json headRefOid',
  'gh pr checks 2230 -R o/r',
  'gh -R o/r pr view 5',
  'gh pr list --repo o/r --state all --search x',
  'gh pr diff 5',
  `agent-chat gh-write -- pr create --repo o/r --base main --head agent-chat/x --title t --body-file - <<'EOF'\nbody\nEOF`,
  `agent-chat gh-write -- pr edit 798 --repo o/r --body-file - <<'EOF'\nbody\nEOF`,
  'agent-chat gh-write -- pr comment 5 --body hi',
  'agent-chat gh-write -- api repos/o/r/pulls -f title=t -f head=h -f base=main -f body=b',
  'agent-chat gh-write -- api -X POST repos/o/r/pulls -f title=t',
  'agent-chat gh-write -- api -X PATCH repos/o/r/pulls/5 -f body=b',
  'agent-chat gh-write -- api repos/{owner}/{repo}/issues/5/comments -f body=b',
  'gh run view 1 --log-failed',
  'gh run rerun 1 --failed',
  'gh run watch 1 --exit-status',
  'gh run download 1',
  'gh repo view --json visibility',
  'gh api repos/o/r --jq .visibility',
  `gh api "repos/o/r/commits/0123abc/check-runs" --paginate --jq '.check_runs[]|.name'`,
]

describe('B: an implementer keeps the gh calls its work uses', () => {
  it.each(IMPLEMENTERS.flatMap(profile => ALLOWED.map(command => [profile, command])))(
    '%s: %s is allowed',
    (profile, command) => {
      expect(checkCommand(command, ctx(profile))).toBeUndefined()
    },
  )
})

describe('C: other sessions are not judged by the implementer allowlist', () => {
  it.each([undefined, 'reviewer', 'coordinator', 'bd-reviewer', 'bd-planner', 'implementer-ish'])(
    'profile %s gets no implementer reason on any row of A',
    profile => {
      for (const command of DENIED.flatMap(SPELLINGS))
        expect(IMPLEMENTER_REASONS, command).not.toContain(checkCommand(command, ctx(profile)))
    },
  )

  it.each(['agent-chat gh-write -- pr "$V" 5', 'agent-chat gh-write -- "$G" merge 5'])(
    '%s reaches the gh-write deferral for another profile, which passes it',
    command => {
      expect(checkCommand(command, ctx('reviewer'))).toBeUndefined()
    },
  )
})

describe('the profile comes from the injected env', () => {
  afterEach(() => {
    delete process.env.AGENT_CHAT_PROFILE
  })

  it('denies on the injected profile when the process has none', () => {
    expect(checkCommand('gh pr merge 5', ctx('bd-implementer'))).toBe(REASONS.implementerGh)
  })

  it('ignores an implementer profile in the process env', () => {
    process.env.AGENT_CHAT_PROFILE = 'bd-implementer'

    expect(IMPLEMENTER_REASONS).not.toContain(checkCommand('gh pr merge 5', ctx('reviewer')))
  })
})
