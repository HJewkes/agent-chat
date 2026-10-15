import { describe, expect, it } from 'vitest'
import { mergeTarget } from '../gh-write/merge-target.js'

const NO_ENV = {}
const kindOf = (args: string[], env: Record<string, string> = NO_ENV): string => mergeTarget(args, env).kind

describe('mergeTarget for gh api', () => {
  it('names the PR a PUT to the merge endpoint would merge', () => {
    const target = mergeTarget(
      ['api', '-X', 'PUT', 'repos/o/r/pulls/12/merge', '-f', 'merge_method=squash'],
      NO_ENV,
    )

    expect(target).toEqual({ kind: 'merge', repo: 'o/r', pr: 12 })
  })

  it.each([
    ['a leading slash', '/repos/o/r/pulls/12/merge'],
    ['the full API URL', 'https://api.github.com/repos/o/r/pulls/12/merge'],
    ['a query string', 'repos/o/r/pulls/12/merge?x=1'],
    ['URL encoding', 'repos%2Fo%2Fr%2Fpulls%2F12%2Fmerge'],
    ['double URL encoding', 'repos%252Fo%252Fr%252Fpulls%252F12%252Fmerge'],
    ['upper case', 'REPOS/O/R/PULLS/12/MERGE'],
    ['a trailing slash', 'repos/o/r/pulls/12/merge/'],
  ])('reads a merge endpoint spelled with %s', (_, endpoint) => {
    const target = mergeTarget(['api', '-X', 'PUT', endpoint], NO_ENV)

    expect(target).toMatchObject({ kind: 'merge', pr: 12 })
    expect(target.kind === 'merge' && target.repo?.toLowerCase()).toBe('o/r')
  })

  it.each([
    ['a GET', ['api', '-X', 'GET', 'repos/o/r/pulls/12/merge']],
    ['no method', ['api', 'repos/o/r/pulls/12/merge']],
    ['a method override header', ['api', '-H', 'X-HTTP-Method-Override: PUT', 'repos/o/r/pulls/12/merge']],
    ['an attached method', ['api', '-XPUT', 'repos/o/r/pulls/12/merge']],
    ['a --method= form', ['api', '--method=PUT', 'repos/o/r/pulls/12/merge']],
    ['a leading -R pair', ['-R', 'x/y', 'api', 'repos/o/r/pulls/12/merge']],
    ['the endpoint after --', ['api', '-X', 'PUT', '--', 'repos/o/r/pulls/12/merge']],
  ])('treats %s as a merge whatever the method', (_, args) => {
    expect(mergeTarget(args, NO_ENV)).toEqual({ kind: 'merge', repo: 'o/r', pr: 12 })
  })

  it.each([
    ['a gh placeholder', 'repos/{owner}/{repo}/pulls/12/merge'],
    ['a shell variable', 'repos/o/r/pulls/$N/merge'],
    ['another host', 'https://ghe.example.com/api/v3/repos/o/r/pulls/12/merge'],
  ])('refuses to name a merge endpoint with %s', (_, endpoint) => {
    expect(kindOf(['api', '-X', 'PUT', endpoint])).toBe('unresolved')
  })

  it.each([
    ['an encoded letter', 'repos/o/r/pulls/12/m%65rge'],
    ['an encoded letter and a malformed fragment escape', 'repos/o/r/pulls/12/m%65rge#%FF'],
    ['an encoded path and a malformed query escape', 'repos%2Fo%2Fr%2Fpulls%2F12%2Fmerge?x=%FF'],
    ['an invalid escape elsewhere', 'repos/o/r/pulls/12/m%65rge?x=%zz'],
    ['a non-ASCII escape elsewhere', 'repos/o/r/pulls/12/merg%65?x=%C3%A9'],
  ])('reads a merge endpoint with %s', (_, endpoint) => {
    expect(mergeTarget(['api', '-X', 'PUT', endpoint], NO_ENV)).toEqual({
      kind: 'merge',
      repo: 'o/r',
      pr: 12,
    })
  })

  it('refuses a merge path encoded more deeply than it decodes', () => {
    const endpoint = `repos/o/r/pulls/12/m%${'25'.repeat(9)}65rge`

    expect(kindOf(['api', '-X', 'PUT', endpoint])).toBe('unresolved')
  })

  it.each([
    ['an empty segment before the owner', 'repos//o/r/pulls/12/merge'],
    ['an empty segment before pulls', 'repos/o/r//pulls/12/merge'],
    ['an empty segment before the PR', 'repos/o/r/pulls//12/merge'],
    ['an empty segment before merge', 'repos/o/r/pulls/12//merge'],
    ['a dot segment', 'repos/o/r/./pulls/12/merge'],
    ['a dot-dot segment', 'repos/o/r/pulls/12/x/../merge'],
    ['an encoded dot-dot segment', 'repos/o/r/pulls/12/x/%2e%2e/merge'],
  ])('refuses a non-canonical merge path with %s', (_, endpoint) => {
    expect(kindOf(['api', '-X', 'PUT', endpoint])).toBe('unresolved')
  })

  it.each([
    ['--hostname', ['api', '--hostname', 'ghe.example.com', 'repos/o/r/pulls/12/merge'], NO_ENV],
    ['--hostname=', ['api', '--hostname=ghe.example.com', 'repos/o/r/pulls/12/merge'], NO_ENV],
    ['GH_HOST', ['api', 'repos/o/r/pulls/12/merge'], { GH_HOST: 'ghe.example.com' }],
  ])('refuses a merge endpoint on another host named by %s', (_, args, env) => {
    expect(kindOf(args, env)).toBe('unresolved')
  })

  it('names a merge when --hostname is github.com', () => {
    const args = ['api', '--hostname', 'github.com', 'repos/o/r/pulls/12/merge']

    expect(mergeTarget(args, { GH_HOST: 'ghe.example.com' })).toEqual({ kind: 'merge', repo: 'o/r', pr: 12 })
  })

  it.each([
    [
      'an inline mergePullRequest',
      ['-f', 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'],
    ],
    [
      'an inline enablePullRequestAutoMerge',
      ['-f', 'query=mutation{enablePullRequestAutoMerge(input:{}){x}}'],
    ],
    ['a mixed-case mutation name', ['--raw-field', 'query=mutation{MERGEpullrequest(input:{}){x}}']],
    ['a query read from a file', ['-F', 'query=@q.graphql']],
    ['a query read from stdin', ['--field=query=@-']],
    ['a body read from --input', ['--input', 'body.json']],
  ])('refuses a GraphQL call with %s', (_, flags) => {
    expect(kindOf(['api', 'graphql', ...flags])).toBe('unresolved')
  })

  it.each([
    [
      '-i clustered with an inline merge',
      ['graphql', '-if', 'query=mutation{mergePullRequest(input:{}){x}}'],
    ],
    ['-i clustered with a file query', ['graphql', '-iF', 'query=@q.graphql']],
    ['an unknown short in a cluster', ['graphql', '-zf', 'query=query{viewer{login}}']],
    ['enqueuePullRequest', ['graphql', '-f', 'query=mutation{enqueuePullRequest(input:{}){x}}']],
    ['mergeBranch', ['graphql', '-f', 'query=mutation{mergeBranch(input:{}){x}}']],
    ['//graphql', ['//graphql', '-f', 'query=query{viewer{login}}']],
    ['./graphql', ['./graphql', '-f', 'query=query{viewer{login}}']],
    ['x/../graphql', ['x/../graphql', '-f', 'query=query{viewer{login}}']],
  ])('refuses a GraphQL call with %s', (_, rest) => {
    expect(kindOf(['api', ...rest])).toBe('unresolved')
  })

  it.each(['--paginate', '--include', '--slurp', '--silent', '--verbose'])(
    'passes a harmless GraphQL read with %s as no merge',
    flag => {
      expect(kindOf(['api', 'graphql', flag, '-f', 'query=query{viewer{login}}'])).toBe('none')
    },
  )

  it('refuses a paginated GraphQL merge', () => {
    const args = ['api', 'graphql', '--paginate', '-f', 'query=mutation{mergePullRequest(input:{}){x}}']

    expect(kindOf(args)).toBe('unresolved')
  })

  it('passes a harmless inline GraphQL query as no merge', () => {
    expect(kindOf(['api', 'graphql', '-f', 'query=query{viewer{login}}', '-F', 'n=1'])).toBe('none')
  })

  it('refuses two different merge endpoints in one call', () => {
    expect(kindOf(['api', 'repos/o/r/pulls/12/merge', 'repos/o/r/pulls/13/merge'])).toBe('unresolved')
  })

  it.each([
    [
      'a field value that mentions a merge',
      ['api', 'repos/o/r/issues/1/comments', '-f', 'body=see repos/o/r/pulls/12/merge'],
    ],
    [
      'a --raw-field value',
      ['api', 'repos/o/r/issues/1/comments', '--raw-field', 'repos/o/r/pulls/12/merge'],
    ],
    ['a jq filter', ['api', 'repos/o/r/pulls/12', '--jq', 'repos/o/r/pulls/12/merge']],
    ['update-branch', ['api', '-X', 'PUT', 'repos/o/r/pulls/12/update-branch']],
    ['a PR read', ['api', 'repos/o/r/pulls/12']],
    ['a branch ref read', ['api', 'repos/o/r/git/refs/heads/main']],
  ])('passes %s as no merge', (_, args) => {
    expect(kindOf(args)).toBe('none')
  })
})

describe('mergeTarget for every merge-capable operation', () => {
  const mutation = (name: string): string[] => [
    'api',
    'graphql',
    '-f',
    `query=mutation{${name}(input:{}){x}}`,
  ]

  it.each([
    ['a PR merge', ['api', '-X', 'PUT', 'repos/o/r/pulls/12/merge'], 'merge', 'mergePullRequest'],
    [
      'a branch merge',
      ['api', '-X', 'POST', 'repos/o/r/merges', '-f', 'base=main', '-f', 'head=pr'],
      'unresolved',
      'mergeBranch',
    ],
    ['a branch merge in odd case', ['api', 'REPOS/O/R/MERGES', '-f', 'head=pr'], 'unresolved', 'MERGEBRANCH'],
    [
      'a branch merge, encoded',
      ['api', 'repos%2Fo%2Fr%2Fmerges', '-f', 'head=pr'],
      'unresolved',
      'mergeBranch',
    ],
    [
      'a branch merge, non-canonical',
      ['api', 'repos/o/r//merges', '-f', 'head=pr'],
      'unresolved',
      'mergeBranch',
    ],
    [
      'a branch ref PATCH',
      ['api', '-X', 'PATCH', 'repos/o/r/git/refs/heads/main', '-f', 'sha=abc'],
      'unresolved',
      'updateRef',
    ],
    [
      'a ref POST',
      ['api', 'repos/o/r/git/refs', '-f', 'ref=refs/heads/x', '-f', 'sha=abc'],
      'unresolved',
      'updateRefs',
    ],
    [
      'a ref write by override',
      ['api', '-H', 'X-HTTP-Method-Override: PATCH', 'repos/o/r/git/refs/heads/main'],
      'unresolved',
      'updateRef',
    ],
    [
      'a non-canonical ref write',
      ['api', '-X', 'PATCH', 'repos/o/r/git//refs/heads/main'],
      'unresolved',
      'updateRef',
    ],
  ])('reads %s over REST and GraphQL', (_, rest, restKind, graphql) => {
    expect(kindOf(rest)).toBe(restKind)
    expect(kindOf(mutation(graphql))).toBe('unresolved')
  })

  it.each(['enablePullRequestAutoMerge', 'enqueuePullRequest'])('refuses the GraphQL-only %s', name => {
    expect(kindOf(mutation(name))).toBe('unresolved')
  })

  it.each([
    ['a PR merge by repository id', ['-X', 'PUT', 'repositories/123456/pulls/12/merge']],
    ['a branch merge by repository id', ['-X', 'POST', 'repositories/123456/merges', '-f', 'head=pr']],
    [
      'a ref write by repository id',
      ['-X', 'PATCH', 'repositories/123456/git/refs/heads/main', '-f', 'sha=a'],
    ],
    ['a PR merge with a suffix', ['-X', 'PUT', 'repos/o/r/pulls/12/merge.json']],
    ['a PR merge under an unknown prefix', ['-X', 'PUT', 'v3/repos/o/r/pulls/12/merge']],
    [
      'a PR merge under another host',
      ['-X', 'PUT', 'https://ghe.example.com/api/v3/repos/o/r/pulls/12/merge'],
    ],
    ['any ref write, even a tag', ['-X', 'PATCH', 'repos/o/r/git/refs/tags/v1', '-f', 'sha=abc']],
  ])('refuses %s, a spelling the exact path does not name', (_, rest) => {
    expect(kindOf(['api', ...rest])).toBe('unresolved')
  })

  const VOCABULARY = [
    'pulls/12/merge',
    'pull/12/merge',
    'merges',
    'git/refs/heads/main',
    'git/ref/heads/main',
  ]
  const PREFIXES = [
    '',
    '/',
    'repos/o/r/',
    'repositories/1/',
    'x/',
    'repos/o/r/x/',
    'https://api.github.com/repos/o/r/',
  ]
  const SUFFIXES = ['', '/', '.json', '/x', '?a=b', '#f']
  const WRITES = [
    ['-X', 'PUT'],
    ['-X', 'PATCH'],
    ['-X', 'post'],
    ['-f', 'a=b'],
    ['-H', 'X-HTTP-Method-Override: PUT'],
  ]

  it("never passes a write whose path names any row's vocabulary", () => {
    const passed = VOCABULARY.flatMap(vocabulary =>
      PREFIXES.flatMap(prefix =>
        SUFFIXES.flatMap(suffix =>
          [vocabulary, vocabulary.toUpperCase()].flatMap(word =>
            WRITES.map(write => ['api', ...write, `${prefix}${word}${suffix}`]),
          ),
        ),
      ),
    ).filter(args => kindOf(args) === 'none')

    expect(passed).toEqual([])
  })
})

describe('mergeTarget for gh pr merge', () => {
  it.each([
    ['a number and -R', ['pr', 'merge', '12', '-R', 'o/r', '--squash']],
    ['a leading -R and #n', ['-R', 'o/r', 'pr', 'merge', '#12']],
    ['-R between group and verb', ['pr', '-R', 'o/r', 'merge', '12']],
    ['a PR URL with a suffix', ['pr', 'merge', 'https://github.com/o/r/pull/12/files']],
    ['a cluster and a host on -R', ['pr', 'merge', '12', '-sd', '-R', 'github.com/o/r']],
    ['--repo=', ['pr', 'merge', '12', '--repo=o/r', '--admin', '--match-head-commit', 'abc']],
    ['an attached -R', ['pr', 'merge', '12', '-Ro/r']],
    ['a value cluster', ['pr', 'merge', '12', '-sb', 'body text', '-R', 'o/r']],
    ['the same repo twice', ['pr', 'merge', '12', '-R', 'o/r', '--repo', 'O/R']],
  ])('names the PR from %s', (_, args) => {
    expect(mergeTarget(args, NO_ENV)).toMatchObject({ kind: 'merge', pr: 12 })
    expect(mergeTarget(args, NO_ENV)).not.toMatchObject({ repo: undefined })
  })

  it('leaves the repo for the caller to resolve when nothing names it', () => {
    const args = ['pr', 'merge', '1495', '--squash', '--admin', '--match-head-commit', 'abc']

    expect(mergeTarget(args, NO_ENV)).toEqual({ kind: 'merge', pr: 1495 })
  })

  it('takes the repo from GH_REPO when no flag names one', () => {
    expect(mergeTarget(['pr', 'merge', '12'], { GH_REPO: 'o/r' })).toEqual({
      kind: 'merge',
      repo: 'o/r',
      pr: 12,
    })
  })

  it('prefers -R over GH_REPO', () => {
    expect(mergeTarget(['pr', 'merge', '12', '-R', 'o/r'], { GH_REPO: 'x/y' })).toEqual({
      kind: 'merge',
      repo: 'o/r',
      pr: 12,
    })
  })

  it.each([
    ['a branch name', ['pr', 'merge', 'feature-branch']],
    ['no selector', ['pr', 'merge']],
    ['two selectors', ['pr', 'merge', '12', '13']],
    ['an unknown flag', ['pr', 'merge', '12', '--unknown']],
    ['an unknown short letter', ['pr', 'merge', '12', '-sz']],
    ['two different -R repos', ['pr', 'merge', '12', '-R', 'o/r', '-R', 'o/s']],
    ['a URL that disagrees with -R', ['pr', 'merge', 'https://github.com/o/r/pull/12', '-R', 'o/s']],
    ['a URL on another host', ['pr', 'merge', 'https://ghe.example.com/o/r/pull/12']],
    ['-R on another host', ['pr', 'merge', '12', '-R', 'ghe.example.com/o/r']],
    ['a malformed -R', ['pr', 'merge', '12', '-R', 'o']],
    ['-R with no value', ['pr', 'merge', '12', '-R']],
    ['a flag before the verb', ['pr', '--squash', 'merge', '12']],
    ['a flag before the group', ['--squash', 'pr', 'merge', '12']],
  ])('refuses to name %s', (_, args) => {
    expect(kindOf(args)).toBe('unresolved')
  })

  it('refuses a GH_REPO it cannot name', () => {
    expect(kindOf(['pr', 'merge', '12'], { GH_REPO: 'ghe.example.com/o/r' })).toBe('unresolved')
  })

  it.each(['false', '0', 'true'])('refuses --disable-auto=%s, whose value gh may read as a merge', value => {
    expect(kindOf(['pr', 'merge', '12', '-R', 'o/r', `--disable-auto=${value}`, '--squash'])).toBe(
      'unresolved',
    )
  })

  it('refuses a bare repo when GH_HOST points elsewhere', () => {
    expect(kindOf(['pr', 'merge', '12', '-R', 'o/r'], { GH_HOST: 'ghe.example.com' })).toBe('unresolved')
  })

  it.each([
    ['--disable-auto', ['pr', 'merge', '12', '--disable-auto']],
    ['pr view', ['pr', 'view', '12']],
    ['a comment whose body says merge', ['pr', 'comment', '12', '--body', 'merge']],
    ['update-branch', ['pr', 'update-branch', '12']],
    ['issue close', ['issue', 'close', '12']],
    ['a repo command', ['repo', 'view']],
    ['no words', []],
  ])('passes %s as no merge', (_, args) => {
    expect(kindOf(args)).toBe('none')
  })
})
