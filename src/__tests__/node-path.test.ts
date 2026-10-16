import { describe, expect, it } from 'vitest'
import { stableNodePath, type NodePathFs } from '../mirror/node-path.js'

/** A fake filesystem of symlinks: each key resolves to its value, and every key and value exists. */
const fakeFs = (links: Record<string, string>): NodePathFs => {
  const targets = new Set(Object.values(links))
  return {
    exists: p => p in links || targets.has(p),
    realpath: p => links[p] ?? p,
  }
}

const MAC_CELLAR = '/opt/homebrew/Cellar/node/25.1.0_1/bin/node'
const LINUX_CELLAR = '/home/example/.linuxbrew/Cellar/node/24.3.0/bin/node'

describe('stableNodePath', () => {
  it('maps a Homebrew Cellar node to its opt link when the link runs the same binary', () => {
    const ops = fakeFs({
      '/opt/homebrew/opt/node/bin/node': MAC_CELLAR,
      '/opt/homebrew/bin/node': MAC_CELLAR,
    })

    expect(stableNodePath(MAC_CELLAR, ops)).toBe('/opt/homebrew/opt/node/bin/node')
  })

  it('falls back to the prefix bin link when there is no opt link', () => {
    const ops = fakeFs({ '/opt/homebrew/bin/node': MAC_CELLAR })

    expect(stableNodePath(MAC_CELLAR, ops)).toBe('/opt/homebrew/bin/node')
  })

  it('maps a linuxbrew Cellar node the same way', () => {
    const ops = fakeFs({ '/home/example/.linuxbrew/opt/node/bin/node': LINUX_CELLAR })

    expect(stableNodePath(LINUX_CELLAR, ops)).toBe('/home/example/.linuxbrew/opt/node/bin/node')
  })

  it('keeps a versioned formula on its own opt link', () => {
    const cellar = '/opt/homebrew/Cellar/node@22/22.9.0/bin/node'
    const ops = fakeFs({ '/opt/homebrew/opt/node@22/bin/node': cellar, '/opt/homebrew/bin/node': MAC_CELLAR })

    expect(stableNodePath(cellar, ops)).toBe('/opt/homebrew/opt/node@22/bin/node')
  })

  it('skips a link that points at a different node version', () => {
    const ops = fakeFs({ '/opt/homebrew/opt/node/bin/node': '/opt/homebrew/Cellar/node/26.0.0/bin/node' })

    expect(stableNodePath(MAC_CELLAR, ops)).toBe(MAC_CELLAR)
  })

  it('returns a Cellar path unchanged when no stable link exists', () => {
    expect(stableNodePath(MAC_CELLAR, fakeFs({}))).toBe(MAC_CELLAR)
  })

  it('returns a non-Cellar path unchanged', () => {
    const ops = fakeFs({ '/usr/local/bin/node': '/usr/local/n/versions/node/22/bin/node' })

    expect(stableNodePath('/usr/local/bin/node', ops)).toBe('/usr/local/bin/node')
  })
})
