import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync }))

import { ghSearch } from '../digest/prs.js'

const sentArgs = (): string[] => spawnSync.mock.calls[0]![1] as string[]

describe('ghSearch argv', () => {
  beforeEach(() => {
    spawnSync.mockReset()
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })
  })

  it('sends the search as a GET query string with no method or field flags', () => {
    ghSearch('is:pr is:open')
    const args = sentArgs()
    expect(args[0]).toBe('api')
    expect(args[1]).toMatch(/^search\/issues\?q=/)
    expect(args).not.toContain('-X')
    expect(args).not.toContain('-f')
    expect(args).not.toContain('-F')
  })

  it('encodes spaces, quotes, colons, plus signs and at signs in the query', () => {
    ghSearch('is:pr "a b" a+b author:@me')
    const url = new URL(`https://x/${sentArgs()[1]}`)
    expect(url.searchParams.get('q')).toBe('is:pr "a b" a+b author:@me')
    const raw = sentArgs()[1]!
    expect(raw).not.toMatch(/[ "@]/)
    expect(raw).toContain('%22')
    expect(raw).toContain('%2B')
    expect(raw).toContain('%3A')
  })

  it('carries the page size in the query string', () => {
    ghSearch('x')
    expect(new URL(`https://x/${sentArgs()[1]}`).searchParams.get('per_page')).toBe('50')
  })
})
