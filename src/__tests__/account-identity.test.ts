import { describe, expect, it } from 'vitest'
import { accountGroups, accountIdentity, type ReadText } from '../agents/account-identity.js'

/**
 * CC-1289. The charter's `claude` and `personal` pools log in to one Anthropic account, so
 * pacing them separately doubles the account's budget. Identity comes from each config dir's
 * `oauthAccount`, never from the pool name, so any future alias pair is caught too.
 */

const HOME = '/home/example'

const login = (accountUuid: string, organizationUuid: string, emailAddress = 'a@example.com') =>
  JSON.stringify({ oauthAccount: { accountUuid, organizationUuid, emailAddress } })

const files =
  (contents: Record<string, string>): ReadText =>
  file =>
    contents[file]

const pools = (...entries: [string, string][]) => entries.map(([name, configDir]) => ({ name, configDir }))

const groupsOf = (contents: Record<string, string>, ...entries: [string, string][]) =>
  accountGroups(pools(...entries), dir => accountIdentity(dir, HOME, files(contents)))

describe('accountIdentity', () => {
  it('keys a login by account and organization, not by email', () => {
    const read = files({
      '/p/a/.claude.json': login('u1', 'o1', 'old@example.com'),
      '/p/b/.claude.json': login('u1', 'o1', 'new@example.com'),
    })

    expect(accountIdentity('/p/a', HOME, read)).toBe(accountIdentity('/p/b', HOME, read))
  })

  it('reads ~/.claude.json first for the default dir', () => {
    const read = files({
      [`${HOME}/.claude.json`]: login('home', 'o1'),
      [`${HOME}/.claude/.claude.json`]: login('inner', 'o1'),
    })

    expect(accountIdentity(`${HOME}/.claude`, HOME, read)).toBe('home/o1')
  })

  it('falls back to the default dir own file when ~/.claude.json names no login', () => {
    const read = files({ [`${HOME}/.claude/.claude.json`]: login('inner', 'o1') })

    expect(accountIdentity(`${HOME}/.claude`, HOME, read)).toBe('inner/o1')
  })

  it('never reads ~/.claude.json for a non-default dir', () => {
    const read = files({ [`${HOME}/.claude.json`]: login('home', 'o1') })

    expect(accountIdentity('/p/other', HOME, read)).toBeUndefined()
  })

  it.each([
    ['a missing file', undefined],
    ['bad JSON', '{not json'],
    ['no oauthAccount', JSON.stringify({ projects: {} })],
    ['no organization', JSON.stringify({ oauthAccount: { accountUuid: 'u1' } })],
  ])('gives no identity for %s', (_case, text) => {
    const read = files(text === undefined ? {} : { '/p/a/.claude.json': text })

    expect(accountIdentity('/p/a', HOME, read)).toBeUndefined()
  })
})

describe('accountGroups', () => {
  it('puts two config dirs on one account in one group keyed by the first pool in charter order', () => {
    const groups = groupsOf(
      {
        [`${HOME}/.claude.json`]: login('u1', 'o1', 'old@example.com'),
        '/p/personal/.claude.json': login('u1', 'o1', 'new@example.com'),
        '/p/agents/.claude.json': login('u2', 'o1'),
      },
      ['claude', `${HOME}/.claude`],
      ['agents', '/p/agents'],
      ['personal', '/p/personal'],
    )

    expect(groups.keyOf('personal')).toBe('claude')
    expect(groups.keyOf('claude')).toBe('claude')
    expect(groups.members('claude')).toEqual(['claude', 'personal'])
    expect(groups.shared).toEqual([['claude', 'personal']])
  })

  it('keeps two accounts as two groups', () => {
    const groups = groupsOf(
      { '/p/a/.claude.json': login('u1', 'o1'), '/p/b/.claude.json': login('u2', 'o1') },
      ['a', '/p/a'],
      ['b', '/p/b'],
    )

    expect([groups.keyOf('a'), groups.keyOf('b')]).toEqual(['a', 'b'])
    expect(groups.shared).toEqual([])
  })

  it('keeps one account in two organizations as two groups', () => {
    const groups = groupsOf(
      { '/p/a/.claude.json': login('u1', 'o1'), '/p/b/.claude.json': login('u1', 'o2') },
      ['a', '/p/a'],
      ['b', '/p/b'],
    )

    expect(groups.keyOf('b')).toBe('b')
  })

  it('keeps every pool without a readable login as its own account', () => {
    const groups = groupsOf({}, ['a', '/p/a'], ['b', '/p/b'])

    expect([groups.keyOf('a'), groups.keyOf('b')]).toEqual(['a', 'b'])
    expect(groups.members('b')).toEqual(['b'])
    expect(groups.shared).toEqual([])
  })

  it('regroups when a re-login changes a dir login', () => {
    const contents = { '/p/a/.claude.json': login('u1', 'o1'), '/p/b/.claude.json': login('u1', 'o1') }
    const before = groupsOf(contents, ['a', '/p/a'], ['b', '/p/b'])
    contents['/p/b/.claude.json'] = login('u9', 'o1')

    const after = groupsOf(contents, ['a', '/p/a'], ['b', '/p/b'])

    expect(before.keyOf('b')).toBe('a')
    expect(after.keyOf('b')).toBe('b')
  })

  it('answers a pool or key it never saw with itself', () => {
    const groups = groupsOf({}, ['a', '/p/a'])

    expect(groups.keyOf('ghost')).toBe('ghost')
    expect(groups.members('ghost')).toEqual(['ghost'])
  })
})
