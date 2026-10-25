import { describe, expect, it } from 'vitest'
import { isKnownRead } from '../gh-shim/read-shape.js'
import { refusalShape } from '../gh-shim/write-gate.js'

/** CC-1644: the shapes the gh shim runs with no gh-write ticket; every other shape needs one. */

const SHA = 'a'.repeat(40)

const reads: string[][] = [
  ['pr', 'view', '7', '--json', 'state'],
  ['pr', 'diff', '7'],
  ['pr', 'list', '--head', 'feat/x'],
  ['pr', 'checks', '7'],
  ['run', 'list'],
  ['run', 'view', '9', '--log-failed'],
  ['run', 'watch', '9'],
  ['repo', 'view', 'acme/widgets'],
  ['issue', 'view', '3'],
  ['workflow', 'view', 'ci.yml'],
  ['search', 'prs', '--author', '@me'],
  ['auth', 'status'],
  ['auth', 'token'],
  ['auth', 'git-credential', 'get'],
  ['run', 'download', '9'],
  ['release', 'download', 'v1.0.0'],
  ['api', `repos/acme/widgets/commits/${SHA}/check-runs`],
  ['api', '--paginate', 'repos/{owner}/{repo}/pulls?state=open&per_page=100', '--jq', '.[].number'],
  ['api', '-i', '-H', 'If-None-Match: "abc"', 'repos/acme/widgets/pulls?state=open'],
  ['api', 'rate_limit', '--jq', '.resources.core'],
  ['--version'],
  ['version'],
  ['help', 'pr'],
  ['pr', 'comment', '--help'],
  ['-h'],
  [],
]

const writes: string[][] = [
  ['pr', 'create', '--title', 'x', '--body', 'y'],
  ['pr', 'comment', '7', '--body', 'y'],
  ['pr', 'close', '7'],
  ['pr', 'merge', '7', '--squash'],
  ['pr', 'edit', '7', '--title', 'x'],
  ['issue', 'comment', '3', '--body-file', 'notes.md'],
  ['workflow', 'run', 'ci.yml'],
  ['run', 'rerun', '9'],
  ['api', '-X', 'DELETE', 'repos/acme/widgets/git/refs/heads/x'],
  ['api', 'repos/acme/widgets/issues/3/comments', '-f', 'body=y'],
  ['api', '--method=PATCH', 'repos/acme/widgets/pulls/7'],
  ['api', 'graphql', '-f', 'query={viewer{login}}'],
  ['api', 'https://api.github.com/repos/acme/widgets/issues/3/comments'],
  ['api', '-H', '-h', '-X', 'DELETE', 'repos/acme/widgets/git/refs/heads/x'],
  ['ext-name', 'view'],
  ['alias', 'set', 'pv', 'pr view'],
  ['-R', 'acme/widgets', 'pr', 'comment', '7', '--body', 'y'],
  ['-R', 'acme/widgets', 'pr', 'view', '7'],
  ['pr', '--repo', 'acme/widgets', 'view', '7'],
  ['auth', 'login'],
  ['release', 'create', 'v1.0.0'],
  ['version', 'extra'],
  ['pr', 'comment', '7', '--body', '-h'],
]

describe('isKnownRead (CC-1644)', () => {
  it.each(reads.map(argv => [argv.join(' '), argv]))('runs %s without a ticket', (_, argv) => {
    expect(isKnownRead(argv)).toBe(true)
  })

  it.each(writes.map(argv => [argv.join(' '), argv]))('needs a ticket for %s', (_, argv) => {
    expect(isKnownRead(argv)).toBe(false)
  })
})

describe('the refusal log shape', () => {
  it('keeps the group and verb of a command, never its text', () => {
    expect(refusalShape(['pr', 'comment', '7', '--body', 'private words'])).toBe('pr comment')
  })

  it('keeps an api call to its method and route template', () => {
    expect(refusalShape(['api', '-X', 'PATCH', 'repos/acme/widgets/pulls/7', '-f', 'body=secret'])).toBe(
      'api PATCH repos/{o}/{r}/pulls/{n}',
    )
  })

  it('logs a head that is not a gh group, or a free-text word, as ?', () => {
    expect(refusalShape(['private words', 'x'])).toBe('?')
    expect(refusalShape(['pr', 'Private Words'])).toBe('pr ?')
    expect(refusalShape(['api', 'repos/acme/widgets/private words'])).toBe('api GET repos/{o}/{r}/?')
  })
})
